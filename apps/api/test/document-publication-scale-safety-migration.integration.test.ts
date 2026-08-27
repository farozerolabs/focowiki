import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATION_FILES, readMigrationSql } from "../src/db/migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));
const SCALE_MIGRATION = "016_single_job_publication_scale_safety.sql";
const MONOTONIC_RECOVERY_MIGRATION =
  "017_single_job_publication_monotonic_recovery.sql";
const NAVIGATION_RECONCILIATION_MIGRATION =
  "018_navigation_chain_reconciliation.sql";
const migrationIndex = MIGRATION_FILES.indexOf(SCALE_MIGRATION);

(enabled ? describe : describe.skip)("publication scale-safety migration", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_scale_recovery_${
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
    await seedFailures();
    await seedNavigationChainFailure();
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

  it("requeues only the retired navigation validation failure", async () => {
    await sql.unsafe(readMigrationSql(SCALE_MIGRATION));

    await expect(sql<Array<{
      item_outcome: string;
      membership_count: number | string;
      document_state: string;
      document_error: string | null;
      projection_state: string;
      operation_state: string;
      result_count: number | string;
      pending_item_count: number | string;
    }>>`
      SELECT item.outcome AS item_outcome,
             (SELECT count(*) FROM focowiki.publication_job_items membership
              WHERE membership.item_public_id = item.public_id)
               AS membership_count,
             document_job.state AS document_state,
             document_job.safe_error_code AS document_error,
             work.state AS projection_state,
             operation.state AS operation_state,
             (SELECT count(*) FROM focowiki.operation_results result
              WHERE result.public_id = operation.public_id) AS result_count,
             head.pending_item_count
      FROM focowiki.publication_items item
      JOIN focowiki.document_processing_jobs document_job
        ON document_job.public_id = item.document_job_public_id
      JOIN focowiki.document_artifact_work work
        ON work.document_job_public_id = document_job.public_id
       AND work.work_kind = 'knowledge_projection'
      JOIN focowiki.operations operation
        ON operation.public_id = document_job.operation_public_id
      JOIN focowiki.knowledge_base_publication_heads head
        ON head.knowledge_base_id = item.knowledge_base_id
      WHERE item.public_id = 'scale-recoverable-item'
    `).resolves.toEqual([{
      item_outcome: "pending",
      membership_count: "0",
      document_state: "processing",
      document_error: null,
      projection_state: "waiting_on_projection",
      operation_state: "processing",
      result_count: "0",
      pending_item_count: 1
    }]);
    await expect(sql<Array<{
      item_outcome: string;
      membership_count: number | string;
      safe_error_code: string | null;
    }>>`
      SELECT item.outcome AS item_outcome,
             (SELECT count(*) FROM focowiki.publication_job_items membership
              WHERE membership.item_public_id = item.public_id)
               AS membership_count,
             item.safe_error_code
      FROM focowiki.publication_items item
      WHERE item.public_id = 'scale-unrelated-item'
    `).resolves.toEqual([{
      item_outcome: "failed",
      membership_count: "1",
      safe_error_code: "publication_output_path_invalid"
    }]);
    await expect(sql<Array<{
      attempt_token: string | null;
      attempt_count: number;
      manifest_fingerprint_sha256: string | null;
    }>>`
      SELECT attempt_token, attempt_count, manifest_fingerprint_sha256
      FROM focowiki.publication_jobs
      WHERE public_id = 'scale-pending-job'
    `).resolves.toEqual([{
      attempt_token: null,
      attempt_count: 0,
      manifest_fingerprint_sha256: null
    }]);

    await sql.unsafe(readMigrationSql(MONOTONIC_RECOVERY_MIGRATION));
    await expect(sql<Array<{
      item_outcome: string;
      readiness_sequence: number | string;
      membership_count: number | string;
      document_state: string;
      document_error: string | null;
      projection_state: string;
      activation_state: string;
      operation_state: string;
      result_count: number | string;
      pending_item_count: number | string;
      latest_readiness_sequence: number | string;
    }>>`
      SELECT item.outcome AS item_outcome, item.readiness_sequence,
             (SELECT count(*) FROM focowiki.publication_job_items membership
              WHERE membership.item_public_id = item.public_id)
               AS membership_count,
             document_job.state AS document_state,
             document_job.safe_error_code AS document_error,
             projection.state AS projection_state,
             activation.state AS activation_state,
             operation.state AS operation_state,
             (SELECT count(*) FROM focowiki.operation_results result
              WHERE result.public_id = operation.public_id) AS result_count,
             head.pending_item_count, head.latest_readiness_sequence
      FROM focowiki.publication_items item
      JOIN focowiki.document_processing_jobs document_job
        ON document_job.public_id = item.document_job_public_id
      JOIN focowiki.document_artifact_work projection
        ON projection.document_job_public_id = document_job.public_id
       AND projection.work_kind = 'knowledge_projection'
      JOIN focowiki.document_artifact_work activation
        ON activation.document_job_public_id = document_job.public_id
       AND activation.work_kind = 'activate'
      JOIN focowiki.operations operation
        ON operation.public_id = document_job.operation_public_id
      JOIN focowiki.knowledge_base_publication_heads head
        ON head.knowledge_base_id = item.knowledge_base_id
      WHERE item.public_id = 'scale-stale-item'
    `).resolves.toEqual([{
      item_outcome: "pending",
      readiness_sequence: "12002",
      membership_count: "0",
      document_state: "processing",
      document_error: null,
      projection_state: "waiting_on_projection",
      activation_state: "waiting",
      operation_state: "processing",
      result_count: "0",
      pending_item_count: 2,
      latest_readiness_sequence: "12002"
    }]);

    await sql.unsafe(readMigrationSql(NAVIGATION_RECONCILIATION_MIGRATION));
    await expect(sql<Array<{
      item_outcome: string;
      membership_count: number | string;
      document_state: string;
      document_error: string | null;
      projection_state: string;
      operation_state: string;
      result_count: number | string;
      pending_item_count: number | string;
    }>>`
      SELECT item.outcome AS item_outcome,
             (SELECT count(*) FROM focowiki.publication_job_items membership
              WHERE membership.item_public_id = item.public_id)
               AS membership_count,
             document_job.state AS document_state,
             document_job.safe_error_code AS document_error,
             work.state AS projection_state,
             operation.state AS operation_state,
             (SELECT count(*) FROM focowiki.operation_results result
              WHERE result.public_id = operation.public_id) AS result_count,
             head.pending_item_count
      FROM focowiki.publication_items item
      JOIN focowiki.document_processing_jobs document_job
        ON document_job.public_id = item.document_job_public_id
      JOIN focowiki.document_artifact_work work
        ON work.document_job_public_id = document_job.public_id
       AND work.work_kind = 'knowledge_projection'
      JOIN focowiki.operations operation
        ON operation.public_id = document_job.operation_public_id
      JOIN focowiki.knowledge_base_publication_heads head
        ON head.knowledge_base_id = item.knowledge_base_id
      WHERE item.public_id = 'chain-item'
    `).resolves.toEqual([{
      item_outcome: "pending",
      membership_count: "0",
      document_state: "processing",
      document_error: null,
      projection_state: "waiting_on_projection",
      operation_state: "processing",
      result_count: "0",
      pending_item_count: 1
    }]);
  });

  async function seedNavigationChainFailure(): Promise<void> {
    await sql.begin(async (transaction) => {
      await transaction`SET LOCAL session_replication_role = replica`;
      await transaction`
        INSERT INTO focowiki.operations (
          public_id, knowledge_base_id, operation_kind, state,
          target_kind, target_public_id, created_at, updated_at, completed_at
        ) VALUES (
          'chain-operation', 'chain-kb', 'source_upload', 'failed',
          'source_file', 'chain-source', now(), now(), now()
        )
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
          readiness_sequence, state, attempt_count, failure_count,
          total_attempt_count, maximum_attempts, required_work_count,
          completed_work_count, blocking_work_kind, safe_error_code,
          retryable, accepted_at, started_at, terminal_at, created_at,
          updated_at
        ) VALUES (
          'chain-document-job', 'chain-kb', 'chain-operation',
          'chain-source', 'chain-revision', 'chain-settings', 'chain-model', 1,
          'chain-embedding', 'chain-semantic', 'chain-contract', 41,
          'error', 1, 1, 1, 3, 2, 0, 'knowledge_projection',
          'previous_state_invalid', true,
          now(), now(), now(), now(), now()
        )
      `;
      await transaction`
        INSERT INTO focowiki.document_artifact_work (
          public_id, knowledge_base_id, document_job_public_id,
          source_file_public_id, source_revision_public_id, work_kind,
          resource_lane, input_fingerprint_sha256, state, attempt_count,
          maximum_attempts, next_eligible_at, safe_error_code, retryable,
          started_at, ended_at, created_at, updated_at
        ) VALUES (
          'chain-projection-work', 'chain-kb', 'chain-document-job',
          'chain-source', 'chain-revision', 'knowledge_projection',
          'projection', ${"5".repeat(64)}, 'error', 1, 3, now(),
          'previous_state_invalid', true, now(), now(), now(), now()
        )
      `;
      await transaction`
        INSERT INTO focowiki.knowledge_base_publication_heads (
          knowledge_base_id, active_revision, active_readiness_sequence,
          latest_readiness_sequence, pending_item_count, updated_at
        ) VALUES ('chain-kb', 40, 40, 41, 0, now())
      `;
      await transaction`
        INSERT INTO focowiki.publication_items (
          public_id, mutation_public_id, knowledge_base_id,
          document_job_public_id, source_file_public_id,
          source_revision_public_id, operation, next_logical_path,
          readiness_sequence, outcome, safe_error_code, created_at,
          terminal_at, updated_at
        ) VALUES (
          'chain-item', 'chain-mutation', 'chain-kb', 'chain-document-job',
          'chain-source', 'chain-revision', 'create', 'pages/chain.md', 41,
          'failed', 'previous_state_invalid', now(), now(), now()
        )
      `;
      await transaction`
        INSERT INTO focowiki.publication_jobs (
          public_id, knowledge_base_id, base_active_revision,
          target_readiness_sequence, renderer_contract_version, outcome,
          attempt_count, next_eligible_at, safe_error_code, created_at,
          updated_at, completed_at
        ) VALUES (
          'chain-job', 'chain-kb', 40, 41, 'portable-okf-v5', 'failed',
          3, now(), 'previous_state_invalid', now(), now(), now()
        )
      `;
      await transaction`
        INSERT INTO focowiki.publication_job_items (
          job_public_id, item_public_id, membership_order, created_at
        ) VALUES ('chain-job', 'chain-item', 0, now())
      `;
      await transaction`
        INSERT INTO focowiki.operation_results (
          public_id, knowledge_base_id, operation_kind, terminal_state,
          result_code, result_summary, correlation_public_id,
          completed_at, expires_at
        ) VALUES (
          'chain-operation', 'chain-kb', 'source_upload', 'failed',
          'previous_state_invalid', '{}'::jsonb, 'chain-document-job',
          now(), now() + interval '30 days'
        )
      `;
    });
  }

  async function seedFailures(): Promise<void> {
    await sql.begin(async (transaction) => {
      await transaction`SET LOCAL session_replication_role = replica`;
      await transaction`
        INSERT INTO focowiki.operations (
          public_id, knowledge_base_id, operation_kind, state,
          target_kind, target_public_id, created_at, updated_at, completed_at
        ) VALUES (
          'scale-operation', 'scale-kb', 'source_upload', 'failed',
          'source_file', 'scale-source', now(), now(), now()
        ), (
          'scale-stale-operation', 'scale-kb', 'source_upload', 'failed',
          'source_file', 'scale-stale-source', now(), now(), now()
        )
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
          readiness_sequence, state, attempt_count, failure_count,
          total_attempt_count, maximum_attempts, required_work_count,
          completed_work_count, blocking_work_kind, safe_error_code,
          retryable, accepted_at, started_at, terminal_at, created_at,
          updated_at
        ) VALUES (
          'scale-document-job', 'scale-kb', 'scale-operation',
          'scale-source', 'scale-revision', 'scale-settings', 'scale-model', 1,
          'scale-embedding', 'scale-semantic', 'scale-contract', 12001,
          'error', 1, 1, 1, 3, 2, 0, 'knowledge_projection',
          'publication_navigation_mutations_invalid', true,
          now(), now(), now(), now(), now()
        ), (
          'scale-stale-document-job', 'scale-kb', 'scale-stale-operation',
          'scale-stale-source', 'scale-stale-revision', 'scale-settings',
          'scale-model', 1, 'scale-embedding', 'scale-semantic',
          'scale-contract', 11999, 'error', 1, 1, 1, 3, 2, 1,
          'activate', 'publication_page_owner_revision_stale', true,
          now(), now(), now(), now(), now()
        )
      `;
      await transaction`
        INSERT INTO focowiki.document_artifact_work (
          public_id, knowledge_base_id, document_job_public_id,
          source_file_public_id, source_revision_public_id, work_kind,
          resource_lane, input_fingerprint_sha256, state, attempt_count,
          maximum_attempts, next_eligible_at, safe_error_code, retryable,
          started_at, ended_at, created_at, updated_at
        ) VALUES (
          'scale-projection-work', 'scale-kb', 'scale-document-job',
          'scale-source', 'scale-revision', 'knowledge_projection',
          'projection', ${"1".repeat(64)}, 'error', 1, 3, now(),
          'publication_navigation_mutations_invalid', true,
          now(), now(), now(), now()
        ), (
          'scale-stale-projection-work', 'scale-kb',
          'scale-stale-document-job', 'scale-stale-source',
          'scale-stale-revision', 'knowledge_projection', 'projection',
          ${"3".repeat(64)}, 'waiting_on_projection', 1, 3, now(),
          NULL, false, now(), NULL, now(), now()
        ), (
          'scale-stale-activation-work', 'scale-kb',
          'scale-stale-document-job', 'scale-stale-source',
          'scale-stale-revision', 'activate', 'activation',
          ${"4".repeat(64)}, 'error', 1, 3, now(),
          'publication_page_owner_revision_stale', true,
          now(), now(), now(), now()
        )
      `;
      await transaction`
        INSERT INTO focowiki.knowledge_base_publication_heads (
          knowledge_base_id, active_revision, active_readiness_sequence,
          latest_readiness_sequence, pending_item_count, updated_at
        ) VALUES ('scale-kb', 12000, 12000, 12001, 0, now())
      `;
      await transaction`
        INSERT INTO focowiki.publication_items (
          public_id, mutation_public_id, knowledge_base_id,
          document_job_public_id, source_file_public_id,
          source_revision_public_id, operation, next_logical_path,
          readiness_sequence, outcome, safe_error_code, created_at,
          terminal_at, updated_at
        ) VALUES
          ('scale-recoverable-item', 'scale-mutation', 'scale-kb',
           'scale-document-job', 'scale-source', 'scale-revision', 'create',
           'pages/scale.md', 12001, 'failed',
           'publication_navigation_mutations_invalid', now(), now(), now()),
          ('scale-stale-item', 'scale-stale-mutation', 'scale-kb',
           'scale-stale-document-job', 'scale-stale-source',
           'scale-stale-revision', 'create', 'pages/stale.md', 11999,
           'failed', 'publication_page_owner_revision_stale',
           now(), now(), now()),
          ('scale-unrelated-item', 'scale-unrelated-mutation', 'other-kb',
           NULL, 'other-source', 'other-revision', 'create',
           'pages/other.md', 1, 'failed', 'publication_output_path_invalid',
           now(), now(), now())
      `;
      await transaction`
        INSERT INTO focowiki.publication_jobs (
          public_id, knowledge_base_id, base_active_revision,
          target_readiness_sequence, renderer_contract_version, outcome,
          attempt_owner, attempt_token, attempt_started_at, attempt_deadline,
          attempt_count, next_eligible_at, manifest_fingerprint_sha256,
          manifest_attempt_token, safe_error_code, created_at, updated_at,
          completed_at
        ) VALUES
          ('scale-failed-job', 'scale-kb', 12000, 12001, 'portable-okf-v5',
           'failed', NULL, NULL, NULL, NULL, 3, now(), NULL, NULL,
           'publication_navigation_mutations_invalid', now(), now(), now()),
          ('scale-stale-job', 'scale-kb', 12000, 11999, 'portable-okf-v5',
           'failed', NULL, NULL, NULL, NULL, 3, now(), NULL, NULL,
           'publication_page_owner_revision_stale', now(), now(), now()),
          ('scale-unrelated-job', 'other-kb', 0, 1, 'portable-okf-v5',
           'failed', NULL, NULL, NULL, NULL, 1, now(), NULL, NULL,
           'publication_output_path_invalid', now(), now(), now()),
          ('scale-pending-job', 'pending-kb', 0, 1, 'portable-okf-v5',
           'pending', 'old-worker', 'old-token', now(), now() + interval '30 min',
           2, now(), ${"2".repeat(64)}, 'old-token', NULL, now(), now(), NULL)
      `;
      await transaction`
        INSERT INTO focowiki.publication_job_items (
          job_public_id, item_public_id, membership_order, created_at
        ) VALUES
          ('scale-failed-job', 'scale-recoverable-item', 0, now()),
          ('scale-stale-job', 'scale-stale-item', 0, now()),
          ('scale-unrelated-job', 'scale-unrelated-item', 0, now())
      `;
      await transaction`
        INSERT INTO focowiki.operation_results (
          public_id, knowledge_base_id, operation_kind, terminal_state,
          result_code, result_summary, correlation_public_id,
          completed_at, expires_at
        ) VALUES (
          'scale-operation', 'scale-kb', 'source_upload', 'failed',
          'publication_navigation_mutations_invalid', '{}'::jsonb,
          'scale-document-job', now(), now() + interval '30 days'
        ), (
          'scale-stale-operation', 'scale-kb', 'source_upload', 'failed',
          'publication_page_owner_revision_stale', '{}'::jsonb,
          'scale-stale-document-job', now(), now() + interval '30 days'
        )
      `;
    });
  }
});

function withDatabase(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
