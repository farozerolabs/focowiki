import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATION_FILES, readMigrationSql } from "../src/db/migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));
const RECOVERY_MIGRATION = "020_navigation_leaf_identity_recovery.sql";
const migrationIndex = MIGRATION_FILES.indexOf(RECOVERY_MIGRATION);

(enabled ? describe : describe.skip)(
  "navigation leaf identity recovery migration",
  () => {
    const connectionUrl = databaseUrl
      ?? "postgres://unused:unused@127.0.0.1:5432/unused";
    const databaseName = `focowiki_leaf_identity_recovery_${
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
      await seedFailure();
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

    it("requeues failed items without reusing the failed publication job",
      async () => {
        await sql.unsafe(readMigrationSql(RECOVERY_MIGRATION));

        await expect(sql<Array<{
          item_outcome: string;
          membership_count: string;
          document_state: string;
          document_error: string | null;
          activation_state: string;
          operation_state: string;
          result_count: string;
          pending_item_count: number;
          generation: string;
        }>>`
          SELECT item.outcome AS item_outcome,
                 (SELECT count(*)::text
                  FROM focowiki.publication_job_items membership
                  WHERE membership.item_public_id = item.public_id)
                   AS membership_count,
                 document_job.state AS document_state,
                 document_job.safe_error_code AS document_error,
                 work.state AS activation_state,
                 operation.state AS operation_state,
                 (SELECT count(*)::text FROM focowiki.operation_results result
                  WHERE result.public_id = operation.public_id)
                   AS result_count,
                 head.pending_item_count,
                 generation.generation
          FROM focowiki.publication_items item
          JOIN focowiki.document_processing_jobs document_job
            ON document_job.public_id = item.document_job_public_id
          JOIN focowiki.document_artifact_work work
            ON work.document_job_public_id = document_job.public_id
           AND work.work_kind = 'activate'
          JOIN focowiki.operations operation
            ON operation.public_id = document_job.operation_public_id
          JOIN focowiki.knowledge_base_publication_heads head
            ON head.knowledge_base_id = item.knowledge_base_id
          CROSS JOIN focowiki.runtime_generation generation
          WHERE item.public_id = 'leaf-identity-item'
        `).resolves.toEqual([{
          item_outcome: "pending",
          membership_count: "0",
          document_state: "processing",
          document_error: null,
          activation_state: "waiting",
          operation_state: "processing",
          result_count: "0",
          pending_item_count: 1,
          generation: "storage-vnext-v28-navigation-leaf-identity-recovery"
        }]);
      });

    async function seedFailure(): Promise<void> {
      await sql.begin(async (transaction) => {
        await transaction`SET LOCAL session_replication_role = replica`;
        await transaction`
          INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
          VALUES ('leaf-identity-kb', 'Leaf identity recovery', 1)
        `;
        await transaction`
          INSERT INTO focowiki.operations (
            public_id, knowledge_base_id, operation_kind, state,
            target_kind, target_public_id, created_at, updated_at, completed_at
          ) VALUES (
            'leaf-identity-operation', 'leaf-identity-kb', 'source_upload',
            'failed', 'source_file', 'leaf-identity-source', now(), now(), now()
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
            'leaf-identity-document-job', 'leaf-identity-kb',
            'leaf-identity-operation', 'leaf-identity-source',
            'leaf-identity-revision', 'leaf-identity-settings',
            'leaf-identity-model', 1, 'leaf-identity-embedding',
            'leaf-identity-semantic', 'leaf-identity-contract', 42,
            'error', 1, 1, 1, 3, 2, 1, 'activate',
            'navigation_chain_invalid', false,
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
            'leaf-identity-activation-work', 'leaf-identity-kb',
            'leaf-identity-document-job', 'leaf-identity-source',
            'leaf-identity-revision', 'activate', 'activation',
            ${"5".repeat(64)}, 'error', 1, 3, now(),
            'navigation_chain_invalid', false, now(), now(), now(), now()
          )
        `;
        await transaction`
          INSERT INTO focowiki.knowledge_base_publication_heads (
            knowledge_base_id, active_revision, active_readiness_sequence,
            latest_readiness_sequence, pending_item_count, updated_at
          ) VALUES ('leaf-identity-kb', 41, 41, 42, 0, now())
        `;
        await transaction`
          INSERT INTO focowiki.publication_items (
            public_id, mutation_public_id, knowledge_base_id,
            document_job_public_id, source_file_public_id,
            source_revision_public_id, operation, next_logical_path,
            readiness_sequence, outcome, safe_error_code, created_at,
            terminal_at, updated_at
          ) VALUES (
            'leaf-identity-item', 'leaf-identity-mutation',
            'leaf-identity-kb', 'leaf-identity-document-job',
            'leaf-identity-source', 'leaf-identity-revision', 'create',
            'pages/leaf-identity.md', 42, 'failed',
            'navigation_chain_invalid', now(), now(), now()
          )
        `;
        await transaction`
          INSERT INTO focowiki.publication_jobs (
            public_id, knowledge_base_id, base_active_revision,
            target_readiness_sequence, renderer_contract_version, outcome,
            attempt_count, next_eligible_at, safe_error_code, created_at,
            updated_at, completed_at
          ) VALUES (
            'leaf-identity-job', 'leaf-identity-kb', 41, 42,
            'portable-okf-v5', 'failed', 1, now(),
            'navigation_chain_invalid', now(), now(), now()
          )
        `;
        await transaction`
          INSERT INTO focowiki.publication_job_items (
            job_public_id, item_public_id, membership_order, created_at
          ) VALUES ('leaf-identity-job', 'leaf-identity-item', 0, now())
        `;
        await transaction`
          INSERT INTO focowiki.operation_results (
            public_id, knowledge_base_id, operation_kind, terminal_state,
            result_code, result_summary, correlation_public_id,
            completed_at, expires_at
          ) VALUES (
            'leaf-identity-operation', 'leaf-identity-kb', 'source_upload',
            'failed', 'navigation_chain_invalid', '{}'::jsonb,
            'leaf-identity-document-job', now(), now() + interval '30 days'
          )
        `;
      });
    }
  }
);

function withDatabase(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
