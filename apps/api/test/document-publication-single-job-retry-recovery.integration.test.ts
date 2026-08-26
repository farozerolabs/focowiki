import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATION_FILES, readMigrationSql } from "../src/db/migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));
const RECOVERY_MIGRATION =
  "015_single_job_publication_retry_recovery.sql";
const recoveryIndex = MIGRATION_FILES.indexOf(RECOVERY_MIGRATION);

(enabled ? describe : describe.skip)("single-job retry recovery migration", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_single_retry_recovery_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(withDatabase(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(withDatabase(connectionUrl, databaseName), { max: 2 });
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quote(databaseName)}`);
    databaseCreated = true;
    for (const file of MIGRATION_FILES.slice(0, recoveryIndex)) {
      await sql.unsafe(readMigrationSql(file));
    }
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('retry-recovery-kb', 'Retry recovery', 1)
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_publication_heads (
        knowledge_base_id, latest_readiness_sequence,
        pending_item_count, oldest_pending_at, latest_pending_at
      ) VALUES (
        'retry-recovery-kb', 1, 1,
        '2026-08-26T05:55:00.000Z', '2026-08-26T05:55:00.000Z'
      ) ON CONFLICT (knowledge_base_id) DO UPDATE
        SET latest_readiness_sequence = 1,
            pending_item_count = 1,
            oldest_pending_at = '2026-08-26T05:55:00.000Z',
            latest_pending_at = '2026-08-26T05:55:00.000Z'
    `;
    await sql`
      INSERT INTO focowiki.publication_jobs (
        public_id, knowledge_base_id, base_active_revision,
        target_readiness_sequence, renderer_contract_version,
        outcome, attempt_owner, attempt_token,
        attempt_started_at, attempt_deadline, attempt_count,
        manifest_fingerprint_sha256, manifest_attempt_token,
        next_eligible_at, safe_error_code, created_at, updated_at
      ) VALUES (
        'retry-recovery-job', 'retry-recovery-kb', 0, 1,
        'portable-okf-v2', 'pending', 'stopped-worker',
        'retry-recovery-token', '2026-08-26T05:55:00.000Z',
        '2026-08-26T06:25:00.000Z', 3, ${"a".repeat(64)},
        'retry-recovery-token', '2026-08-26T05:55:00.000Z',
        'DOCUMENT_PROCESSING_FAILED',
        '2026-08-26T05:55:00.000Z', '2026-08-26T05:55:00.000Z'
      )
    `;
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(
        `DROP DATABASE IF EXISTS ${quote(databaseName)} WITH (FORCE)`
      );
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("makes the stopped attempt immediately eligible without changing facts",
    async () => {
      await sql.unsafe(readMigrationSql(RECOVERY_MIGRATION));

      await expect(sql<Array<{
        outcome: string;
        attempt_owner: string | null;
        attempt_token: string | null;
        attempt_deadline: Date | string | null;
        attempt_count: number | string;
        manifest_fingerprint_sha256: string | null;
        next_eligible: boolean;
        safe_error_code: string | null;
      }>>`
        SELECT outcome, attempt_owner, attempt_token, attempt_deadline,
               attempt_count, manifest_fingerprint_sha256,
               next_eligible_at <= now() AS next_eligible, safe_error_code
        FROM focowiki.publication_jobs
        WHERE public_id = 'retry-recovery-job'
      `).resolves.toEqual([{
        outcome: "pending",
        attempt_owner: null,
        attempt_token: null,
        attempt_deadline: null,
        attempt_count: 0,
        manifest_fingerprint_sha256: null,
        next_eligible: true,
        safe_error_code: null
      }]);
      await expect(sql<Array<{ generation: string }>>`
        SELECT generation FROM focowiki.runtime_generation
        WHERE singleton = true
      `).resolves.toEqual([{
        generation: "storage-vnext-v23-single-job-publication-retry-recovery"
      }]);
      await expect(sql<Array<{ pending_item_count: number | string }>>`
        SELECT pending_item_count
        FROM focowiki.knowledge_base_publication_heads
        WHERE knowledge_base_id = 'retry-recovery-kb'
      `).resolves.toEqual([{ pending_item_count: 1 }]);
    });
});

function withDatabase(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
