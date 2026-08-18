import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { ensurePostgresDocumentCleanupIntent } from
  "../src/document-indexing/infrastructure/postgres-document-cleanup-intent.js";
import { createPostgresDocumentObsoleteCleanup } from
  "../src/document-indexing/infrastructure/postgres-document-obsolete-cleanup.js";
import { removeProductionDocumentObsoleteArtifact } from
  "../src/document-indexing/infrastructure/production-obsolete-artifact-removal.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("document cleanup intent PostgreSQL", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_cleanup_intent_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(withDatabase(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(withDatabase(connectionUrl, databaseName), { max: 2 });
  let created = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quote(databaseName)}`);
    created = true;
    await applyStorageVnextTestMigrations(sql);
    await seed(sql);
    await seedGeneratedCandidates(sql);
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (created) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(databaseName)} WITH (FORCE)`);
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("creates one exact idempotent action for an obsolete provider owner", async () => {
    const request = {
      transaction: sql as unknown as DatabaseClient,
      knowledgeBaseId: "kb-cleanup",
      documentJobPublicId: "job-cleanup",
      operationPublicId: "operation-cleanup",
      sourceFilePublicId: "source-cleanup",
      sourceRevisionPublicId: "revision-cleanup-new",
      affectedSourceFilePublicIds: ["source-cleanup"],
      createdAt: "2026-08-15T14:00:00.000Z"
    };
    const first = await ensurePostgresDocumentCleanupIntent(request);
    const second = await ensurePostgresDocumentCleanupIntent(request);
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);

    await seedSecondDocumentJob(sql);
    await expect(ensurePostgresDocumentCleanupIntent({
      ...request,
      documentJobPublicId: "job-cleanup-second",
      operationPublicId: "operation-cleanup-second",
      sourceFilePublicId: "source-cleanup-second",
      sourceRevisionPublicId: "revision-cleanup-second",
      affectedSourceFilePublicIds: ["source-cleanup"]
    })).resolves.toEqual(first);
    await expect(sql<Array<{
      cleanup_plane: string;
      resource_kind: string;
      resource_public_id: string;
      state: string;
    }>>`
      SELECT cleanup_plane, resource_kind, resource_public_id, state
      FROM focowiki.cleanup_actions
      WHERE document_job_public_id = 'job-cleanup'
    `).resolves.toEqual([{
      cleanup_plane: "search",
      resource_kind: "search_document",
      resource_public_id: "search-document-old",
      state: "queued"
    }]);

    await sql`
      INSERT INTO focowiki.search_document_owners (
        knowledge_base_id, search_projection_public_id, provider_kind,
        provider_document_id, document_kind, source_file_public_id,
        source_revision_public_id, document_checksum_sha256, state,
        acknowledged_at
      ) VALUES (
        'kb-cleanup', 'search-cleanup', 'opensearch', 'search-document-old',
        'file', 'source-cleanup', 'revision-cleanup-new', ${"1".repeat(64)},
        'active', now()
      )
    `;
    const cleanup = createPostgresDocumentObsoleteCleanup(
      sql as unknown as DatabaseClient
    );
    await expect(cleanup.actions.claim({
      owner: "cleanup-owner-other-provider",
      searchProviderKind: "meilisearch",
      limit: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    })).resolves.toEqual([]);
    const [claimed] = await cleanup.actions.claim({
      owner: "cleanup-owner-test",
      searchProviderKind: "opensearch",
      limit: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    expect(claimed).toMatchObject({ resourcePublicId: "search-document-old" });
    await expect(cleanup.ownership.isCurrentOwner(claimed!)).resolves.toBe(true);

    await sql`
      UPDATE focowiki.cleanup_actions
      SET lease_expires_at = now() - interval '1 second'
      WHERE public_id = ${claimed!.publicId}
    `;
    const [reclaimed] = await cleanup.actions.claim({
      owner: "cleanup-owner-recovery",
      searchProviderKind: "opensearch",
      limit: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    expect(reclaimed).toMatchObject({
      publicId: claimed!.publicId,
      resourcePublicId: "search-document-old",
      attempt: 2
    });
  });

  it("never schedules or removes a staged candidate owned by pending work", async () => {
    const actions = await ensurePostgresDocumentCleanupIntent({
      transaction: sql as unknown as DatabaseClient,
      knowledgeBaseId: "kb-cleanup",
      documentJobPublicId: "job-cleanup-candidate",
      operationPublicId: "operation-cleanup-candidate",
      sourceFilePublicId: "source-cleanup-candidate",
      sourceRevisionPublicId: "revision-cleanup-candidate",
      affectedSourceFilePublicIds: ["source-cleanup-candidate"],
      createdAt: "2026-08-15T14:01:00.000Z"
    });
    expect(actions).toHaveLength(1);
    const [action] = await sql<Array<{
      public_id: string;
      resource_public_id: string;
      source_revision_public_id: string;
    }>>`
      SELECT public_id, resource_public_id, source_revision_public_id
      FROM focowiki.cleanup_actions
      WHERE document_job_public_id = 'job-cleanup-candidate'
    `;
    expect(action).toMatchObject({
      resource_public_id: "object-cleanup-candidate",
      source_revision_public_id: "revision-cleanup-candidate"
    });

    const deleteZeroOwner = vi.fn(async () => undefined);
    await removeProductionDocumentObsoleteArtifact({
      sql: sql as unknown as DatabaseClient,
      config: {} as never,
      search: null,
      objectDeletion: { deleteZeroOwner } as never,
      action: {
        publicId: action!.public_id,
        knowledgeBaseId: "kb-cleanup",
        sourceRevisionPublicId: "revision-cleanup-candidate",
        searchProviderKind: null,
        plane: "object_storage",
        resourceKind: "generated_object",
        resourcePublicId: "object-cleanup-candidate",
        attempt: 1,
        maximumAttempts: 8
      }
    });
    await expect(sql<Array<{ public_id: string; state: string }>>`
      SELECT public_id, state
      FROM focowiki.generated_page_candidates
      WHERE object_id = 'object-cleanup-candidate'
      ORDER BY public_id
    `).resolves.toEqual([{
      public_id: "candidate-cleanup-staged",
      state: "staged"
    }]);
    expect(deleteZeroOwner).toHaveBeenCalledWith("object-cleanup-candidate");
  });
});

async function seedGeneratedCandidates(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO focowiki.object_registrations (
      object_id, storage_key, checksum_sha256, byte_count, content_type,
      object_format, state, write_attempt_public_id, verified_at
    ) VALUES (
      'object-cleanup-candidate', 'cleanup/candidate.md', ${"5".repeat(64)}, 1,
      'text/markdown; charset=utf-8', 'generated_markdown', 'verified',
      'write-cleanup-candidate', now()
    )
  `;
  await sql`
    INSERT INTO focowiki.source_files (
      public_id, knowledge_base_id, logical_path, normalized_path,
      title, revision
    ) VALUES (
      'source-cleanup-candidate', 'kb-cleanup', 'candidate.md', 'candidate.md',
      'Candidate', 1
    )
  `;
  await sql`
    INSERT INTO focowiki.source_revisions (
      public_id, knowledge_base_id, source_file_public_id, object_id,
      checksum_sha256, byte_count, content_type
    ) VALUES (
      'revision-cleanup-candidate', 'kb-cleanup', 'source-cleanup-candidate',
      'object-cleanup-candidate', ${"5".repeat(64)}, 1,
      'text/markdown; charset=utf-8'
    )
  `;
  await sql`
    INSERT INTO focowiki.source_file_active_revisions (
      knowledge_base_id, source_file_public_id,
      current_source_revision_public_id, active_source_revision_public_id,
      activation_sequence
    ) VALUES (
      'kb-cleanup', 'source-cleanup-candidate', 'revision-cleanup-candidate',
      'revision-cleanup-candidate', 2
    )
  `;
  await sql`
    INSERT INTO focowiki.operations (
      public_id, knowledge_base_id, operation_kind, state
    ) VALUES (
      'operation-cleanup-candidate', 'kb-cleanup', 'source_processing',
      'processing'
    )
  `;
  await sql`
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
      'job-cleanup-candidate', 'kb-cleanup', 'operation-cleanup-candidate',
      'source-cleanup-candidate', 'revision-cleanup-candidate',
      'settings-cleanup', 'model-config-cleanup', 1,
      'embedding-revision-cleanup', 'semantic-generation-cleanup',
      'semantic-v1', 'waiting', 3, now()
    )
  `;
  await sql`
    INSERT INTO focowiki.document_artifact_work (
      public_id, knowledge_base_id, document_job_public_id,
      source_file_public_id, source_revision_public_id,
      work_kind, resource_lane, input_fingerprint_sha256,
      state, maximum_attempts, next_eligible_at
    ) VALUES (
      'work-cleanup-candidate', 'kb-cleanup', 'job-cleanup-candidate',
      'source-cleanup-candidate', 'revision-cleanup-candidate',
      'knowledge_projection', 'projection', ${"6".repeat(64)},
      'waiting_on_projection', 3, now()
    )
  `;
  await sql`
    INSERT INTO focowiki.generated_page_candidates (
      public_id, knowledge_base_id, source_work_public_id,
      source_revision_public_id, logical_path, normalized_path, entry_kind,
      source_file_public_id, object_id, checksum_sha256, byte_count,
      base_activation_revision, state
    ) VALUES
      (
        'candidate-cleanup-active', 'kb-cleanup', 'work-cleanup-candidate',
        'revision-cleanup-candidate', 'active.md', 'active.md', 'index',
        'source-cleanup-candidate', 'object-cleanup-candidate',
        ${"5".repeat(64)}, 1, 1, 'active'
      ),
      (
        'candidate-cleanup-staged', 'kb-cleanup', 'work-cleanup-candidate',
        'revision-cleanup-candidate', 'staged.md', 'staged.md', 'index',
        'source-cleanup-candidate', 'object-cleanup-candidate',
        ${"5".repeat(64)}, 1, 1, 'staged'
      )
  `;
}

async function seedSecondDocumentJob(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO focowiki.object_registrations (
      object_id, storage_key, checksum_sha256, byte_count, content_type,
      object_format, state, write_attempt_public_id, verified_at
    ) VALUES (
      'object-cleanup-second', 'cleanup/second.md', ${"4".repeat(64)}, 1,
      'text/markdown; charset=utf-8', 'source_markdown', 'verified',
      'write-cleanup-second', now()
    )
  `;
  await sql`
    INSERT INTO focowiki.source_files (
      public_id, knowledge_base_id, logical_path, normalized_path,
      title, revision
    ) VALUES (
      'source-cleanup-second', 'kb-cleanup', 'second.md', 'second.md',
      'Second', 1
    )
  `;
  await sql`
    INSERT INTO focowiki.source_revisions (
      public_id, knowledge_base_id, source_file_public_id, object_id,
      checksum_sha256, byte_count, content_type
    ) VALUES (
      'revision-cleanup-second', 'kb-cleanup', 'source-cleanup-second',
      'object-cleanup-second', ${"4".repeat(64)}, 1,
      'text/markdown; charset=utf-8'
    )
  `;
  await sql`
    INSERT INTO focowiki.source_file_active_revisions (
      knowledge_base_id, source_file_public_id,
      current_source_revision_public_id, active_source_revision_public_id,
      activation_sequence
    ) VALUES (
      'kb-cleanup', 'source-cleanup-second', 'revision-cleanup-second',
      'revision-cleanup-second', 2
    )
  `;
  await sql`
    INSERT INTO focowiki.operations (
      public_id, knowledge_base_id, operation_kind, state
    ) VALUES (
      'operation-cleanup-second', 'kb-cleanup', 'source_processing',
      'processing'
    )
  `;
  await sql`
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
      'job-cleanup-second', 'kb-cleanup', 'operation-cleanup-second',
      'source-cleanup-second', 'revision-cleanup-second', 'settings-cleanup',
      'model-config-cleanup', 1, 'embedding-revision-cleanup',
      'semantic-generation-cleanup', 'semantic-v1', 'waiting', 3, now()
    )
  `;
}

async function seed(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
    VALUES ('kb-cleanup', 'Cleanup', 1)
  `;
  await sql`
    INSERT INTO focowiki.knowledge_base_sequences (
      knowledge_base_id, current_sequence
    ) VALUES ('kb-cleanup', 2)
  `;
  await sql`
    INSERT INTO focowiki.runtime_setting_revisions (
      public_id, checksum_sha256, settings_values
    ) VALUES ('settings-cleanup', ${"a".repeat(64)}, '{}'::jsonb)
  `;
  await sql`
    INSERT INTO focowiki.source_files (
      public_id, knowledge_base_id, logical_path, normalized_path,
      title, revision
    ) VALUES ('source-cleanup', 'kb-cleanup', 'new.md', 'new.md', 'New', 2)
  `;
  for (const suffix of ["old", "new"] as const) {
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        ${`object-cleanup-${suffix}`}, ${`cleanup/${suffix}.md`},
        ${suffix === "old" ? "b".repeat(64) : "c".repeat(64)}, 1,
        'text/markdown; charset=utf-8', 'source_markdown', 'verified',
        ${`write-cleanup-${suffix}`}, now()
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type, retired_at
      ) VALUES (
        ${`revision-cleanup-${suffix}`}, 'kb-cleanup', 'source-cleanup',
        ${`object-cleanup-${suffix}`},
        ${suffix === "old" ? "b".repeat(64) : "c".repeat(64)}, 1,
        'text/markdown; charset=utf-8',
        ${suffix === "old" ? "2026-08-15T13:00:00.000Z" : null}
      )
    `;
  }
  await sql`
    INSERT INTO focowiki.source_file_active_revisions (
      knowledge_base_id, source_file_public_id,
      current_source_revision_public_id, active_source_revision_public_id,
      activation_sequence
    ) VALUES (
      'kb-cleanup', 'source-cleanup', 'revision-cleanup-new',
      'revision-cleanup-new', 2
    )
  `;
  await sql`
    INSERT INTO focowiki.operations (
      public_id, knowledge_base_id, operation_kind, state, completed_at
    ) VALUES
      ('operation-cleanup', 'kb-cleanup', 'source_processing', 'processing', NULL),
      ('operation-semantic-cleanup', 'kb-cleanup',
       'semantic_contract_bootstrap', 'completed', now())
  `;
  await sql`
    INSERT INTO focowiki.model_configs (
      public_id, provider, model, secret_reference, config, enabled, revision
    ) VALUES (
      'model-config-cleanup', 'openai-compatible', 'generation-model',
      'runtime/model-config-cleanup', '{}'::jsonb, true, 1
    )
  `;
  await sql`
    INSERT INTO focowiki.embedding_configurations (
      public_id, display_name, lifecycle_status, revision
    ) VALUES ('embedding-cleanup', 'Embedding', 'active', 1)
  `;
  await sql`
    INSERT INTO focowiki.embedding_configuration_revisions (
      public_id, configuration_public_id, revision_number, authentication_mode,
      base_url, model_name, requested_dimension, resolved_dimension,
      normalization, maximum_input_tokens, batch_size, timeout_ms, retry_count,
      minimum_interval_ms, concurrency, maximum_response_bytes,
      minimum_vector_relevance, vector_producing_revision_public_id,
      validation_status, validation_fingerprint_sha256, validated_at
    ) VALUES (
      'embedding-revision-cleanup', 'embedding-cleanup', 1, 'none',
      'http://embedding.local/v1', 'embedding-model', 3, 3, 'l2', 8192,
      16, 5000, 1, 0, 2, 1048576, 0.7, 'embedding-revision-cleanup',
      'valid', ${"2".repeat(64)}, now()
    )
  `;
  await sql`
    INSERT INTO focowiki.semantic_generations (
      public_id, knowledge_base_id, operation_public_id,
      expected_predecessor_public_id, generation_role, state,
      generation_model_configuration_public_id,
      generation_model_configuration_revision,
      extraction_contract_version, graph_schema_version,
      prompt_contract_version, contract_fingerprint_sha256,
      revision, activated_at
    ) VALUES (
      'semantic-generation-cleanup', 'kb-cleanup',
      'operation-semantic-cleanup', NULL, 'active', 'active',
      'model-config-cleanup', 1, 'extract-v1', 'graph-v1', 'prompt-v1',
      ${"3".repeat(64)}, 1, now()
    )
  `;
  await sql`
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
      'job-cleanup', 'kb-cleanup', 'operation-cleanup', 'source-cleanup',
      'revision-cleanup-new', 'settings-cleanup', 'model-config-cleanup', 1,
      'embedding-revision-cleanup', 'semantic-generation-cleanup', 'semantic-v1',
      'waiting', 3, now()
    )
  `;
  await sql`
    INSERT INTO focowiki.search_projections (
      public_id, knowledge_base_id, provider_kind, provider_index_uid,
      schema_checksum_sha256, settings_checksum_sha256, state
    ) VALUES (
      'search-cleanup', 'kb-cleanup', 'opensearch', 'cleanup-index',
      ${"d".repeat(64)}, ${"e".repeat(64)}, 'active'
    )
  `;
  await sql`
    INSERT INTO focowiki.search_document_owners (
      knowledge_base_id, search_projection_public_id, provider_kind,
      provider_document_id, document_kind, source_file_public_id,
      source_revision_public_id, document_checksum_sha256, state,
      acknowledged_at
    ) VALUES (
      'kb-cleanup', 'search-cleanup', 'opensearch', 'search-document-old',
      'file', 'source-cleanup', 'revision-cleanup-old', ${"f".repeat(64)},
      'obsolete', now()
    )
  `;
}

function withDatabase(value: string, databaseName: string): string {
  const url = new URL(value);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
