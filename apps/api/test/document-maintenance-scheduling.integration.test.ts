import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createPostgresDocumentMaintenance } from
  "../src/document-indexing/infrastructure/postgres-document-maintenance.js";
import { createDocumentSearchProjectionBootstrap } from
  "../src/document-indexing/domain/document-search-projection.js";
import { createPostgresKnowledgeBaseCreation } from
  "../src/storage-vnext/api/postgres-knowledge-base-creation.js";
import { createStorageVnextSearchSettings } from
  "../src/storage-vnext/search/settings.js";
import { createPostgresStorageVnextMaintenanceRepository } from
  "../src/storage-vnext/maintenance/postgres-repository.js";
import { createStorageVnextMaintenanceRequestService } from
  "../src/storage-vnext/maintenance/maintenance-coordinator.js";
import type { SemanticMaintenanceTarget } from
  "../src/semantic/domain/contracts.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("document maintenance scheduling PostgreSQL", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_document_maintenance_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 4 });
  const database = sql as unknown as DatabaseClient;
  const definition = createStorageVnextSearchSettings({ searchCutoffMs: 500 });
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
    await seedConfiguration();
    await createPostgresKnowledgeBaseCreation({
      sql: database,
      resolveSearchProjection: (knowledgeBaseId) =>
        createDocumentSearchProjectionBootstrap({
          knowledgeBaseId,
          providerKind: "opensearch",
          indexUidPrefix: "focowiki_test",
          definition
        }),
      resolveSemanticTarget: async (knowledgeBaseId) => target(knowledgeBaseId)
    }).create({
      publicId: "knowledge-base-maintenance",
      name: "Document maintenance",
      description: null
    });
    await seedActiveSource();
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
      );
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("schedules one revision-scoped job idempotently and restores it on cancellation", async () => {
    const repository = createPostgresStorageVnextMaintenanceRepository(database, {
      selectedSearchProviderKind: "opensearch"
    });
    const requests = createStorageVnextMaintenanceRequestService({
      repository,
      searchProviderKind: "opensearch"
    });
    const requestedAt = "2026-08-14T12:00:00.000Z";
    await requests.requestMaintenance({
      knowledgeBaseId: "knowledge-base-maintenance",
      operationPublicId: "maintenance-document-indexing",
      trigger: "manual",
      idempotencyKey: "maintenance-document-indexing",
      expectedResourceRevision: 1,
      settingsRevisionPublicId: "runtime-maintenance",
      requestedAt,
      expiresAt: "2099-08-15T12:00:00.000Z",
      maxAttempts: 3,
      semanticAdoption: null
    });
    const claim = await repository.claimOne({
      workerId: "worker-maintenance",
      leaseExpiresAt: "2026-08-14T12:05:00.000Z",
      searchProviderKind: "opensearch"
    });
    expect(claim).not.toBeNull();
    const runReconciliationPage = vi.fn().mockResolvedValue({
      processedCount: 1,
      nextCursor: null
    });
    const maintenance = createPostgresDocumentMaintenance({
      sql: database,
      providerKind: "opensearch",
      indexUidPrefix: "focowiki_test",
      searchDefinition: definition,
      pageSize: 10,
      reconciliationPageSize: 25,
      reconciliation: { runPage: runReconciliationPage }
    });
    const context = {
      knowledgeBaseId: "knowledge-base-maintenance",
      operationPublicId: "maintenance-document-indexing",
      checkpoint: claim!.checkpoint,
      signal: new AbortController().signal
    };

    await expect(maintenance.prepare(context)).resolves.toEqual({ documentCount: 1 });
    await expect(maintenance.schedulePage({ ...context, cursor: null }))
      .resolves.toMatchObject({ scheduledCount: 1, nextCursor: null });
    await expect(maintenance.schedulePage({ ...context, cursor: null }))
      .resolves.toMatchObject({ scheduledCount: 0, nextCursor: null });

    await expect(readScheduled()).resolves.toEqual([{
      source_revision_public_id: expect.stringMatching(/^source-revision-/u),
      state: "waiting",
      source_revision: "0",
      current_is_active: false,
      object_owner_count: "1"
    }]);

    await sql`
      INSERT INTO focowiki.cleanup_actions (
        public_id, knowledge_base_id, operation_public_id,
        action_kind, cleanup_plane, resource_kind, resource_public_id,
        required, priority, sequence_number, idempotency_key, request_hash,
        state, maximum_attempts, not_before
      ) VALUES (
        'cleanup-maintenance-pending', 'knowledge-base-maintenance',
        'maintenance-document-indexing', 'document_obsolete_artifact',
        'object_storage', 'object', 'object-maintenance-pending', true,
        100, 1, 'cleanup-maintenance-pending', ${"8".repeat(64)},
        'queued', 3, ${requestedAt}
      )
    `;
    await expect(maintenance.reconcile!({ ...context, cursor: null }))
      .resolves.toEqual({
        processedCount: 0,
        nextCursor: "awaiting-document-cleanup"
      });
    expect(runReconciliationPage).not.toHaveBeenCalled();
    await sql`
      UPDATE focowiki.cleanup_actions
      SET state = 'completed', completed_at = now(), updated_at = now()
      WHERE public_id = 'cleanup-maintenance-pending'
    `;
    await sql`
      INSERT INTO focowiki.cleanup_actions (
        public_id, knowledge_base_id, operation_public_id,
        action_kind, cleanup_plane, search_provider_kind,
        resource_kind, resource_public_id,
        required, priority, sequence_number, idempotency_key, request_hash,
        state, maximum_attempts, not_before
      ) VALUES (
        'cleanup-maintenance-other-provider', 'knowledge-base-maintenance',
        'maintenance-document-indexing', 'document_obsolete_artifact',
        'search', 'meilisearch', 'search_document',
        'search-document-other-provider', true, 100, 2,
        'cleanup-maintenance-other-provider', ${"7".repeat(64)},
        'failed', 3, ${requestedAt}
      )
    `;
    await expect(maintenance.reconcile!({
      ...context,
      cursor: "awaiting-document-cleanup"
    })).resolves.toEqual({ processedCount: 1, nextCursor: null });
    expect(runReconciliationPage).toHaveBeenCalledWith({
      knowledgeBaseId: "knowledge-base-maintenance",
      limit: 25,
      cursor: null
    });

    await maintenance.terminate({
      knowledgeBaseId: "knowledge-base-maintenance",
      operationPublicId: "maintenance-document-indexing",
      outcome: "superseded"
    });
    await expect(sql<Array<{
      current_source_revision_public_id: string;
      active_source_revision_public_id: string;
      state: string;
    }>>`
      SELECT active.current_source_revision_public_id,
             active.active_source_revision_public_id, job.state
      FROM focowiki.source_file_active_revisions active
      JOIN focowiki.document_processing_jobs job
        ON job.knowledge_base_id = active.knowledge_base_id
       AND job.source_file_public_id = active.source_file_public_id
      WHERE active.knowledge_base_id = 'knowledge-base-maintenance'
    `).resolves.toEqual([{
      current_source_revision_public_id: "source-revision-maintenance-old",
      active_source_revision_public_id: "source-revision-maintenance-old",
      state: "superseded"
    }]);
  });

  async function seedConfiguration(): Promise<void> {
    await sql`
      INSERT INTO focowiki.runtime_setting_revisions (
        public_id, checksum_sha256, settings_values
      ) VALUES ('runtime-maintenance', ${"1".repeat(64)}, '{}'::jsonb)
    `;
    await sql`
      INSERT INTO focowiki.model_configs (
        public_id, provider, model, secret_reference, config, enabled, revision
      ) VALUES (
        'model-maintenance', 'openai-compatible', 'test-model',
        'runtime/test-model', '{}'::jsonb, true, 1
      )
    `;
    await sql`
      INSERT INTO focowiki.embedding_configurations (
        public_id, display_name, lifecycle_status, revision
      ) VALUES ('embedding-maintenance', 'Test embedding', 'active', 1)
    `;
    await sql`
      INSERT INTO focowiki.embedding_configuration_revisions (
        public_id, configuration_public_id, revision_number,
        authentication_mode, base_url, encrypted_api_key, model_name,
        requested_dimension, resolved_dimension, normalization,
        maximum_input_tokens, batch_size, timeout_ms, retry_count,
        minimum_interval_ms, concurrency, maximum_response_bytes,
        vector_producing_revision_public_id,
        validation_status, validation_fingerprint_sha256, validated_at
      ) VALUES (
        'embedding-maintenance-revision', 'embedding-maintenance', 1,
        'none', 'http://127.0.0.1:8080/v1', NULL, 'test-embedding',
        8, 8, 'l2', 8192, 16, 5000, 1, 0, 2, 1048576,
        'embedding-maintenance-revision', 'valid', ${"2".repeat(64)}, now()
      )
    `;
    await sql`
      UPDATE focowiki.embedding_configurations
      SET active_revision_public_id = 'embedding-maintenance-revision'
      WHERE public_id = 'embedding-maintenance'
    `;
  }

  async function seedActiveSource(): Promise<void> {
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        'source-sha256:maintenance', 'sources/maintenance.md',
        ${"3".repeat(64)}, 10, 'text/markdown; charset=utf-8',
        'source-markdown-v1', 'verified', 'write-maintenance', now()
      )
    `;
    await sql`
      INSERT INTO focowiki.source_files (
        public_id, knowledge_base_id, logical_path, normalized_path,
        title, metadata, revision
      ) VALUES (
        'source-file-maintenance', 'knowledge-base-maintenance',
        'Maintenance.md', 'maintenance.md', 'Maintenance', '{}'::jsonb, 0
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type
      ) VALUES (
        'source-revision-maintenance-old', 'knowledge-base-maintenance',
        'source-file-maintenance', 'source-sha256:maintenance',
        ${"3".repeat(64)}, 10, 'text/markdown; charset=utf-8'
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revision_presentations (
        knowledge_base_id, source_file_public_id, source_revision_public_id,
        logical_path, normalized_path, title, metadata
      ) VALUES (
        'knowledge-base-maintenance', 'source-file-maintenance',
        'source-revision-maintenance-old', 'Maintenance.md',
        'maintenance.md', 'Maintenance', '{}'::jsonb
      )
    `;
    await sql`
      INSERT INTO focowiki.source_file_active_revisions (
        knowledge_base_id, source_file_public_id,
        current_source_revision_public_id, active_source_revision_public_id,
        activation_sequence
      ) VALUES (
        'knowledge-base-maintenance', 'source-file-maintenance',
        'source-revision-maintenance-old', 'source-revision-maintenance-old', 0
      )
    `;
    await sql`
      INSERT INTO focowiki.object_owners (
        public_id, knowledge_base_id, object_id, owner_kind,
        source_revision_public_id
      ) VALUES (
        'owner-maintenance-old', 'knowledge-base-maintenance',
        'source-sha256:maintenance', 'source_revision',
        'source-revision-maintenance-old'
      )
    `;
  }

  function readScheduled() {
    return sql<Array<{
      source_revision_public_id: string;
      state: string;
      source_revision: string;
      current_is_active: boolean;
      object_owner_count: string;
    }>>`
      SELECT job.source_revision_public_id, job.state,
             source.revision::text AS source_revision,
             active.current_source_revision_public_id
               = active.active_source_revision_public_id AS current_is_active,
             count(owner.public_id)::text AS object_owner_count
      FROM focowiki.document_processing_jobs job
      JOIN focowiki.source_files source
        ON source.knowledge_base_id = job.knowledge_base_id
       AND source.public_id = job.source_file_public_id
      JOIN focowiki.source_file_active_revisions active
        ON active.knowledge_base_id = job.knowledge_base_id
       AND active.source_file_public_id = job.source_file_public_id
      LEFT JOIN focowiki.object_owners owner
        ON owner.knowledge_base_id = job.knowledge_base_id
       AND owner.source_revision_public_id = job.source_revision_public_id
      WHERE job.operation_public_id = 'maintenance-document-indexing'
      GROUP BY job.source_revision_public_id, job.state,
               source.revision, active.current_source_revision_public_id,
               active.active_source_revision_public_id
    `;
  }
});

function target(knowledgeBaseId: string): SemanticMaintenanceTarget {
  return {
    knowledgeBaseId,
    generationModelConfigurationPublicId: "model-maintenance",
    generationModelConfigurationRevision: 1,
    extractionContractVersion: "extract-v1",
    graphSchemaVersion: "graph-v1",
    promptContractVersion: "prompt-v1",
    embeddingConfigurationRevisionPublicId: "embedding-maintenance-revision",
    resolvedDimension: 8,
    normalization: "l2",
    artifactSchemaVersion: "artifact-v1",
    vectorSchemaVersion: "vector-v1",
    searchProviderKind: "opensearch",
    mappingFingerprintSha256: "4".repeat(64)
  };
}

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
