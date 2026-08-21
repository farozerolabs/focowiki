import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(
  databaseUrl && runOwner && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);

(enabled ? describe : describe.skip)("document projection throughput upgrade", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_projection_upgrade_${
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
    await seedLegacyScopes(sql);
    await sql.unsafe(await migration("003_document_projection_throughput.sql"));
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(databaseName)} WITH (FORCE)`);
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("removes legacy receipt-only gates without touching material gates", async () => {
    await expect(sql<Array<{ scope_kind: string; count: number | string }>>`
      SELECT scope.scope_kind, count(*) AS count
      FROM focowiki.projection_scope_contributions contribution
      JOIN focowiki.projection_dirty_scopes scope
        ON scope.public_id = contribution.scope_public_id
      WHERE contribution.state = 'waiting'
      GROUP BY scope.scope_kind
      ORDER BY scope.scope_kind
    `).resolves.toEqual([{ scope_kind: "source", count: "1" }]);
    await expect(sql<Array<{
      public_id: string;
      state: string;
      waiting_contribution_count: number;
      oldest_waiting_contribution_at: Date | null;
    }>>`
      SELECT public_id, state, waiting_contribution_count,
             oldest_waiting_contribution_at
      FROM focowiki.projection_dirty_scopes
      ORDER BY public_id
    `).resolves.toEqual([
      {
        public_id: "legacy-graph-scope",
        state: "running",
        waiting_contribution_count: 0,
        oldest_waiting_contribution_at: null
      },
      {
        public_id: "legacy-relation-scope",
        state: "completed",
        waiting_contribution_count: 0,
        oldest_waiting_contribution_at: null
      },
      {
        public_id: "material-source-scope",
        state: "waiting",
        waiting_contribution_count: 1,
        oldest_waiting_contribution_at: expect.any(Date)
      }
    ]);
  });

  it("requeues fixed internal failures and preserves provider failures", async () => {
    await expect(sql<Array<{
      public_id: string;
      state: string;
      safe_error_code: string | null;
      attempt_count: number | string;
    }>>`
      SELECT public_id, state, safe_error_code, attempt_count
      FROM focowiki.document_processing_jobs
      WHERE public_id IN ('fixed-error-job', 'provider-error-job')
      ORDER BY public_id
    `).resolves.toEqual([{
      public_id: "fixed-error-job",
      state: "waiting",
      safe_error_code: null,
      attempt_count: 0
    }, {
      public_id: "provider-error-job",
      state: "error",
      safe_error_code: "provider_request_rejected",
      attempt_count: 3
    }]);
    await expect(sql<Array<{
      document_job_public_id: string;
      state: string;
      safe_error_code: string | null;
      attempt_count: number | string;
    }>>`
      SELECT document_job_public_id, state, safe_error_code, attempt_count
      FROM focowiki.document_artifact_work
      WHERE document_job_public_id IN ('fixed-error-job', 'provider-error-job')
      ORDER BY document_job_public_id
    `).resolves.toEqual([{
      document_job_public_id: "fixed-error-job",
      state: "waiting",
      safe_error_code: null,
      attempt_count: 0
    }, {
      document_job_public_id: "provider-error-job",
      state: "error",
      safe_error_code: "provider_request_rejected",
      attempt_count: 3
    }]);
  });
});

async function seedLegacyScopes(sql: postgres.Sql): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction`SET LOCAL session_replication_role = replica`;
    await transaction`
      INSERT INTO focowiki.projection_dirty_scopes (
        public_id, knowledge_base_id, scope_kind, scope_key,
        required_sequence, completed_sequence, state, next_eligible_at,
        coalesce_until, lease_owner, lease_expires_at
      ) VALUES
        ('legacy-relation-scope', 'upgrade-kb', 'relation', 'relation-1',
         5, 2, 'waiting', now(), now(), NULL, NULL),
        ('legacy-graph-scope', 'upgrade-kb', 'graph', 'source-1',
         5, 2, 'running', now(), now(), 'legacy-worker',
         now() + interval '5 minutes'),
        ('material-source-scope', 'upgrade-kb', 'source', 'source-1',
         5, 2, 'waiting', now(), now(), NULL, NULL)
    `;
    await transaction`
      INSERT INTO focowiki.projection_scope_contributions (
        public_id, knowledge_base_id, source_file_public_id,
        source_revision_public_id, document_job_public_id,
        scope_public_id, required_sequence, state
      ) VALUES
        ('legacy-relation-contribution', 'upgrade-kb', 'source-1',
         'revision-1', 'job-1', 'legacy-relation-scope', 5, 'waiting'),
        ('legacy-graph-contribution', 'upgrade-kb', 'source-1',
         'revision-1', 'job-1', 'legacy-graph-scope', 5, 'waiting'),
        ('material-source-contribution', 'upgrade-kb', 'source-1',
         'revision-1', 'job-1', 'material-source-scope', 5, 'waiting')
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
        maximum_attempts,
        blocking_work_kind, safe_error_code, retryable,
        accepted_at, started_at, terminal_at, created_at
      ) VALUES
        ('fixed-error-job', 'upgrade-kb', 'fixed-operation',
         'fixed-source', 'fixed-revision', 'settings', 'model', 1,
         'embedding', 'semantic', 'contract', 'error', 3, 3, 3, 3,
         'activate', 'projection_scope_output_limit_exceeded', true,
         now() - interval '1 hour', now() - interval '30 minutes', now(),
         now() - interval '1 hour'),
        ('provider-error-job', 'upgrade-kb', 'provider-operation',
         'provider-source', 'provider-revision', 'settings', 'model', 1,
         'embedding', 'semantic', 'contract', 'error', 3, 3, 3, 3,
         'relation_reconcile', 'provider_request_rejected', true,
         now() - interval '1 hour', now() - interval '30 minutes', now(),
         now() - interval '1 hour')
    `;
    await transaction`
      INSERT INTO focowiki.document_artifact_work (
        public_id, knowledge_base_id, document_job_public_id,
        source_file_public_id, source_revision_public_id,
        work_kind, resource_lane, input_fingerprint_sha256,
        state, attempt_count, maximum_attempts, next_eligible_at,
        safe_error_code, retryable, ended_at
      ) VALUES
        ('fixed-error-work', 'upgrade-kb', 'fixed-error-job',
         'fixed-source', 'fixed-revision', 'activate', 'activation',
         ${"a".repeat(64)}, 'error', 3, 3, now(),
         'projection_scope_output_limit_exceeded', true, now()),
        ('provider-error-work', 'upgrade-kb', 'provider-error-job',
         'provider-source', 'provider-revision', 'relation_reconcile',
         'coordination', ${"b".repeat(64)}, 'error', 3, 3, now(),
         'provider_request_rejected', true, now())
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
