import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { MIGRATION_FILES, readMigrationSql } from "../src/db/migrations.js";
import { fingerprintDocumentPublicationOutputs } from
  "../src/document-indexing/application/document-publication-manifest.js";
import { DOCUMENT_PUBLICATION_RENDERER_CONTRACT_VERSION } from
  "../src/document-indexing/application/document-publication-renderer-contract.js";
import { createPostgresDocumentPublicationActivation } from
  "../src/document-indexing/infrastructure/postgres-document-publication-activation.js";
import { readPostgresDocumentPublicationBaseEventTime } from
  "../src/document-indexing/infrastructure/postgres-document-publication-job-base-pages.js";
import { createPostgresDocumentPublicationJobRepository } from
  "../src/document-indexing/infrastructure/postgres-document-publication-job-repository.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));
const CORRECTION_MIGRATION =
  "014_single_job_publication_upgrade_baseline.sql";
const correctionIndex = MIGRATION_FILES.indexOf(CORRECTION_MIGRATION);

(enabled ? describe : describe.skip)("single-job upgrade baseline correction", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_single_upgrade_baseline_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(withDatabase(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(withDatabase(connectionUrl, databaseName), { max: 4 });
  const database = sql as unknown as DatabaseClient;
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quote(databaseName)}`);
    databaseCreated = true;
    for (const file of MIGRATION_FILES.slice(0, correctionIndex)) {
      await sql.unsafe(readMigrationSql(file));
    }
    await seedMissingBaselineFailure();
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

  it("bridges the active baseline and requeues only the matching failure",
    async () => {
      const activeOwnershipBefore = await readActiveOwnership();
      await expect(readPostgresDocumentPublicationBaseEventTime(database, {
        knowledgeBaseId: "upgrade-baseline-kb",
        baseActiveRevision: 971
      })).rejects.toMatchObject({ code: "publication_active_base_changed" });

      await sql.unsafe(readMigrationSql(CORRECTION_MIGRATION));
      await expect(readActiveOwnership()).resolves.toEqual(activeOwnershipBefore);
      await expect(sql.unsafe(readMigrationSql(CORRECTION_MIGRATION)))
        .resolves.toBeDefined();
      await expect(readActiveOwnership()).resolves.toEqual(activeOwnershipBefore);

      await expect(readPostgresDocumentPublicationBaseEventTime(database, {
        knowledgeBaseId: "upgrade-baseline-kb",
        baseActiveRevision: 971
      })).resolves.toBe("2026-08-25T10:22:22.507Z");
      await expect(sql<Array<{
        active_job_public_id: string | null;
        outcome: string | null;
        base_active_revision: number | string | null;
        target_readiness_sequence: number | string | null;
      }>>`
        SELECT head.active_job_public_id, job.outcome,
               job.base_active_revision, job.target_readiness_sequence
        FROM focowiki.knowledge_base_publication_heads head
        LEFT JOIN focowiki.publication_jobs job
          ON job.public_id = head.active_job_public_id
        WHERE head.knowledge_base_id = 'upgrade-baseline-kb'
      `).resolves.toEqual([{
        active_job_public_id: expect.stringMatching(
          /^publication-bootstrap-job-[0-9a-f]{32}$/u
        ),
        outcome: "committed",
        base_active_revision: "970",
        target_readiness_sequence: "11954"
      }]);
      await expect(sql<Array<{
        item_outcome: string;
        job_outcome: string;
        membership_count: number | string;
        document_state: string;
        document_error: string | null;
        projection_state: string;
        projection_error: string | null;
        operation_state: string;
        operation_result_count: number | string;
      }>>`
        SELECT item.outcome AS item_outcome,
               publication_job.outcome AS job_outcome,
               (SELECT count(*) FROM focowiki.publication_job_items membership
                WHERE membership.item_public_id = item.public_id)
                 AS membership_count,
               document_job.state AS document_state,
               document_job.safe_error_code AS document_error,
               projection.state AS projection_state,
               projection.safe_error_code AS projection_error,
               operation.state AS operation_state,
               (SELECT count(*) FROM focowiki.operation_results result
                WHERE result.public_id = operation.public_id)
                 AS operation_result_count
        FROM focowiki.publication_items item
        JOIN focowiki.publication_jobs publication_job
          ON publication_job.public_id = 'upgrade-failed-publication-job'
        JOIN focowiki.document_processing_jobs document_job
          ON document_job.public_id = item.document_job_public_id
        JOIN focowiki.document_artifact_work projection
          ON projection.document_job_public_id = document_job.public_id
         AND projection.work_kind = 'knowledge_projection'
        JOIN focowiki.operations operation
          ON operation.public_id = document_job.operation_public_id
        WHERE item.public_id = 'upgrade-failed-publication-item'
      `).resolves.toEqual([{
        item_outcome: "pending",
        job_outcome: "failed",
        membership_count: "0",
        document_state: "processing",
        document_error: null,
        projection_state: "waiting_on_projection",
        projection_error: null,
        operation_state: "processing",
        operation_result_count: "0"
      }]);
      await expect(sql<Array<{
        pending_item_count: number | string;
        oldest_pending_at: Date | string | null;
        latest_pending_at: Date | string | null;
      }>>`
        SELECT pending_item_count, oldest_pending_at, latest_pending_at
        FROM focowiki.knowledge_base_publication_heads
        WHERE knowledge_base_id = 'upgrade-baseline-kb'
      `).resolves.toEqual([{
        pending_item_count: 1,
        oldest_pending_at: new Date("2026-08-26T04:14:46.000Z"),
        latest_pending_at: new Date("2026-08-26T04:14:46.000Z")
      }]);
      await expect(sql<Array<{
        item_outcome: string;
        membership_count: number | string;
        document_state: string;
      }>>`
        SELECT item.outcome AS item_outcome,
               (SELECT count(*) FROM focowiki.publication_job_items membership
                WHERE membership.item_public_id = item.public_id)
                 AS membership_count,
               document_job.state AS document_state
        FROM focowiki.publication_items item
        JOIN focowiki.document_processing_jobs document_job
          ON document_job.public_id = item.document_job_public_id
        WHERE item.public_id = 'upgrade-stale-publication-item'
      `).resolves.toEqual([{
        item_outcome: "failed",
        membership_count: "1",
        document_state: "error"
      }]);

      const repository = createPostgresDocumentPublicationJobRepository(database);
      const firstJob = await repository.admitOne({
        now: "2026-08-26T04:14:48.000Z",
        rendererContractVersion: DOCUMENT_PUBLICATION_RENDERER_CONTRACT_VERSION
      });
      expect(firstJob).toMatchObject({
        knowledgeBaseId: "upgrade-baseline-kb",
        baseActiveRevision: 971,
        targetReadinessSequence: 11955
      });
      const firstClaim = await repository.claimOne({
        workerId: "upgrade-first-worker",
        now: "2026-08-26T04:14:49.000Z"
      });
      expect(firstClaim?.publicId).toBe(firstJob?.publicId);
      const firstOutputs = [deleteOutput("pages/upgrade.md", "5")];
      await expect(repository.persistManifest({
        jobPublicId: firstClaim!.publicId,
        attemptToken: firstClaim!.attemptToken!,
        fingerprintSha256: fingerprintDocumentPublicationOutputs(firstOutputs),
        outputs: firstOutputs,
        persistedAt: "2026-08-26T04:14:50.000Z"
      })).resolves.toBe(true);
      await expect(createPostgresDocumentPublicationActivation({ sql: database })
        .activate({
          jobPublicId: firstClaim!.publicId,
          attemptToken: firstClaim!.attemptToken!,
          activatedAt: "2026-08-26T04:14:51.000Z"
        })).resolves.toMatchObject({ activeRevision: 972, documentCount: 1 });

      const restartedRepository =
        createPostgresDocumentPublicationJobRepository(database);
      await restartedRepository.createItem({
        publicId: "upgrade-second-publication-item",
        mutationPublicId: "upgrade-second-mutation",
        knowledgeBaseId: "upgrade-baseline-kb",
        documentJobPublicId: null,
        sourceFilePublicId: "upgrade-stale-source",
        sourceRevisionPublicId: "upgrade-stale-source-revision",
        operation: "delete",
        priorLogicalPath: "stale.md",
        nextLogicalPath: null,
        affectedEvidence: {},
        readinessSequence: 11957,
        createdAt: "2026-08-26T04:14:52.000Z"
      });
      const secondJob = await restartedRepository.admitOne({
        now: "2026-08-26T04:14:53.000Z",
        rendererContractVersion: DOCUMENT_PUBLICATION_RENDERER_CONTRACT_VERSION
      });
      expect(secondJob).toMatchObject({
        knowledgeBaseId: "upgrade-baseline-kb",
        baseActiveRevision: 972,
        targetReadinessSequence: 11957
      });
      const secondClaim = await restartedRepository.claimOne({
        workerId: "upgrade-second-worker",
        now: "2026-08-26T04:14:54.000Z"
      });
      expect(secondClaim?.publicId).toBe(secondJob?.publicId);
      const secondOutputs = [deleteOutput("pages/stale.md", "6")];
      await expect(restartedRepository.persistManifest({
        jobPublicId: secondClaim!.publicId,
        attemptToken: secondClaim!.attemptToken!,
        fingerprintSha256: fingerprintDocumentPublicationOutputs(secondOutputs),
        outputs: secondOutputs,
        persistedAt: "2026-08-26T04:14:55.000Z"
      })).resolves.toBe(true);
      await expect(createPostgresDocumentPublicationActivation({ sql: database })
        .activate({
          jobPublicId: secondClaim!.publicId,
          attemptToken: secondClaim!.attemptToken!,
          activatedAt: "2026-08-26T04:14:56.000Z"
        })).resolves.toMatchObject({ activeRevision: 973, documentCount: 0 });
      await expect(sql<Array<{
        active_revision: number | string;
        active_job_public_id: string | null;
      }>>`
        SELECT active_revision, active_job_public_id
        FROM focowiki.knowledge_base_publication_heads
        WHERE knowledge_base_id = 'upgrade-baseline-kb'
      `).resolves.toEqual([{
        active_revision: "973",
        active_job_public_id: secondClaim!.publicId
      }]);
    }, 120_000);

  async function readActiveOwnership() {
    const rows = await sql<Array<{
      generated_path: string | null;
      generated_object_id: string | null;
      active_search_owner_count: number | string;
      active_source_revision_public_id: string | null;
      source_object_state: string;
    }>>`
      SELECT head.normalized_path AS generated_path,
             head.object_id AS generated_object_id,
             (SELECT count(*) FROM focowiki.search_document_owners owner
              WHERE owner.knowledge_base_id = 'upgrade-baseline-kb'
                AND owner.state = 'active') AS active_search_owner_count,
             active.active_source_revision_public_id,
             registration.state AS source_object_state
      FROM focowiki.generated_page_heads head
      JOIN focowiki.source_file_active_revisions active
        ON active.knowledge_base_id = head.knowledge_base_id
       AND active.source_file_public_id = head.source_file_public_id
      JOIN focowiki.object_registrations registration
        ON registration.object_id = head.object_id
      WHERE head.knowledge_base_id = 'upgrade-baseline-kb'
        AND head.normalized_path = 'pages/upgrade.md'
    `;
    return rows;
  }

  async function seedMissingBaselineFailure(): Promise<void> {
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('upgrade-baseline-kb', 'Upgrade baseline', 1)
    `;
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        'upgrade-source-object', 'objects/upgrade-source-object',
        ${"1".repeat(64)}, 100, 'text/markdown; charset=utf-8',
        'source-markdown-v1', 'verified', 'upgrade-source-write',
        '2026-08-25T10:20:00.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.source_files (
        public_id, knowledge_base_id, logical_path, normalized_path,
        title, metadata, revision
      ) VALUES
        ('upgrade-source', 'upgrade-baseline-kb', 'upgrade.md', 'upgrade.md',
         'Upgrade', '{}'::jsonb, 1),
        ('upgrade-stale-source', 'upgrade-baseline-kb', 'stale.md', 'stale.md',
         'Stale', '{}'::jsonb, 1)
    `;
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type
      ) VALUES
        ('upgrade-source-revision', 'upgrade-baseline-kb', 'upgrade-source',
         'upgrade-source-object', ${"1".repeat(64)}, 100,
         'text/markdown; charset=utf-8'),
        ('upgrade-stale-source-revision', 'upgrade-baseline-kb',
         'upgrade-stale-source', 'upgrade-source-object', ${"1".repeat(64)},
         100, 'text/markdown; charset=utf-8')
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_sequences (
        knowledge_base_id, current_sequence, updated_at
      ) VALUES (
        'upgrade-baseline-kb', 11956, '2026-08-26T04:14:46.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.source_file_active_revisions (
        knowledge_base_id, source_file_public_id,
        current_source_revision_public_id, active_source_revision_public_id,
        activation_sequence
      ) VALUES
      (
        'upgrade-baseline-kb', 'upgrade-source', 'upgrade-source-revision',
        'upgrade-source-revision', 11954
      ),
      (
        'upgrade-baseline-kb', 'upgrade-stale-source',
        'upgrade-stale-source-revision', 'upgrade-stale-source-revision', 11954
      )
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_publication_heads (
        knowledge_base_id, active_revision, active_readiness_sequence,
        latest_readiness_sequence, pending_item_count, updated_at
      ) VALUES (
        'upgrade-baseline-kb', 971, 11954, 11956, 0,
        '2026-08-25T10:22:22.507Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.generated_page_heads (
        knowledge_base_id, logical_path, normalized_path, entry_kind,
        source_file_public_id, source_revision_public_id,
        page_candidate_public_id, object_id, checksum_sha256, byte_count,
        activation_revision, updated_at
      ) VALUES (
        'upgrade-baseline-kb', 'pages/upgrade.md', 'pages/upgrade.md',
        'source-page', 'upgrade-source', 'upgrade-source-revision', NULL,
        'upgrade-source-object', ${"1".repeat(64)}, 100, 11954,
        '2026-08-25T10:22:22.507Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.search_projections (
        public_id, knowledge_base_id, provider_kind, provider_index_uid,
        schema_checksum_sha256, settings_checksum_sha256,
        active_contract_revision, document_count, state
      ) VALUES (
        'upgrade-search-projection', 'upgrade-baseline-kb', 'opensearch',
        'upgrade-index', ${"7".repeat(64)}, ${"8".repeat(64)}, 1, 1, 'active'
      )
    `;
    await sql`
      INSERT INTO focowiki.search_document_owners (
        knowledge_base_id, search_projection_public_id, provider_kind,
        provider_document_id, document_kind, source_file_public_id,
        source_revision_public_id, document_checksum_sha256, state,
        acknowledged_at
      ) VALUES (
        'upgrade-baseline-kb', 'upgrade-search-projection', 'opensearch',
        'upgrade-document', 'file', 'upgrade-source',
        'upgrade-source-revision', ${"9".repeat(64)}, 'active',
        '2026-08-25T10:22:22.507Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        target_kind, target_public_id, created_at, updated_at, completed_at
      ) VALUES
        ('upgrade-operation', 'upgrade-baseline-kb', 'source_delete', 'failed',
         'source_file', 'upgrade-source', '2026-08-26T04:14:45.000Z',
         '2026-08-26T04:14:47.000Z', '2026-08-26T04:14:47.000Z'),
        ('upgrade-stale-operation', 'upgrade-baseline-kb', 'source_delete',
         'failed', 'source_file', 'upgrade-stale-source',
         '2026-08-26T04:14:45.000Z', '2026-08-26T04:14:47.000Z',
         '2026-08-26T04:14:47.000Z')
    `;
    await sql.begin(async (transaction) => {
      await transaction`SET LOCAL session_replication_role = replica`;
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
        ) VALUES
          ('upgrade-document-job', 'upgrade-baseline-kb',
           'upgrade-operation', 'upgrade-source', 'upgrade-source-revision',
           'upgrade-settings', 'upgrade-model', 1, 'upgrade-embedding',
           'upgrade-semantic', 'upgrade-contract', 11955, 'error', 1, 1, 1,
           3, 2, 0, 'knowledge_projection',
           'publication_active_base_changed', true,
           '2026-08-26T04:14:45.000Z', '2026-08-26T04:14:45.000Z',
           '2026-08-26T04:14:47.000Z', '2026-08-26T04:14:45.000Z',
           '2026-08-26T04:14:47.000Z'),
          ('upgrade-stale-document-job', 'upgrade-baseline-kb',
           'upgrade-stale-operation', 'upgrade-stale-source',
           'upgrade-stale-source-revision', 'upgrade-settings',
           'upgrade-model', 1,
           'upgrade-embedding', 'upgrade-semantic', 'upgrade-contract', 11956,
           'error', 1, 1, 1, 3, 2, 0, 'knowledge_projection',
           'publication_active_base_changed', true,
           '2026-08-26T04:14:45.000Z', '2026-08-26T04:14:45.000Z',
           '2026-08-26T04:14:47.000Z', '2026-08-26T04:14:45.000Z',
           '2026-08-26T04:14:47.000Z')
      `;
    });
    await sql`
      INSERT INTO focowiki.document_artifact_work (
        public_id, knowledge_base_id, document_job_public_id,
        source_file_public_id, source_revision_public_id, work_kind,
        resource_lane, input_fingerprint_sha256, state, attempt_count,
        maximum_attempts, next_eligible_at, safe_error_code, retryable,
        started_at, ended_at, created_at, updated_at
      ) VALUES
        ('upgrade-projection-work', 'upgrade-baseline-kb',
         'upgrade-document-job', 'upgrade-source', 'upgrade-source-revision',
         'knowledge_projection', 'projection', ${"2".repeat(64)}, 'error', 1,
         3, '2026-08-26T04:14:47.000Z',
         'publication_active_base_changed', true,
         '2026-08-26T04:14:46.000Z', '2026-08-26T04:14:47.000Z',
         '2026-08-26T04:14:45.000Z', '2026-08-26T04:14:47.000Z'),
        ('upgrade-activation-work', 'upgrade-baseline-kb',
         'upgrade-document-job', 'upgrade-source', 'upgrade-source-revision',
         'activate', 'activation', ${"3".repeat(64)}, 'waiting', 0, 3,
         '2026-08-26T04:14:46.000Z', NULL, false, NULL, NULL,
         '2026-08-26T04:14:45.000Z', '2026-08-26T04:14:45.000Z'),
        ('upgrade-stale-projection-work', 'upgrade-baseline-kb',
         'upgrade-stale-document-job', 'upgrade-stale-source',
         'upgrade-stale-source-revision', 'knowledge_projection', 'projection',
         ${"4".repeat(64)}, 'error', 1, 3,
         '2026-08-26T04:14:47.000Z',
         'publication_active_base_changed', true,
         '2026-08-26T04:14:46.000Z', '2026-08-26T04:14:47.000Z',
         '2026-08-26T04:14:45.000Z', '2026-08-26T04:14:47.000Z')
    `;
    await sql`
      INSERT INTO focowiki.publication_items (
        public_id, mutation_public_id, knowledge_base_id,
        document_job_public_id, source_file_public_id,
        source_revision_public_id, operation, prior_logical_path,
        next_logical_path, readiness_sequence, outcome, safe_error_code,
        created_at, terminal_at, updated_at
      ) VALUES
        ('upgrade-failed-publication-item', 'upgrade-mutation',
         'upgrade-baseline-kb', 'upgrade-document-job', 'upgrade-source',
         'upgrade-source-revision', 'delete', 'upgrade.md', NULL, 11955,
         'failed', 'publication_active_base_changed',
         '2026-08-26T04:14:46.000Z', '2026-08-26T04:14:47.000Z',
         '2026-08-26T04:14:47.000Z'),
        ('upgrade-stale-publication-item', 'upgrade-stale-mutation',
         'upgrade-baseline-kb', 'upgrade-stale-document-job',
         'upgrade-stale-source', 'upgrade-stale-source-revision', 'delete',
         'stale.md', NULL, 11956, 'failed',
         'publication_active_base_changed',
         '2026-08-26T04:14:46.500Z', '2026-08-26T04:14:47.000Z',
         '2026-08-26T04:14:47.000Z')
    `;
    await sql`
      INSERT INTO focowiki.publication_jobs (
        public_id, knowledge_base_id, base_active_revision,
        target_readiness_sequence, renderer_contract_version,
        outcome, attempt_count, next_eligible_at, safe_error_code,
        created_at, updated_at, completed_at
      ) VALUES
        ('upgrade-failed-publication-job', 'upgrade-baseline-kb', 971, 11955,
         'portable-okf-v5', 'failed', 1, '2026-08-26T04:14:47.000Z',
         'publication_active_base_changed', '2026-08-26T04:14:46.000Z',
         '2026-08-26T04:14:47.000Z', '2026-08-26T04:14:47.000Z'),
        ('upgrade-stale-publication-job', 'upgrade-baseline-kb', 970, 11956,
         'portable-okf-v5', 'failed', 1, '2026-08-26T04:14:47.000Z',
         'publication_active_base_changed', '2026-08-26T04:14:46.500Z',
         '2026-08-26T04:14:47.000Z', '2026-08-26T04:14:47.000Z')
    `;
    await sql`
      INSERT INTO focowiki.operation_results (
        public_id, knowledge_base_id, operation_kind, terminal_state,
        result_code, result_summary, correlation_public_id,
        completed_at, expires_at
      ) VALUES
        ('upgrade-operation', 'upgrade-baseline-kb', 'source_delete', 'failed',
         'publication_active_base_changed', '{}'::jsonb,
         'upgrade-document-job', '2026-08-26T04:14:47.000Z',
         '2026-09-25T04:14:47.000Z'),
        ('upgrade-stale-operation', 'upgrade-baseline-kb', 'source_delete',
         'failed', 'publication_active_base_changed', '{}'::jsonb,
         'upgrade-stale-document-job', '2026-08-26T04:14:47.000Z',
         '2026-09-25T04:14:47.000Z')
    `;
    await sql`
      INSERT INTO focowiki.publication_job_items (
        job_public_id, item_public_id, membership_order, created_at
      ) VALUES
        ('upgrade-failed-publication-job',
         'upgrade-failed-publication-item', 0,
         '2026-08-26T04:14:46.000Z'),
        ('upgrade-stale-publication-job',
         'upgrade-stale-publication-item', 0,
         '2026-08-26T04:14:46.500Z')
    `;
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

function deleteOutput(normalizedPath: string, fingerprintDigit: string) {
  return {
    normalizedPath,
    logicalPath: normalizedPath,
    action: "delete" as const,
    entryKind: null,
    sourceFilePublicId: null,
    sourceRevisionPublicId: null,
    objectId: null,
    checksumSha256: null,
    byteCount: null,
    contentType: null,
    producerFingerprintSha256: fingerprintDigit.repeat(64),
    navigationMutations: []
  };
}
