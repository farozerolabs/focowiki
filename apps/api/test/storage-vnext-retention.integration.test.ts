import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createRuntimeLogger, type RuntimeLogSink } from "../src/logger.js";
import {
  ensureStorageVnextTimePartitions
} from "../src/storage-vnext/retention/postgres-partitions.js";
import {
  runStorageVnextRetentionSlice
} from "../src/storage-vnext/retention/postgres-retention.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(
  databaseUrl
  && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedDatabase = hasOwnedTarget ? describe : describe.skip;

describeOwnedDatabase("storage vNext result and audit retention", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const ownerToken = (runOwner ?? "invalid").replaceAll("-", "_");
  const databaseName = "focowiki_vnext_retention_" + ownerToken + "_"
    + randomUUID().replaceAll("-", "").slice(0, 10);
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 3 });
  const database = sql as unknown as DatabaseClient;
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe("CREATE DATABASE " + quoteIdentifier(databaseName));
    databaseCreated = true;
    await sql.unsafe(readFileSync(
      resolve(import.meta.dirname, "../migrations/001_storage_vnext.sql"),
      "utf8"
    ));
    await ensureStorageVnextTimePartitions(database, new Date("2026-06-15T00:00:00Z"));
    await seedRetentionRows(sql);
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(
        "DROP DATABASE IF EXISTS " + quoteIdentifier(databaseName) + " WITH (FORCE)"
      );
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("prunes expired results and audit without touching live work, business state, or logs", async () => {
    const logDirectory = mkdtempSync(join(tmpdir(), "focowiki-vnext-retention-log-"));
    try {
      const logger = createRuntimeLogger({
        logging: {
          level: "info",
          file: {
            directory: logDirectory,
            maxBytes: 512,
            maxFiles: 2,
            maxTotalBytes: 1_024,
            retentionDays: 1
          }
        }
      }, silentSink());
      logger.info("retention.validation_started", { sequence: 1 });
      expect(existsSync(join(logDirectory, "focowiki-runtime.log"))).toBe(true);
      rmSync(logDirectory, { recursive: true, force: true });

      const result = await runStorageVnextRetentionSlice(database, {
        now: new Date("2026-08-01T12:00:00Z"),
        batchSize: 100,
        securityAuditRetentionDays: 30
      });

      expect(result.operationResults.deletedRows).toBe(1);
      expect(result.sourceEventSummaries.deletedRows).toBe(1);
      expect(result.securityAudit.droppedPartitions).toEqual([
        "security_audit_events_2026_06"
      ]);
      const rows = await sql.unsafe<Array<{
        operations: string;
        live_work: string;
        results: string[];
        audits: string[];
        diagnostics: string[];
        source_events: string[];
      }>>(
        "SELECT "
        + "(SELECT count(*)::text FROM focowiki.operations) AS operations, "
        + "(SELECT count(*)::text FROM focowiki.operation_work_items) AS live_work, "
        + "ARRAY(SELECT public_id FROM focowiki.operation_results ORDER BY public_id) AS results, "
        + "ARRAY(SELECT public_id FROM focowiki.security_audit_events ORDER BY public_id) AS audits, "
        + "ARRAY(SELECT public_id FROM focowiki.diagnostic_events ORDER BY public_id) AS diagnostics, "
        + "ARRAY(SELECT public_id FROM focowiki.source_event_summaries ORDER BY public_id) AS source_events"
      );
      expect(rows[0]).toEqual({
        operations: "4",
        live_work: "1",
        results: ["operation-current", "operation-replay"],
        audits: ["audit-current"],
        diagnostics: ["diagnostic-old"],
        source_events: ["source-event-current"]
      });
      expect(existsSync(logDirectory)).toBe(false);
    } finally {
      rmSync(logDirectory, { recursive: true, force: true });
    }
  });
});

async function seedRetentionRows(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql.unsafe(
    "INSERT INTO focowiki.knowledge_bases (public_id, name, revision) "
    + "VALUES ('kb-retention', 'Retention knowledge base', 1)"
  );
  await sql.unsafe(
    "INSERT INTO focowiki.runtime_setting_revisions "
    + "(public_id, checksum_sha256, settings_values) VALUES "
    + "('settings-retention', '" + "a".repeat(64) + "', '{}'::jsonb)"
  );
  await sql.unsafe(
    "INSERT INTO focowiki.source_files "
    + "(public_id, knowledge_base_id, logical_path, normalized_path, title, "
    + "metadata, status, revision) VALUES "
    + "('source-retention', 'kb-retention', 'Retention.md', 'retention.md', "
    + "'Retention', '{}'::jsonb, 'pending', 1)"
  );
  await sql.unsafe(
    "INSERT INTO focowiki.source_event_summaries "
    + "(public_id, knowledge_base_id, source_file_public_id, "
    + "source_revision_public_id, sequence_number, stage_key, message_key, "
    + "started_at, severity, created_at, expires_at) VALUES "
    + "('source-event-expired', 'kb-retention', 'source-retention', "
    + "'revision-retention', 10, 'upload_storage', 'sourceFiles.phase.uploadStorage', "
    + "'2026-06-01T00:00:00Z', 'info', '2026-06-01T00:00:00Z', "
    + "'2026-06-02T00:00:00Z'), "
    + "('source-event-current', 'kb-retention', 'source-retention', "
    + "'revision-retention', 20, 'metadata_resolution', "
    + "'sourceFiles.phase.metadataResolution', '2026-08-01T06:00:00Z', "
    + "'info', '2026-08-01T06:00:00Z', '2026-08-31T06:00:00Z')"
  );
  await sql.unsafe(
    "INSERT INTO focowiki.operations "
    + "(public_id, knowledge_base_id, operation_kind, state, completed_at) VALUES "
    + "('operation-expired', 'kb-retention', 'source', 'completed', "
    + "'2026-06-01T00:00:00Z'), "
    + "('operation-current', 'kb-retention', 'source', 'completed', "
    + "'2026-08-01T06:00:00Z'), "
    + "('operation-replay', 'kb-retention', 'source', 'completed', "
    + "'2026-06-01T00:00:00Z'), "
    + "('operation-live', 'kb-retention', 'source', 'accepted', NULL)"
  );
  await sql.unsafe(
    "INSERT INTO focowiki.operation_idempotency "
    + "(public_id, knowledge_base_id, idempotency_key, request_hash, "
    + "operation_public_id, expires_at, created_at) VALUES "
    + "('replay-current', 'kb-retention', 'request-replay', '"
    + "b".repeat(64)
    + "', 'operation-replay', '2026-08-02T00:00:00Z', '2026-06-01T00:00:00Z')"
  );
  await sql.unsafe(
    "INSERT INTO focowiki.operation_work_items "
    + "(operation_public_id, knowledge_base_id, work_kind, state, "
    + "operation_revision, settings_revision_public_id, attempt_count, checkpoint) VALUES "
    + "('operation-live', 'kb-retention', 'source', 'queued', 1, "
    + "'settings-retention', 0, '{\"stage\":\"queued\"}'::jsonb)"
  );
  await sql.unsafe(
    "INSERT INTO focowiki.operation_results "
    + "(public_id, knowledge_base_id, operation_kind, terminal_state, "
    + "result_code, result_summary, completed_at, expires_at) VALUES "
    + "('operation-expired', 'kb-retention', 'source', 'completed', 'OK', "
    + "'{}'::jsonb, '2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z'), "
    + "('operation-current', 'kb-retention', 'source', 'completed', 'OK', "
    + "'{}'::jsonb, '2026-08-01T06:00:00Z', '2026-08-02T06:00:00Z'), "
    + "('operation-replay', 'kb-retention', 'source', 'completed', 'OK', "
    + "'{}'::jsonb, '2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z')"
  );
  await sql.unsafe(
    "INSERT INTO focowiki.security_audit_events "
    + "(public_id, knowledge_base_id, event_type, result, created_at, expires_at) VALUES "
    + "('audit-old', 'kb-retention', 'session.login', 'success', "
    + "'2026-06-15T00:00:00Z', '2026-06-16T00:00:00Z'), "
    + "('audit-current', 'kb-retention', 'session.login', 'success', "
    + "'2026-08-01T06:00:00Z', '2026-08-31T06:00:00Z')"
  );
  await sql.unsafe(
    "INSERT INTO focowiki.diagnostic_events "
    + "(public_id, knowledge_base_id, stage, severity, event_code, created_at, expires_at) VALUES "
    + "('diagnostic-old', 'kb-retention', 'source', 'info', 'source.completed', "
    + "'2026-06-15T00:00:00Z', '2026-06-16T00:00:00Z')"
  );
}

function silentSink(): RuntimeLogSink {
  return {
    error() {},
    warn() {},
    info() {},
    debug() {}
  };
}

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = "/" + databaseName;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return "\"" + value.replaceAll("\"", "\"\"") + "\"";
}
