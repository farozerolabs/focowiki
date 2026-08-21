import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("projection object lifecycle upgrade", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_projection_lifecycle_upgrade_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(withDatabase(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(withDatabase(connectionUrl, databaseName), { max: 2 });
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quote(databaseName)}`);
    databaseCreated = true;
    await sql.unsafe(await migration("001_storage_vnext.sql"));
    await sql.unsafe(await migration("002_document_queue_throughput.sql"));
    await sql.unsafe(await migration("003_document_projection_throughput.sql"));
    await seedFailures(sql);
    await sql.unsafe(await migration("004_projection_output_object_lifecycle.sql"));
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(databaseName)} WITH (FORCE)`);
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("reopens bounded projection and deleted-output activation failures", async () => {
    await expect(sql<Array<{
      public_id: string;
      state: string;
      attempt_count: number;
      safe_error_code: string | null;
      required_sequence: number | string;
    }>>`
      SELECT public_id, state, attempt_count, safe_error_code,
             required_sequence
      FROM focowiki.projection_dirty_scopes
      WHERE public_id IN ('invalid-scope', 'page-scope')
      ORDER BY public_id
    `).resolves.toEqual([{
      public_id: "invalid-scope",
      state: "waiting",
      attempt_count: 0,
      safe_error_code: null,
      required_sequence: "300"
    }, {
      public_id: "page-scope",
      state: "waiting",
      attempt_count: 0,
      safe_error_code: null,
      required_sequence: "3"
    }]);
    await expect(sql<Array<{
      public_id: string;
      state: string;
      required_sequence: number | string;
      acknowledged_at: Date | null;
    }>>`
      SELECT public_id, state, required_sequence, acknowledged_at
      FROM focowiki.projection_scope_contributions
      WHERE public_id IN (
        'invalid-contribution', 'invalid-page-contribution',
        'page-contribution'
      )
      ORDER BY public_id
    `).resolves.toEqual([{
      public_id: "invalid-contribution",
      state: "waiting",
      required_sequence: "300",
      acknowledged_at: null
    }, {
      public_id: "invalid-page-contribution",
      state: "waiting",
      required_sequence: "2",
      acknowledged_at: null
    }, {
      public_id: "page-contribution",
      state: "waiting",
      required_sequence: "3",
      acknowledged_at: null
    }]);
    await expect(sql`
      SELECT * FROM focowiki.projection_scope_receipts
      WHERE contribution_public_id IN (
        'invalid-contribution', 'invalid-page-contribution',
        'page-contribution'
      )
    `)
      .resolves.toEqual([]);
  });

  it("requeues only internal jobs and operations", async () => {
    await expect(sql<Array<{
      public_id: string;
      state: string;
      safe_error_code: string | null;
    }>>`
      SELECT public_id, state, safe_error_code
      FROM focowiki.document_processing_jobs
      WHERE public_id IN ('invalid-job', 'page-job')
      ORDER BY public_id
    `).resolves.toEqual([{
      public_id: "invalid-job",
      state: "waiting",
      safe_error_code: null
    }, {
      public_id: "page-job",
      state: "waiting",
      safe_error_code: null
    }]);
    await expect(sql<Array<{ public_id: string; state: string }>>`
      SELECT public_id, state FROM focowiki.operations
      WHERE public_id IN ('invalid-operation', 'page-operation')
      ORDER BY public_id
    `).resolves.toEqual([{
      public_id: "invalid-operation",
      state: "processing"
    }, {
      public_id: "page-operation",
      state: "processing"
    }]);
    await expect(sql<Array<{ generation: string }>>`
      SELECT generation FROM focowiki.runtime_generation WHERE singleton = true
    `).resolves.toEqual([{
      generation: "storage-vnext-v12-projection-object-lifecycle"
    }]);
  });

  it("releases historical terminal outputs without pinning their objects", async () => {
    await expect(sql<Array<{ count: number | string }>>`
      SELECT count(*) AS count FROM focowiki.projection_scope_outputs
      WHERE scope_public_id = 'terminal-scope'
    `).resolves.toEqual([{ count: "0" }]);
    await expect(sql<Array<{ state: string }>>`
      SELECT state FROM focowiki.cleanup_actions
      WHERE resource_public_id = 'terminal-output-object'
    `).resolves.toEqual([{ state: "queued" }]);
  });

  it("preserves valid exact outputs consumed by repaired jobs", async () => {
    await expect(sql<Array<{
      output_count: number | string;
      reference_count: number | string;
      receipt_count: number | string;
    }>>`
      SELECT
        (SELECT count(*) FROM focowiki.projection_scope_outputs
         WHERE scope_public_id = 'valid-scope') AS output_count,
        (SELECT count(*) FROM focowiki.projection_scope_object_refs
         WHERE object_id = 'valid-output-object') AS reference_count,
        (SELECT count(*) FROM focowiki.projection_scope_receipts
         WHERE contribution_public_id = 'valid-contribution') AS receipt_count
    `).resolves.toEqual([{
      output_count: "1",
      reference_count: "1",
      receipt_count: "1"
    }]);
  });
});

async function seedFailures(sql: postgres.Sql): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction`SET LOCAL session_replication_role = replica`;
    await transaction`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('repair-kb', 'Repair', 1)
    `;
    await transaction`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        target_kind, target_public_id, completed_at
      ) VALUES
        ('invalid-operation', 'repair-kb', 'source_upload', 'failed',
         'source_file', 'invalid-source', now()),
        ('page-operation', 'repair-kb', 'source_upload', 'failed',
         'source_file', 'page-source', now()),
        ('terminal-operation', 'repair-kb', 'source_upload', 'completed',
         'source_file', 'terminal-source', now())
    `;
    await transaction`
      INSERT INTO focowiki.document_processing_jobs (
        public_id, knowledge_base_id, operation_public_id,
        source_file_public_id, source_revision_public_id,
        runtime_settings_revision_public_id,
        generation_model_configuration_public_id,
        generation_model_configuration_revision,
        embedding_configuration_revision_public_id,
        semantic_generation_public_id, semantic_contract_version,
        state, attempt_count, failure_count, total_attempt_count,
        maximum_attempts, blocking_work_kind, safe_error_code, retryable,
        accepted_at, started_at, terminal_at, created_at, updated_at
      ) VALUES
        ('invalid-job', 'repair-kb', 'invalid-operation', 'invalid-source',
         'invalid-revision', 'settings', 'model', 1, 'embedding', 'semantic',
         'contract', 'error', 3, 3, 3, 3, 'knowledge_projection',
         'invalid_input', true, now(), now(), now(), now(), now()),
        ('page-job', 'repair-kb', 'page-operation', 'page-source',
         'page-revision', 'settings', 'model', 1, 'embedding', 'semantic',
         'contract', 'error', 3, 3, 3, 3, 'activate',
         'page_object_unverified', true, now(), now(), now(), now(), now()),
        ('terminal-job', 'repair-kb', 'terminal-operation', 'terminal-source',
         'terminal-revision', 'settings', 'model', 1, 'embedding', 'semantic',
         'contract', 'available', 0, 0, 0, 3, NULL,
         NULL, false, now(), now(), now(), now(), now())
    `;
    await transaction`
      INSERT INTO focowiki.document_artifact_work (
        public_id, knowledge_base_id, document_job_public_id,
        source_file_public_id, source_revision_public_id,
        work_kind, resource_lane, input_fingerprint_sha256,
        state, attempt_count, maximum_attempts, next_eligible_at,
        safe_error_code, retryable, ended_at
      ) VALUES
        ('invalid-projection-work', 'repair-kb', 'invalid-job',
         'invalid-source', 'invalid-revision', 'knowledge_projection',
         'projection', ${"1".repeat(64)}, 'error', 3, 3, now(),
         'invalid_input', true, now()),
        ('page-projection-work', 'repair-kb', 'page-job',
         'page-source', 'page-revision', 'knowledge_projection',
         'projection', ${"2".repeat(64)}, 'completed', 1, 3, now(),
         NULL, false, now()),
        ('page-activate-work', 'repair-kb', 'page-job',
         'page-source', 'page-revision', 'activate', 'activation',
         ${"3".repeat(64)}, 'error', 3, 3, now(),
         'page_object_unverified', true, now())
    `;
    await transaction`
      INSERT INTO focowiki.projection_dirty_scopes (
        public_id, knowledge_base_id, scope_kind, scope_key,
        required_sequence, completed_sequence, state, next_eligible_at,
        coalesce_until, attempt_count, maximum_attempts, safe_error_code,
        retryable, waiting_contribution_count,
        oldest_waiting_contribution_at
      ) VALUES
        ('invalid-scope', 'repair-kb', '_index', 'term:han', 300, 100,
         'error', now(), now(), 10, 10, 'invalid_input', true, 1, now()),
        ('page-scope', 'repair-kb', 'root', 'root', 1, 1,
         'completed', now(), now(), 0, 10, NULL, false, 0, NULL),
        ('valid-scope', 'repair-kb', 'directory', 'valid', 1, 1,
         'completed', now(), now(), 0, 10, NULL, false, 0, NULL),
        ('terminal-scope', 'repair-kb', 'directory', 'terminal', 1, 1,
         'completed', now(), now(), 0, 10, NULL, false, 0, NULL)
    `;
    await transaction`
      INSERT INTO focowiki.projection_scope_contributions (
        public_id, knowledge_base_id, source_file_public_id,
        source_revision_public_id, document_job_public_id,
        scope_public_id, required_sequence, state, acknowledged_at
      ) VALUES
        ('invalid-contribution', 'repair-kb', 'invalid-source',
         'invalid-revision', 'invalid-job', 'invalid-scope', 300,
         'waiting', NULL),
        ('invalid-page-contribution', 'repair-kb', 'invalid-source',
         'invalid-revision', 'invalid-job', 'page-scope', 1,
         'acknowledged', now()),
        ('valid-contribution', 'repair-kb', 'invalid-source',
         'invalid-revision', 'invalid-job', 'valid-scope', 1,
         'acknowledged', now()),
        ('page-contribution', 'repair-kb', 'page-source',
         'page-revision', 'page-job', 'page-scope', 1,
         'acknowledged', now()),
        ('terminal-contribution', 'repair-kb', 'terminal-source',
         'terminal-revision', 'terminal-job', 'terminal-scope', 1,
         'acknowledged', now())
    `;
    await transaction`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        'deleted-page-object', 'generated/deleted.md', ${"4".repeat(64)}, 32,
        'text/markdown; charset=utf-8', 'okf-generated-markdown-v1',
        'deleted', 'deleted-write', now()
      ), (
        'valid-output-object', 'generated/valid.md', ${"8".repeat(64)}, 32,
        'text/markdown; charset=utf-8', 'okf-generated-markdown-v1',
        'verified', 'valid-write', now()
      ), (
        'terminal-output-object', 'generated/terminal.md', ${"6".repeat(64)}, 32,
        'text/markdown; charset=utf-8', 'okf-generated-markdown-v1',
        'verified', 'terminal-write', now()
      )
    `;
    await transaction`
      INSERT INTO focowiki.projection_scope_outputs (
        scope_public_id, rendered_sequence, knowledge_base_id,
        output_fingerprint_sha256, pages, removed_normalized_paths,
        navigation_mutations, activation_owner_versions
      ) VALUES (
        'page-scope', 1, 'repair-kb', ${"5".repeat(64)},
        ${transaction.json([{
          logicalPath: "index.md",
          normalizedPath: "index.md",
          entryKind: "root-index",
          sourceFilePublicId: null,
          sourceRevisionPublicId: null,
          objectId: "deleted-page-object",
          checksumSha256: "4".repeat(64),
          byteCount: 32
        }] as never)}, ARRAY[]::text[], '[]'::jsonb, '[]'::jsonb
      ), (
        'valid-scope', 1, 'repair-kb', ${"9".repeat(64)},
        ${transaction.json([{
          logicalPath: "valid.md",
          normalizedPath: "valid.md",
          entryKind: "directory-index",
          sourceFilePublicId: null,
          sourceRevisionPublicId: null,
          objectId: "valid-output-object",
          checksumSha256: "8".repeat(64),
          byteCount: 32
        }] as never)}, ARRAY[]::text[], '[]'::jsonb, '[]'::jsonb
      ), (
        'terminal-scope', 1, 'repair-kb', ${"7".repeat(64)},
        ${transaction.json([{
          logicalPath: "terminal.md",
          normalizedPath: "terminal.md",
          entryKind: "directory-index",
          sourceFilePublicId: null,
          sourceRevisionPublicId: null,
          objectId: "terminal-output-object",
          checksumSha256: "6".repeat(64),
          byteCount: 32
        }] as never)}, ARRAY[]::text[], '[]'::jsonb, '[]'::jsonb
      )
    `;
    await transaction`
      INSERT INTO focowiki.projection_scope_receipts (
        contribution_public_id, scope_public_id, rendered_sequence,
        output_fingerprint_sha256
      ) VALUES (
        'invalid-page-contribution', 'page-scope', 1, ${"5".repeat(64)}
      ), (
        'page-contribution', 'page-scope', 1, ${"5".repeat(64)}
      ), (
        'valid-contribution', 'valid-scope', 1, ${"9".repeat(64)}
      ), (
        'terminal-contribution', 'terminal-scope', 1, ${"7".repeat(64)}
      )
    `;
  });
}

function migration(fileName: string): Promise<string> {
  return readFile(resolve(import.meta.dirname, "../migrations", fileName), "utf8");
}

function withDatabase(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
