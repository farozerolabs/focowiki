import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATION_FILES, readMigrationSql } from "../src/db/migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));
const RECOVERY_MIGRATION =
  "019_publication_window_cleanup_recovery.sql";
const migrationIndex = MIGRATION_FILES.indexOf(RECOVERY_MIGRATION);

(enabled ? describe : describe.skip)(
  "publication window and cleanup recovery migration",
  () => {
    const connectionUrl = databaseUrl
      ?? "postgres://unused:unused@127.0.0.1:5432/unused";
    const databaseName = `focowiki_window_cleanup_${
      (runOwner ?? "invalid").replaceAll("-", "_")
    }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const admin = postgres(withDatabase(connectionUrl, "postgres"), { max: 1 });
    const sql = postgres(withDatabase(connectionUrl, databaseName), { max: 2 });
    let databaseCreated = false;

    beforeAll(async () => {
      await admin.unsafe(`CREATE DATABASE ${quote(databaseName)}`);
      databaseCreated = true;
      for (const file of MIGRATION_FILES.slice(0, migrationIndex)) {
        await sql.unsafe(readMigrationSql(file));
      }
      await sql`
        INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
        VALUES ('cleanup-recovery-kb', 'Cleanup recovery', 1)
      `;
      await sql`
        INSERT INTO focowiki.object_registrations (
          object_id, storage_key, checksum_sha256, byte_count,
          content_type, object_format, state, write_attempt_public_id,
          verified_at, zero_owner_since, created_at
        ) VALUES (
          'generated-sha256:cleanup-recovery',
          'generated/cleanup-recovery.json', ${"a".repeat(64)}, 16,
          'application/json; charset=utf-8', 'okf-generated-json-v1',
          'deleting', 'cleanup-recovery-write', now(), now(), now()
        ), (
          'generated-sha256:cleanup-delayed',
          'generated/cleanup-delayed.json', ${"b".repeat(64)}, 18,
          'application/json; charset=utf-8', 'okf-generated-json-v1',
          'verified', 'cleanup-delayed-write', now(), now(), now()
        )
      `;
      await sql`
        INSERT INTO focowiki.cleanup_actions (
          public_id, knowledge_base_id, action_kind, cleanup_plane,
          resource_kind, resource_public_id, required, priority,
          sequence_number, idempotency_key, request_hash, checkpoint,
          state, attempt_count, maximum_attempts, not_before,
          created_at, updated_at
        ) VALUES (
          'cleanup-recovery-action', 'cleanup-recovery-kb',
          'zero_owner_object', 'object_storage', 'zero_owner_object',
          'generated-sha256:cleanup-recovery', true, 40, 1,
          'publication-job-output:cleanup-recovery',
          'cleanup-recovery-request',
          jsonb_build_object(
            'schemaVersion', 'publication-job-output-v1'
          ),
          'running', 1, 8, now(), now(), now()
        ), (
          'cleanup-delayed-action', 'cleanup-recovery-kb',
          'zero_owner_object', 'object_storage', 'zero_owner_object',
          'generated-sha256:cleanup-delayed', true, 40, 2,
          'publication-job-output:cleanup-delayed',
          'cleanup-delayed-request',
          jsonb_build_object(
            'schemaVersion', 'publication-job-output-v1'
          ),
          'queued', 0, 8, now(), now(), now()
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

    it("cancels legacy immediate cleanup and advances the generation",
      async () => {
        await sql.unsafe(readMigrationSql(RECOVERY_MIGRATION));

        await expect(sql<Array<{
          state: string;
          lease_owner: string | null;
          completed_at: Date | null;
        }>>`
          SELECT state, lease_owner, completed_at
          FROM focowiki.cleanup_actions
          WHERE public_id = 'cleanup-recovery-action'
        `).resolves.toEqual([{
          state: "completed",
          lease_owner: null,
          completed_at: expect.any(Date)
        }]);
        await expect(sql<Array<{ generation: string }>>`
          SELECT generation FROM focowiki.runtime_generation
          WHERE singleton = true
        `).resolves.toEqual([{
          generation: "storage-vnext-v27-publication-window-cleanup-recovery"
        }]);
        await expect(sql<Array<{ state: string }>>`
          SELECT state FROM focowiki.object_registrations
          WHERE object_id = 'generated-sha256:cleanup-recovery'
        `).resolves.toEqual([{ state: "deleting" }]);
        await expect(sql<Array<{
          state: string;
          schema_version: string;
          ready: boolean;
        }>>`
          SELECT state, checkpoint ->> 'schemaVersion' AS schema_version,
                 not_before <= now() AS ready
          FROM focowiki.cleanup_actions
          WHERE resource_public_id = 'generated-sha256:cleanup-recovery'
            AND checkpoint ->> 'schemaVersion' = 'publication-job-output-v2'
        `).resolves.toEqual([{
          state: "queued",
          schema_version: "publication-job-output-v2",
          ready: true
        }]);
        await expect(sql<Array<{
          state: string;
          schema_version: string;
          delayed: boolean;
        }>>`
          SELECT state, checkpoint ->> 'schemaVersion' AS schema_version,
                 not_before >= now() + interval '23 hours' AS delayed
          FROM focowiki.cleanup_actions
          WHERE resource_public_id = 'generated-sha256:cleanup-delayed'
            AND checkpoint ->> 'schemaVersion' = 'publication-job-output-v2'
        `).resolves.toEqual([{
          state: "queued",
          schema_version: "publication-job-output-v2",
          delayed: true
        }]);
      });
  }
);

function withDatabase(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = "/" + databaseName;
  return url.toString();
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
