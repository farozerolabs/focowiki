import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { DOCUMENT_PUBLICATION_RENDERER_CONTRACT_VERSION } from
  "../src/document-indexing/application/document-publication-renderer-contract.js";
import { fingerprintDocumentPublicationOutputs } from
  "../src/document-indexing/application/document-publication-manifest.js";
import { createPostgresDocumentPublicationActivation } from
  "../src/document-indexing/infrastructure/postgres-document-publication-activation.js";
import { createPostgresDocumentPublicationJobRepository } from
  "../src/document-indexing/infrastructure/postgres-document-publication-job-repository.js";
import { MIGRATION_FILES, readMigrationSql } from "../src/db/migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));
const FOUNDATION_MIGRATION = "013_single_job_publication_foundation.sql";
const foundationIndex = MIGRATION_FILES.indexOf(FOUNDATION_MIGRATION);

(enabled ? describe : describe.skip)("single-job legacy recovery", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_single_legacy_recovery_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(withDatabase(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(withDatabase(connectionUrl, databaseName), { max: 8 });
  const database = sql as unknown as DatabaseClient;
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quote(databaseName)}`);
    databaseCreated = true;
    for (const file of MIGRATION_FILES.slice(0, foundationIndex)) {
      await sql.unsafe(readMigrationSql(file));
    }
    await seedEighteenStrandedDocuments();
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(databaseName)} WITH (FORCE)`);
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("migrates and activates 18 stranded facts without provider replay",
    async () => {
      const before = await readProviderEvidence();
      expect(before).toEqual({ modelRequests: "36", searchReceipts: "90" });
      await sql.unsafe(readMigrationSql(FOUNDATION_MIGRATION));
      await expect(sql<Array<{ count: number | string }>>`
        SELECT count(*) AS count
        FROM focowiki.publication_items
        WHERE knowledge_base_id = 'legacy-stuck-18-kb'
          AND outcome = 'pending'
      `).resolves.toEqual([{ count: "18" }]);

      const repository = createPostgresDocumentPublicationJobRepository(database);
      const job = await repository.admitOne({
        now: "2026-08-25T20:00:02.000Z",
        rendererContractVersion: DOCUMENT_PUBLICATION_RENDERER_CONTRACT_VERSION
      });
      expect(job?.knowledgeBaseId).toBe("legacy-stuck-18-kb");
      expect(job?.items).toHaveLength(18);
      const claimed = await repository.claimOne({
        workerId: "legacy-recovery-worker",
        now: "2026-08-25T20:00:03.000Z"
      });
      expect(claimed?.publicId).toBe(job?.publicId);
      const output = [{
        normalizedPath: "index.md",
        logicalPath: "index.md",
        action: "put" as const,
        entryKind: "root-index",
        sourceFilePublicId: null,
        sourceRevisionPublicId: null,
        objectId: "legacy-recovery-output-object",
        checksumSha256: "2".repeat(64),
        byteCount: 20,
        contentType: "text/markdown; charset=utf-8",
        producerFingerprintSha256: "3".repeat(64),
        navigationMutations: []
      }];
      await expect(repository.persistManifest({
        jobPublicId: claimed!.publicId,
        attemptToken: claimed!.attemptToken!,
        fingerprintSha256: fingerprintDocumentPublicationOutputs(output),
        outputs: output,
        persistedAt: "2026-08-25T20:00:04.000Z"
      })).resolves.toBe(true);
      const activation = createPostgresDocumentPublicationActivation({
        sql: database
      });
      await expect(activation.activate({
        jobPublicId: claimed!.publicId,
        attemptToken: claimed!.attemptToken!,
        activatedAt: "2026-08-25T20:00:05.000Z"
      })).resolves.toMatchObject({
        knowledgeBaseId: "legacy-stuck-18-kb",
        activeRevision: 1,
        documentCount: 18
      });
      await expect(sql<Array<{
        available_count: number | string;
        committed_item_count: number | string;
        stranded_error_count: number | string;
      }>>`
        SELECT
          (SELECT count(*) FROM focowiki.document_processing_jobs
           WHERE knowledge_base_id = 'legacy-stuck-18-kb'
             AND state = 'available') AS available_count,
          (SELECT count(*) FROM focowiki.publication_items
           WHERE knowledge_base_id = 'legacy-stuck-18-kb'
             AND outcome = 'committed') AS committed_item_count,
          (SELECT count(*) FROM focowiki.diagnostic_events
           WHERE knowledge_base_id = 'legacy-stuck-18-kb'
             AND event_code = 'publication_stranded_plan_documents_missing')
             AS stranded_error_count
      `).resolves.toEqual([{
        available_count: "18",
        committed_item_count: "18",
        stranded_error_count: "0"
      }]);
      await expect(readProviderEvidence()).resolves.toEqual(before);
    }, 120_000);

  async function readProviderEvidence() {
    const rows = await sql<Array<{
      model_requests: number | string;
      search_receipts: number | string;
    }>>`
      SELECT
        (SELECT coalesce(sum(provider_request_count), 0)
         FROM focowiki.document_model_layer_executions
         WHERE knowledge_base_id = 'legacy-stuck-18-kb') AS model_requests,
        (SELECT count(*) FROM focowiki.search_family_receipts
         WHERE knowledge_base_id = 'legacy-stuck-18-kb') AS search_receipts
    `;
    return {
      modelRequests: String(rows[0]?.model_requests),
      searchReceipts: String(rows[0]?.search_receipts)
    };
  }

  async function seedEighteenStrandedDocuments(): Promise<void> {
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('legacy-stuck-18-kb', 'Legacy stuck 18', 1)
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_sequences (
        knowledge_base_id, current_sequence
      ) VALUES ('legacy-stuck-18-kb', 0)
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_projection_heads (
        knowledge_base_id, active_fact_epoch, head_version
      ) VALUES ('legacy-stuck-18-kb', 0, 0)
    `;
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES
        ('legacy-recovery-source-object', 'objects/legacy-recovery-source',
         ${"1".repeat(64)}, 10, 'text/markdown; charset=utf-8',
         'source-markdown-v1', 'verified', 'legacy-recovery-source-attempt',
         '2026-08-25T19:59:00.000Z'),
        ('legacy-recovery-output-object', 'objects/legacy-recovery-output',
         ${"2".repeat(64)}, 20, 'text/markdown; charset=utf-8',
         'okf-generated-markdown-v1', 'verified',
         'legacy-recovery-output-attempt', '2026-08-25T19:59:00.000Z')
    `;
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        target_kind, target_public_id, created_at, updated_at
      )
      SELECT 'legacy-recovery-operation-' || sequence,
             'legacy-stuck-18-kb', 'source_replace', 'processing',
             'source_file', 'legacy-recovery-source-' || sequence,
             '2026-08-25T20:00:00.000Z'::timestamptz,
             '2026-08-25T20:00:00.000Z'::timestamptz
      FROM generate_series(1, 18) sequence
    `;
    await sql`
      INSERT INTO focowiki.source_files (
        public_id, knowledge_base_id, logical_path, normalized_path,
        title, metadata, revision, created_at, updated_at
      )
      SELECT 'legacy-recovery-source-' || sequence, 'legacy-stuck-18-kb',
             'documents/' || lpad(sequence::text, 2, '0') || '.md',
             'documents/' || lpad(sequence::text, 2, '0') || '.md',
             'Legacy ' || sequence, '{}'::jsonb, 1,
             '2026-08-25T20:00:00.000Z'::timestamptz,
             '2026-08-25T20:00:00.000Z'::timestamptz
      FROM generate_series(1, 18) sequence
    `;
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type, created_at
      )
      SELECT 'legacy-recovery-revision-' || sequence, 'legacy-stuck-18-kb',
             'legacy-recovery-source-' || sequence,
             'legacy-recovery-source-object', ${"1".repeat(64)}, 10,
             'text/markdown; charset=utf-8',
             '2026-08-25T20:00:00.000Z'::timestamptz
      FROM generate_series(1, 18) sequence
    `;
    await sql`
      INSERT INTO focowiki.source_revision_presentations (
        knowledge_base_id, source_file_public_id, source_revision_public_id,
        logical_path, normalized_path, title, metadata, created_at
      )
      SELECT 'legacy-stuck-18-kb', 'legacy-recovery-source-' || sequence,
             'legacy-recovery-revision-' || sequence,
             'documents/' || lpad(sequence::text, 2, '0') || '.md',
             'documents/' || lpad(sequence::text, 2, '0') || '.md',
             'Legacy ' || sequence, '{}'::jsonb,
             '2026-08-25T20:00:00.000Z'::timestamptz
      FROM generate_series(1, 18) sequence
    `;
    await sql`
      INSERT INTO focowiki.source_file_active_revisions (
        knowledge_base_id, source_file_public_id,
        current_source_revision_public_id, active_source_revision_public_id,
        activation_sequence, updated_at
      )
      SELECT 'legacy-stuck-18-kb', 'legacy-recovery-source-' || sequence,
             'legacy-recovery-revision-' || sequence,
             'legacy-recovery-revision-' || sequence, 0,
             '2026-08-25T20:00:00.000Z'::timestamptz
      FROM generate_series(1, 18) sequence
    `;
    await sql`
      INSERT INTO focowiki.document_projection_records (
        knowledge_base_id, source_file_public_id, source_revision_public_id,
        logical_path, normalized_path, title, summary, metadata, headings,
        entities, content_type, checksum_sha256, byte_count,
        tokenizer_contract_version, navigation_term_fingerprint_sha256,
        active, created_at
      )
      SELECT 'legacy-stuck-18-kb', 'legacy-recovery-source-' || sequence,
             'legacy-recovery-revision-' || sequence,
             'documents/' || lpad(sequence::text, 2, '0') || '.md',
             'documents/' || lpad(sequence::text, 2, '0') || '.md',
             'Legacy ' || sequence, 'Legacy summary', '{}'::jsonb,
             '{}'::text[], '{}'::text[], 'text/markdown; charset=utf-8',
             ${"1".repeat(64)}, 10, 'tokenizer-v1', ${"4".repeat(64)},
             true, '2026-08-25T20:00:00.000Z'::timestamptz
      FROM generate_series(1, 18) sequence
    `;
    await sql.begin(async (rawTransaction) => {
      const transaction = rawTransaction as unknown as typeof sql;
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
          state, maximum_attempts, required_work_count,
          completed_work_count, blocking_work_kind,
          accepted_at, started_at, created_at, updated_at
        )
        SELECT 'legacy-recovery-job-' || sequence, 'legacy-stuck-18-kb',
               'legacy-recovery-operation-' || sequence,
               'legacy-recovery-source-' || sequence,
               'legacy-recovery-revision-' || sequence, 'legacy-settings',
               'legacy-model', 1, 'legacy-embedding', 'legacy-semantic',
               'legacy-contract', 'processing', 3, 8, 6,
               'knowledge_projection',
               '2026-08-25T20:00:00.000Z'::timestamptz,
               '2026-08-25T20:00:00.000Z'::timestamptz,
               '2026-08-25T20:00:00.000Z'::timestamptz,
               '2026-08-25T20:00:00.000Z'::timestamptz
        FROM generate_series(1, 18) sequence
      `;
    });
    await sql`
      INSERT INTO focowiki.document_artifact_work (
        public_id, knowledge_base_id, document_job_public_id,
        source_file_public_id, source_revision_public_id, work_kind,
        resource_lane, input_fingerprint_sha256, state, maximum_attempts,
        next_eligible_at, created_at, updated_at
      )
      SELECT 'legacy-recovery-work-' || work_kind || '-' || sequence,
             'legacy-stuck-18-kb', 'legacy-recovery-job-' || sequence,
             'legacy-recovery-source-' || sequence,
             'legacy-recovery-revision-' || sequence, work_kind, 'database',
             ${"5".repeat(64)}, state, 3,
             '2026-08-25T20:00:00.000Z'::timestamptz,
             '2026-08-25T20:00:00.000Z'::timestamptz,
             '2026-08-25T20:00:00.000Z'::timestamptz
      FROM generate_series(1, 18) sequence
      CROSS JOIN (VALUES
        ('knowledge_projection'::text, 'waiting_on_projection'::text),
        ('activate'::text, 'waiting'::text)
      ) work(work_kind, state)
    `;
    await sql`
      INSERT INTO focowiki.document_model_layer_executions (
        public_id, knowledge_base_id, document_job_public_id,
        source_revision_public_id, layer, execution_identity_sha256,
        status, model_name, selected, reused, provider_request_count,
        provider_observations, wait_time_milliseconds,
        service_time_milliseconds, warning_count, started_at, ended_at
      )
      SELECT 'legacy-recovery-model-' || layer || '-' || sequence,
             'legacy-stuck-18-kb', 'legacy-recovery-job-' || sequence,
             'legacy-recovery-revision-' || sequence, layer,
             ${"6".repeat(64)}, 'completed', 'legacy-model', true, false, 1,
             '[]'::jsonb, 0, 1, 0,
             '2026-08-25T19:59:58.000Z'::timestamptz,
             '2026-08-25T19:59:59.000Z'::timestamptz
      FROM generate_series(1, 18) sequence
      CROSS JOIN unnest(ARRAY['first_layer', 'graphrag']::text[]) layer
    `;
    await sql`
      INSERT INTO focowiki.search_family_receipts (
        public_id, knowledge_base_id, source_file_public_id,
        source_revision_public_id, provider_kind, family,
        input_fingerprint_sha256, provider_document_ids,
        state, acknowledged_at, active, created_at
      )
      SELECT 'legacy-recovery-search-' || family || '-' || sequence,
             'legacy-stuck-18-kb', 'legacy-recovery-source-' || sequence,
             'legacy-recovery-revision-' || sequence, 'opensearch', family,
             ${"7".repeat(64)}, ARRAY['provider-document-' || sequence],
             'acknowledged', '2026-08-25T19:59:59.000Z'::timestamptz,
             true, '2026-08-25T19:59:59.000Z'::timestamptz
      FROM generate_series(1, 18) sequence
      CROSS JOIN unnest(ARRAY[
        'content_metadata', 'content_segments_vectors',
        'semantic_seed_vectors', 'relation_evidence', 'graph_seed'
      ]::text[]) family
    `;
    await sql`
      INSERT INTO focowiki.projection_fact_epochs (
        knowledge_base_id, fact_epoch, mutation_public_id,
        source_file_public_id, source_revision_public_id, fact_kind,
        state, created_at
      )
      SELECT 'legacy-stuck-18-kb', sequence,
             'legacy-recovery-mutation-' || sequence,
             'legacy-recovery-source-' || sequence,
             'legacy-recovery-revision-' || sequence,
             'repair', 'ready',
             '2026-08-25T20:00:00.000Z'::timestamptz
               + sequence * interval '1 millisecond'
      FROM generate_series(1, 18) sequence
    `;
    await sql`
      INSERT INTO focowiki.projection_publication_generations (
        public_id, knowledge_base_id, target_fact_epoch,
        renderer_contract_version, deterministic_changed_at, state,
        input_fingerprint_sha256, created_at, updated_at
      ) VALUES (
        'legacy-recovery-generation', 'legacy-stuck-18-kb', 18,
        'portable-okf-v2', '2026-08-25T20:00:00.000Z', 'planned',
        ${"8".repeat(64)}, '2026-08-25T20:00:00.000Z',
        '2026-08-25T20:00:00.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.projection_generation_documents (
        generation_public_id, mutation_public_id,
        document_job_public_id, source_file_public_id,
        source_revision_public_id, fact_epoch, created_at
      )
      SELECT 'legacy-recovery-generation',
             'legacy-recovery-mutation-' || sequence,
             'legacy-recovery-job-' || sequence,
             'legacy-recovery-source-' || sequence,
             'legacy-recovery-revision-' || sequence, sequence,
             '2026-08-25T20:00:00.000Z'::timestamptz
      FROM generate_series(1, 18) sequence
    `;
  }
});

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
