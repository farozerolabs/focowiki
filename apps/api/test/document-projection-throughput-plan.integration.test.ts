import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";
import type { DatabaseClient } from "../src/db/client.js";
import { createPostgresDocumentArtifactWorkRepository } from
  "../src/document-indexing/infrastructure/postgres-document-artifact-work-repository.js";
import { createPostgresProjectionDirtyScopeRepository } from
  "../src/document-indexing/infrastructure/postgres-projection-dirty-scope-repository.js";
import { createPostgresProjectionScopeContributions } from
  "../src/document-indexing/infrastructure/postgres-projection-scope-contributions.js";
import { createPostgresProjectionScopeCompletion } from
  "../src/document-indexing/infrastructure/postgres-projection-scope-completion.js";
import { createPostgresProjectionScopeOutputRepository } from
  "../src/document-indexing/infrastructure/postgres-projection-scope-output-repository.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(
  databaseUrl && runOwner && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);

(enabled ? describe : describe.skip)("document projection throughput plans", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_projection_plan_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(withDatabase(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(withDatabase(connectionUrl, databaseName), { max: 2 });
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quote(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
    await seedProjectionBacklog(sql);
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(databaseName)} WITH (FORCE)`);
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("starts failure detection from rare error scopes", async () => {
    const plans = await sql.begin(async (transaction) => {
      await transaction`SET LOCAL enable_seqscan = off`;
      return transaction.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        WITH failed_jobs AS (
          SELECT DISTINCT ON (contribution.document_job_public_id)
                 contribution.document_job_public_id,
                 coalesce(scope.safe_error_code, 'PROJECTION_SCOPE_FAILED')
                   AS error_code,
                 scope.retryable
          FROM focowiki.projection_dirty_scopes scope
          JOIN focowiki.projection_scope_contributions contribution
            ON contribution.scope_public_id = scope.public_id
           AND contribution.state = 'waiting'
          WHERE scope.state = 'error'
          ORDER BY contribution.document_job_public_id,
                   scope.updated_at DESC,
                   scope.public_id COLLATE "C"
        )
        SELECT work.public_id
        FROM failed_jobs failed
        JOIN focowiki.document_artifact_work work
          ON work.document_job_public_id = failed.document_job_public_id
        JOIN focowiki.document_processing_jobs job
          ON job.knowledge_base_id = work.knowledge_base_id
         AND job.public_id = work.document_job_public_id
        WHERE work.work_kind = 'knowledge_projection'
          AND work.state = 'waiting_on_projection'
          AND job.state = 'processing'
        ORDER BY work.updated_at, work.public_id COLLATE "C"
        LIMIT 64
      `);
    });
    const plan = JSON.stringify(plans);
    expect(plan).toContain("projection_dirty_scopes_error_idx");
    expect(plan).not.toContain('"Node Type":"Seq Scan"');
    expect(executionMilliseconds(plan)).toBeLessThan(1_000);
  });

  it("claims old contributor pressure without sorting the full scope table", async () => {
    const plans = await sql.begin(async (transaction) => {
      await transaction`SET LOCAL enable_seqscan = off`;
      return transaction.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT scope.public_id
        FROM focowiki.projection_dirty_scopes scope
        WHERE scope.state = 'waiting'
          AND scope.next_eligible_at <= now()
          AND scope.coalesce_until <= now()
          AND scope.attempt_count < scope.maximum_attempts
        ORDER BY scope.oldest_waiting_contribution_at NULLS LAST,
                 scope.waiting_contribution_count DESC,
                 scope.next_eligible_at,
                 scope.public_id
        LIMIT 64
      `);
    });
    const plan = JSON.stringify(plans);
    expect(plan).toContain("projection_dirty_scopes_waiting_pressure_idx");
    expect(plan).not.toContain('"Node Type":"Seq Scan"');
    expect(executionMilliseconds(plan)).toBeLessThan(1_000);
  });

  it("bounds new knowledge projection work while the projector backlog is full", async () => {
    const repository = createPostgresDocumentArtifactWorkRepository(
      sql as unknown as DatabaseClient,
      { projectionBacklogLimit: 100 }
    );
    const now = new Date().toISOString();
    await expect(repository.claim({
      kind: "knowledge_projection",
      resourceLane: "projection",
      workerId: "projection-pressure-worker",
      limit: 1,
      now,
      leaseDurationMs: 30_000
    })).resolves.toEqual([]);
    repository.updateProjectionBacklogLimit(20_000);
    await expect(repository.claim({
      kind: "knowledge_projection",
      resourceLane: "projection",
      workerId: "projection-pressure-worker",
      limit: 1,
      now,
      leaseDurationMs: 30_000
    })).resolves.toEqual([
      expect.objectContaining({
        publicId: "claimable-projection-work",
        documentJobPublicId: "claimable-job"
      })
    ]);
  });

  it("claims a large dirty scope as bounded contributor slices", async () => {
    const dirty = createPostgresProjectionDirtyScopeRepository(
      sql as unknown as DatabaseClient
    );
    const contributions = createPostgresProjectionScopeContributions(
      sql as unknown as DatabaseClient
    );
    const outputs = createPostgresProjectionScopeOutputRepository(
      sql as unknown as DatabaseClient
    );
    const completion = createPostgresProjectionScopeCompletion(
      sql as unknown as DatabaseClient
    );
    const sequences = Array.from({ length: 11 }, (_, index) => (index + 1) * 256);
    for (const [index, expectedSequence] of sequences.entries()) {
      const now = new Date(Date.now() + index * 1_000).toISOString();
      const claimed = await dirty.claim({
        workerId: "projection-slice-worker",
        now,
        leaseDurationMs: 30_000,
        limit: 1
      });
      expect(claimed).toEqual([
        expect.objectContaining({
          publicId: "slice-scope",
          requiredSequence: 2_816,
          renderedSequence: expectedSequence
        })
      ]);
      await expect(contributions.listCovered({
        scopePublicId: "slice-scope",
        renderedSequence: claimed[0]!.renderedSequence,
        limit: 256
      })).resolves.toHaveLength(256);
      const fingerprint = (index + 1).toString(16).repeat(64);
      await outputs.persist({
        scopePublicId: "slice-scope",
        renderedSequence: expectedSequence,
        knowledgeBaseId: "plan-kb",
        outputFingerprintSha256: fingerprint,
        pages: [],
        removedNormalizedPaths: [],
        navigationMutations: [],
        activationOwnerVersions: [],
        createdAt: now
      });
      await expect(completion.commit({
        publicId: "slice-scope",
        workerId: "projection-slice-worker",
        renderedSequence: expectedSequence,
        outputFingerprintSha256: fingerprint,
        storageRequests: {
          put: 0,
          head: 0,
          verification: 0,
          attemptedBytes: 0,
          retries: 0,
          latencyMilliseconds: 0
        },
        now
      })).resolves.toEqual(expect.objectContaining({
        state: expectedSequence === 2_816 ? "completed" : "waiting"
      }));
    }
  });

  it("reads all legacy scope outputs required to activate one document", async () => {
    const outputs = createPostgresProjectionScopeOutputRepository(
      sql as unknown as DatabaseClient
    );
    await expect(outputs.readForDocument({
      knowledgeBaseId: "plan-kb",
      documentJobPublicId: "wide-output-job",
      limit: 10_000
    })).resolves.toHaveLength(300);
  });
});

async function seedProjectionBacklog(sql: postgres.Sql): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction`SET LOCAL session_replication_role = replica`;
    await transaction`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('plan-kb', 'Projection plan', 1)
    `;
    await transaction`
      INSERT INTO focowiki.projection_dirty_scopes (
        public_id, knowledge_base_id, scope_kind, scope_key,
        required_sequence, completed_sequence, state, next_eligible_at,
        coalesce_until, safe_error_code, retryable,
        waiting_contribution_count, oldest_waiting_contribution_at
      ) VALUES (
        'error-scope', 'plan-kb', 'root', 'error-root',
        1, 0, 'error', now() - interval '1 minute',
        now() - interval '1 minute', 'portable_record_invalid', true,
        10000, now() - interval '2 minutes'
      )
    `;
    await transaction.unsafe(`
      INSERT INTO focowiki.document_processing_jobs (
        public_id, knowledge_base_id, operation_public_id,
        source_file_public_id, source_revision_public_id,
        runtime_settings_revision_public_id,
        generation_model_configuration_public_id,
        generation_model_configuration_revision,
        embedding_configuration_revision_public_id,
        semantic_generation_public_id, semantic_contract_version,
        state, maximum_attempts, accepted_at, created_at, updated_at
      )
      SELECT 'plan-job-' || item::text, 'plan-kb',
             'plan-operation-' || item::text,
             'plan-source-' || item::text, 'plan-revision-' || item::text,
             'plan-settings', 'plan-model', 1, 'plan-embedding',
             'plan-semantic', 'plan-contract', 'processing', 3,
             now() - interval '2 minutes', now() - interval '2 minutes',
             now() - interval '2 minutes'
      FROM generate_series(1, 10000) item
    `);
    await transaction.unsafe(`
      INSERT INTO focowiki.document_artifact_work (
        public_id, knowledge_base_id, document_job_public_id,
        source_file_public_id, source_revision_public_id,
        work_kind, resource_lane, input_fingerprint_sha256,
        state, maximum_attempts, next_eligible_at, created_at, updated_at
      )
      SELECT 'plan-work-' || item::text, 'plan-kb',
             'plan-job-' || item::text, 'plan-source-' || item::text,
             'plan-revision-' || item::text,
             'knowledge_projection', 'projection',
             lpad(to_hex(item), 64, '0'), 'waiting_on_projection', 3,
             now() - interval '2 minutes', now() - interval '2 minutes',
             now() - interval '2 minutes'
      FROM generate_series(1, 10000) item
    `);
    await transaction.unsafe(`
      INSERT INTO focowiki.projection_scope_contributions (
        public_id, knowledge_base_id, source_file_public_id,
        source_revision_public_id, document_job_public_id,
        scope_public_id, required_sequence, state, created_at
      )
      SELECT 'plan-contribution-' || item::text, 'plan-kb',
             'plan-source-' || item::text, 'plan-revision-' || item::text,
             'plan-job-' || item::text, 'error-scope', 1, 'waiting',
             now() - interval '2 minutes'
      FROM generate_series(1, 10000) item
    `);
    await transaction.unsafe(`
      INSERT INTO focowiki.projection_dirty_scopes (
        public_id, knowledge_base_id, scope_kind, scope_key,
        required_sequence, completed_sequence, state, next_eligible_at,
        coalesce_until, waiting_contribution_count,
        oldest_waiting_contribution_at, created_at, updated_at
      )
      SELECT 'pressure-scope-' || item::text, 'plan-kb', 'directory',
             'pressure-' || item::text, 1, 0, 'waiting',
             now() - interval '1 minute', now() - interval '1 minute',
             1 + (item % 32), now() - item * interval '1 millisecond',
             now() - interval '2 minutes', now() - interval '2 minutes'
      FROM generate_series(1, 10000) item
    `);
    await transaction`
      INSERT INTO focowiki.projection_dirty_scopes (
        public_id, knowledge_base_id, scope_kind, scope_key,
        required_sequence, completed_sequence, state, next_eligible_at,
        coalesce_until, waiting_contribution_count,
        oldest_waiting_contribution_at, created_at, updated_at
      ) VALUES (
        'slice-scope', 'plan-kb', 'root', 'slice-root',
        2816, 0, 'waiting', now() - interval '1 day',
        now() - interval '1 day', 2816, now() - interval '1 day',
        now() - interval '1 day', now() - interval '1 day'
      )
    `;
    await transaction.unsafe(`
      INSERT INTO focowiki.projection_scope_contributions (
        public_id, knowledge_base_id, source_file_public_id,
        source_revision_public_id, document_job_public_id,
        scope_public_id, required_sequence, state, created_at
      )
      SELECT 'slice-contribution-' || item::text, 'plan-kb',
             'plan-source-' || item::text, 'plan-revision-' || item::text,
             'plan-job-' || item::text, 'slice-scope', item, 'waiting',
             now() - interval '1 day'
      FROM generate_series(1, 2816) item
    `);
    await transaction`
      INSERT INTO focowiki.document_processing_jobs (
        public_id, knowledge_base_id, operation_public_id,
        source_file_public_id, source_revision_public_id,
        runtime_settings_revision_public_id,
        generation_model_configuration_public_id,
        generation_model_configuration_revision,
        embedding_configuration_revision_public_id,
        semantic_generation_public_id, semantic_contract_version,
        state, maximum_attempts, accepted_at
      ) VALUES (
        'wide-output-job', 'plan-kb', 'wide-output-operation',
        'wide-output-source', 'wide-output-revision', 'plan-settings',
        'plan-model', 1, 'plan-embedding', 'plan-semantic',
        'plan-contract', 'processing', 3, now()
      )
    `;
    await transaction.unsafe(`
      INSERT INTO focowiki.document_artifact_work (
        public_id, knowledge_base_id, document_job_public_id,
        source_file_public_id, source_revision_public_id,
        work_kind, resource_lane, input_fingerprint_sha256,
        state, maximum_attempts, next_eligible_at
      ) VALUES (
        'wide-output-work', 'plan-kb', 'wide-output-job',
        'wide-output-source', 'wide-output-revision',
        'knowledge_projection', 'projection', '${"e".repeat(64)}',
        'completed', 3, now()
      )
    `);
    await transaction.unsafe(`
      INSERT INTO focowiki.projection_dirty_scopes (
        public_id, knowledge_base_id, scope_kind, scope_key,
        required_sequence, completed_sequence, state, next_eligible_at,
        coalesce_until, waiting_contribution_count, created_at, updated_at
      )
      SELECT 'wide-output-scope-' || item::text, 'plan-kb', 'directory',
             'wide-output-' || item::text, 1, 1, 'completed', now(), now(), 0,
             now(), now()
      FROM generate_series(1, 300) item
    `);
    await transaction.unsafe(`
      INSERT INTO focowiki.projection_scope_contributions (
        public_id, knowledge_base_id, source_file_public_id,
        source_revision_public_id, document_job_public_id,
        scope_public_id, required_sequence, state, acknowledged_at, created_at
      )
      SELECT 'wide-output-contribution-' || item::text, 'plan-kb',
             'wide-output-source', 'wide-output-revision', 'wide-output-job',
             'wide-output-scope-' || item::text, 1, 'acknowledged', now(), now()
      FROM generate_series(1, 300) item
    `);
    await transaction.unsafe(`
      INSERT INTO focowiki.projection_scope_outputs (
        scope_public_id, rendered_sequence, knowledge_base_id,
        output_fingerprint_sha256, pages, removed_normalized_paths,
        navigation_mutations, activation_owner_versions, created_at
      )
      SELECT 'wide-output-scope-' || item::text, 1, 'plan-kb',
             lpad(to_hex(item + 20000), 64, '0'), '[]'::jsonb,
             ARRAY[]::text[], '[]'::jsonb, '[]'::jsonb, now()
      FROM generate_series(1, 300) item
    `);
    await transaction`
      INSERT INTO focowiki.document_processing_jobs (
        public_id, knowledge_base_id, operation_public_id,
        source_file_public_id, source_revision_public_id,
        runtime_settings_revision_public_id,
        generation_model_configuration_public_id,
        generation_model_configuration_revision,
        embedding_configuration_revision_public_id,
        semantic_generation_public_id, semantic_contract_version,
        state, maximum_attempts, accepted_at
      ) VALUES (
        'claimable-job', 'plan-kb', 'claimable-operation',
        'claimable-source', 'claimable-revision', 'plan-settings',
        'plan-model', 1, 'plan-embedding', 'plan-semantic',
        'plan-contract', 'processing', 3, now()
      )
    `;
    await transaction.unsafe(`
      INSERT INTO focowiki.document_artifact_work (
        public_id, knowledge_base_id, document_job_public_id,
        source_file_public_id, source_revision_public_id,
        work_kind, resource_lane, input_fingerprint_sha256,
        state, maximum_attempts, next_eligible_at
      ) VALUES
        ('claimable-content-work', 'plan-kb', 'claimable-job',
         'claimable-source', 'claimable-revision', 'content_projection',
         'embedding', '${"a".repeat(64)}', 'completed', 3, now()),
        ('claimable-relation-work', 'plan-kb', 'claimable-job',
         'claimable-source', 'claimable-revision', 'relation_reconcile',
         'coordination', '${"b".repeat(64)}', 'completed', 3, now()),
        ('claimable-projection-work', 'plan-kb', 'claimable-job',
         'claimable-source', 'claimable-revision', 'knowledge_projection',
         'projection', '${"c".repeat(64)}', 'waiting', 3,
         now() - interval '1 minute')
    `);
    await transaction.unsafe(`
      INSERT INTO focowiki.document_artifact_receipts (
        public_id, knowledge_base_id, document_job_public_id,
        work_public_id, source_file_public_id, source_revision_public_id,
        receipt_kind, receipt_key, input_fingerprint_sha256,
        output_fingerprint_sha256, receipt
      ) VALUES
        ('claimable-content-receipt', 'plan-kb', 'claimable-job',
         'claimable-content-work', 'claimable-source', 'claimable-revision',
         'search_family', 'content', '${"a".repeat(64)}',
         '${"d".repeat(64)}', '{}'::jsonb),
        ('claimable-relation-receipt', 'plan-kb', 'claimable-job',
         'claimable-relation-work', 'claimable-source', 'claimable-revision',
         'relation_reconciliation', 'relations', '${"b".repeat(64)}',
         '${"e".repeat(64)}', '{}'::jsonb)
    `);
  });
  await sql`ANALYZE focowiki.document_processing_jobs`;
  await sql`ANALYZE focowiki.document_artifact_work`;
  await sql`ANALYZE focowiki.projection_dirty_scopes`;
  await sql`ANALYZE focowiki.projection_scope_contributions`;
}

function executionMilliseconds(plan: string): number {
  const value = Number(/"Execution Time":([0-9.]+)/u.exec(plan)?.[1]);
  expect(value).toBeGreaterThanOrEqual(0);
  return value;
}

function withDatabase(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
