import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { ensurePostgresDocumentCleanupIntent } from
  "../src/document-indexing/infrastructure/postgres-document-cleanup-intent.js";
import { createPostgresDocumentObsoleteCleanup } from
  "../src/document-indexing/infrastructure/postgres-document-obsolete-cleanup.js";
import { releasePostgresDocumentPageCandidates } from
  "../src/document-indexing/infrastructure/postgres-document-page-candidate-release.js";
import {
  createPostgresDocumentRevisionPurge,
  enqueuePostgresReplacedDocumentRevisionPurge
} from "../src/document-indexing/infrastructure/postgres-document-revision-purge.js";
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

  it("terminalizes exhausted cleanup actions instead of reclaiming them",
    async () => {
      const [target] = await sql<Array<{ public_id: string }>>`
        SELECT public_id
        FROM focowiki.cleanup_actions
        WHERE resource_public_id = 'search-document-old'
        ORDER BY public_id
        LIMIT 1
      `;
      expect(target).toBeDefined();
      await sql`
        UPDATE focowiki.cleanup_actions
        SET state = 'retry', attempt_count = maximum_attempts,
            not_before = now() - interval '1 second',
            lease_owner = NULL, lease_expires_at = NULL
        WHERE public_id = ${target!.public_id}
      `;
      const cleanup = createPostgresDocumentObsoleteCleanup(
        sql as unknown as DatabaseClient
      );

      await expect(cleanup.actions.claim({
        owner: "cleanup-owner-exhausted",
        searchProviderKind: "opensearch",
        limit: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
      })).resolves.toEqual([]);
      await expect(sql<Array<{
        state: string;
        attempt_count: number;
        maximum_attempts: number;
        safe_error_code: string | null;
      }>>`
        SELECT state, attempt_count, maximum_attempts, safe_error_code
        FROM focowiki.cleanup_actions
        WHERE public_id = ${target!.public_id}
      `).resolves.toEqual([{
        state: "failed",
        attempt_count: 8,
        maximum_attempts: 8,
        safe_error_code: "cleanup_attempts_exhausted"
      }]);
    });

  it("keeps the current head and releases terminal staged and superseded candidates", async () => {
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
    expect(actions).toEqual([]);

    await expect(releasePostgresDocumentPageCandidates({
      transaction: sql as unknown as DatabaseClient,
      knowledgeBaseId: "kb-cleanup",
      documentJobPublicId: "job-cleanup-candidate",
      operationPublicId: "operation-cleanup-candidate",
      retainedCandidatePublicIds: ["candidate-cleanup-current"],
      releasedAt: "2026-08-15T14:01:01.000Z"
    })).resolves.toEqual({
      releasedCandidateCount: 2,
      queuedObjectCount: 2
    });

    await expect(sql<Array<{ public_id: string; state: string }>>`
      SELECT public_id, state
      FROM focowiki.generated_page_candidates
      WHERE source_file_public_id = 'source-cleanup-candidate'
      ORDER BY public_id
    `).resolves.toEqual([{
      public_id: "candidate-cleanup-current",
      state: "active"
    }]);
    await expect(sql<Array<{ object_id: string }>>`
      SELECT owner.object_id
      FROM focowiki.object_owners owner
      JOIN focowiki.generated_page_candidates candidate
        ON candidate.public_id = owner.generated_page_candidate_public_id
      WHERE owner.owner_kind = 'generated_page_candidate'
        AND candidate.source_file_public_id = 'source-cleanup-candidate'
      ORDER BY owner.object_id
    `).resolves.toEqual([{
      object_id: "object-cleanup-current"
    }]);
    await expect(sql<Array<{
      resource_public_id: string;
      action_kind: string;
      state: string;
    }>>`
      SELECT resource_public_id, action_kind, state
      FROM focowiki.cleanup_actions
      WHERE document_job_public_id = 'job-cleanup-candidate'
      ORDER BY resource_public_id
    `).resolves.toEqual([
      {
        resource_public_id: "object-cleanup-page-old",
        action_kind: "zero_owner_object",
        state: "queued"
      },
      {
        resource_public_id: "object-cleanup-staged",
        action_kind: "zero_owner_object",
        state: "queued"
      }
    ]);
    await expect(releasePostgresDocumentPageCandidates({
      transaction: sql as unknown as DatabaseClient,
      knowledgeBaseId: "kb-cleanup",
      documentJobPublicId: "job-cleanup-candidate",
      operationPublicId: "operation-cleanup-candidate",
      retainedCandidatePublicIds: ["candidate-cleanup-current"],
      releasedAt: "2026-08-15T14:01:02.000Z"
    })).resolves.toEqual({
      releasedCandidateCount: 0,
      queuedObjectCount: 0
    });
  });

  it("purges a replaced revision and queues every orphaned object", async () => {
    await expect(enqueuePostgresReplacedDocumentRevisionPurge({
      transaction: sql as unknown as DatabaseClient,
      knowledgeBaseId: "kb-cleanup",
      operationPublicId: "operation-cleanup",
      documentJobPublicId: "job-cleanup",
      sourceRevisionPublicId: "revision-cleanup-old",
      createdAt: "2026-08-15T14:02:00.000Z"
    })).resolves.toBe(true);

    await sql`
      UPDATE focowiki.cleanup_actions
      SET state = 'running', attempt_count = 1,
          lease_owner = 'expired-revision-purge-owner',
          lease_expires_at = '2026-08-15T14:02:00.500Z',
          updated_at = '2026-08-15T14:02:00.000Z'
      WHERE action_kind = 'document_revision_purge'
        AND resource_public_id = 'revision-cleanup-old'
    `;

    const purge = createPostgresDocumentRevisionPurge(
      sql as unknown as DatabaseClient
    );
    await expect(purge.runBatch({
      owner: "revision-purge-owner-1",
      limit: 1,
      now: "2026-08-15T14:02:01.000Z",
      leaseExpiresAt: "2026-08-15T14:03:01.000Z"
    })).resolves.toEqual({ claimed: 1, completed: 0, retried: 1, failed: 0 });
    await sql`
      UPDATE focowiki.cleanup_actions
      SET state = 'completed', completed_at = '2026-08-15T14:02:02.000Z',
          updated_at = '2026-08-15T14:02:02.000Z'
      WHERE action_kind = 'document_obsolete_artifact'
        AND checkpoint->>'parentRevisionPurgeActionPublicId' IS NOT NULL
    `;
    await expect(purge.runBatch({
      owner: "revision-purge-owner-2",
      limit: 1,
      now: "2026-08-15T14:02:03.000Z",
      leaseExpiresAt: "2026-08-15T14:03:03.000Z"
    })).resolves.toEqual({ claimed: 1, completed: 0, retried: 1, failed: 0 });
    await expect(sql<Array<{ state: string; safe_error_code: string | null }>>`
      SELECT state, safe_error_code FROM focowiki.cleanup_actions
      WHERE action_kind = 'document_revision_purge'
        AND resource_public_id = 'revision-cleanup-old'
    `).resolves.toEqual([{
      state: "retry",
      safe_error_code: "DOCUMENT_REVISION_GENERATED_HEAD_ACTIVE"
    }]);
    await sql`
      UPDATE focowiki.generated_page_heads
      SET source_revision_public_id = 'revision-cleanup-new',
          page_candidate_public_id = 'candidate-cleanup-shared-current',
          object_id = 'object-cleanup-shared-current',
          checksum_sha256 = ${"0".repeat(64)}, byte_count = 3,
          activation_revision = 3,
          updated_at = '2026-08-15T14:02:04.000Z'
      WHERE knowledge_base_id = 'kb-cleanup'
        AND normalized_path = 'shared.md'
    `;
    await expect(purge.runBatch({
      owner: "revision-purge-owner-3",
      limit: 1,
      now: "2026-08-15T14:02:05.000Z",
      leaseExpiresAt: "2026-08-15T14:03:05.000Z"
    })).resolves.toEqual({ claimed: 1, completed: 0, retried: 1, failed: 0 });
    await sql`
      UPDATE focowiki.cleanup_actions
      SET state = 'completed', completed_at = '2026-08-15T14:02:06.000Z',
          updated_at = '2026-08-15T14:02:06.000Z'
      WHERE action_kind = 'document_obsolete_artifact'
        AND checkpoint->>'parentRevisionPurgeActionPublicId' IS NOT NULL
        AND state IN ('queued', 'retry')
    `;
    await expect(purge.runBatch({
      owner: "revision-purge-owner-4",
      limit: 1,
      now: "2026-08-15T14:02:07.000Z",
      leaseExpiresAt: "2026-08-15T14:03:07.000Z"
    })).resolves.toEqual({ claimed: 1, completed: 1, retried: 0, failed: 0 });

    await expect(sql<Array<{ count: number }>>`
      SELECT count(*)::integer AS count
      FROM focowiki.source_revisions
      WHERE public_id = 'revision-cleanup-old'
    `).resolves.toEqual([{ count: 0 }]);
    await expect(sql<Array<{
      resource_public_id: string;
      action_kind: string;
      state: string;
    }>>`
      SELECT resource_public_id, action_kind, state
      FROM focowiki.cleanup_actions
      WHERE action_kind = 'zero_owner_object'
        AND resource_public_id = 'object-cleanup-old'
    `).resolves.toEqual([{
      resource_public_id: "object-cleanup-old",
      action_kind: "zero_owner_object",
      state: "queued"
    }]);
    await expect(sql<Array<{ zero_owner_since: Date | null }>>`
      SELECT zero_owner_since
      FROM focowiki.object_registrations
      WHERE object_id = 'object-cleanup-old'
    `).resolves.toEqual([{
      zero_owner_since: new Date("2026-08-15T14:02:07.000Z")
    }]);
  });
});

async function seedGeneratedCandidates(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO focowiki.object_registrations (
      object_id, storage_key, checksum_sha256, byte_count, content_type,
      object_format, state, write_attempt_public_id, verified_at
    ) VALUES
      (
        'object-cleanup-source', 'cleanup/source.md', ${"5".repeat(64)}, 1,
        'text/markdown; charset=utf-8', 'source-markdown-v1', 'verified',
        'write-cleanup-source', now()
      ),
      (
        'object-cleanup-current', 'cleanup/current.md', ${"6".repeat(64)}, 1,
        'text/markdown; charset=utf-8', 'okf-generated-markdown-v1', 'verified',
        'write-cleanup-current', now()
      ),
      (
        'object-cleanup-page-old', 'cleanup/page-old.md', ${"7".repeat(64)}, 1,
        'text/markdown; charset=utf-8', 'okf-generated-markdown-v1', 'verified',
        'write-cleanup-page-old', now()
      ),
      (
        'object-cleanup-staged', 'cleanup/staged.md', ${"8".repeat(64)}, 1,
        'text/markdown; charset=utf-8', 'okf-generated-markdown-v1', 'verified',
        'write-cleanup-staged', now()
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
      'object-cleanup-source', ${"5".repeat(64)}, 1,
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
        'candidate-cleanup-current', 'kb-cleanup', 'work-cleanup-candidate',
        'revision-cleanup-candidate', 'current.md', 'current.md', 'index',
        'source-cleanup-candidate', 'object-cleanup-current',
        ${"6".repeat(64)}, 1, 1, 'active'
      ),
      (
        'candidate-cleanup-old', 'kb-cleanup', 'work-cleanup-candidate',
        'revision-cleanup-candidate', 'old.md', 'old.md', 'index',
        'source-cleanup-candidate', 'object-cleanup-page-old',
        ${"7".repeat(64)}, 1, 1, 'active'
      ),
      (
        'candidate-cleanup-staged', 'kb-cleanup', 'work-cleanup-candidate',
        'revision-cleanup-candidate', 'staged.md', 'staged.md', 'index',
        'source-cleanup-candidate', 'object-cleanup-staged',
        ${"8".repeat(64)}, 1, 1, 'staged'
      )
  `;
  await sql`
    INSERT INTO focowiki.object_owners (
      public_id, knowledge_base_id, object_id, owner_kind,
      generated_page_candidate_public_id
    ) VALUES
      (
        'owner-cleanup-current', 'kb-cleanup', 'object-cleanup-current',
        'generated_page_candidate', 'candidate-cleanup-current'
      ),
      (
        'owner-cleanup-old', 'kb-cleanup', 'object-cleanup-page-old',
        'generated_page_candidate', 'candidate-cleanup-old'
      ),
      (
        'owner-cleanup-staged', 'kb-cleanup', 'object-cleanup-staged',
        'generated_page_candidate', 'candidate-cleanup-staged'
      )
  `;
  await seedRevisionRehome(sql);
  await sql`
    INSERT INTO focowiki.generated_page_heads (
      knowledge_base_id, logical_path, normalized_path, entry_kind,
      source_file_public_id, source_revision_public_id,
      page_candidate_public_id, object_id, checksum_sha256, byte_count,
      activation_revision
    ) VALUES (
      'kb-cleanup', 'current.md', 'current.md', 'index',
      'source-cleanup-candidate', 'revision-cleanup-candidate',
      'candidate-cleanup-current', 'object-cleanup-current',
      ${"6".repeat(64)}, 1, 1
    )
  `;
}

async function seedRevisionRehome(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO focowiki.object_registrations (
      object_id, storage_key, checksum_sha256, byte_count, content_type,
      object_format, state, write_attempt_public_id, verified_at
    ) VALUES (
      'object-cleanup-shared-page', 'cleanup/shared.md', ${"9".repeat(64)}, 2,
      'text/markdown; charset=utf-8', 'okf-generated-markdown-v1', 'verified',
      'write-cleanup-shared-page', now()
    ), (
      'object-cleanup-shared-current', 'cleanup/shared-current.md',
      ${"0".repeat(64)}, 3, 'text/markdown; charset=utf-8',
      'okf-generated-markdown-v1', 'verified',
      'write-cleanup-shared-current', now()
    )
  `;
  await sql`
    INSERT INTO focowiki.operations (
      public_id, knowledge_base_id, operation_kind, state, completed_at
    ) VALUES (
      'operation-cleanup-old', 'kb-cleanup', 'source_replace', 'completed',
      '2026-08-15T13:00:00.000Z'
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
      state, maximum_attempts, accepted_at, started_at, terminal_at,
      created_at, updated_at
    ) VALUES (
      'job-cleanup-old', 'kb-cleanup', 'operation-cleanup-old',
      'source-cleanup', 'revision-cleanup-old', 'settings-cleanup',
      'model-config-cleanup', 1, 'embedding-revision-cleanup',
      'semantic-generation-cleanup', 'semantic-v1', 'available', 3,
      '2026-08-15T12:59:00.000Z', '2026-08-15T12:59:01.000Z',
      '2026-08-15T13:00:00.000Z', '2026-08-15T12:59:00.000Z',
      '2026-08-15T13:00:00.000Z'
    )
  `;
  await sql`
    INSERT INTO focowiki.document_artifact_work (
      public_id, knowledge_base_id, document_job_public_id,
      source_file_public_id, source_revision_public_id,
      work_kind, resource_lane, input_fingerprint_sha256,
      state, maximum_attempts, next_eligible_at, ended_at
    ) VALUES
      (
        'work-cleanup-old-projection', 'kb-cleanup', 'job-cleanup-old',
        'source-cleanup', 'revision-cleanup-old', 'knowledge_projection',
        'projection', ${"7".repeat(64)}, 'completed', 3,
        '2026-08-15T12:59:00.000Z', '2026-08-15T13:00:00.000Z'
      ),
      (
        'work-cleanup-new-projection', 'kb-cleanup', 'job-cleanup',
        'source-cleanup', 'revision-cleanup-new', 'knowledge_projection',
        'projection', ${"8".repeat(64)}, 'waiting_on_projection', 3,
        '2026-08-15T14:00:00.000Z', NULL
      )
  `;
  await sql`
    INSERT INTO focowiki.generated_page_candidates (
      public_id, knowledge_base_id, source_work_public_id,
      source_revision_public_id, logical_path, normalized_path, entry_kind,
      source_file_public_id, page_source_file_public_id,
      page_source_revision_public_id, object_id, checksum_sha256, byte_count,
      base_activation_revision, state
    ) VALUES (
      'candidate-cleanup-shared-old', 'kb-cleanup',
      'work-cleanup-old-projection', 'revision-cleanup-old',
      'shared.md', 'shared.md', 'index', 'source-cleanup',
      'source-cleanup', 'revision-cleanup-old',
      'object-cleanup-shared-page', ${"9".repeat(64)}, 2, 2, 'active'
    ), (
      'candidate-cleanup-shared-current', 'kb-cleanup',
      'work-cleanup-new-projection', 'revision-cleanup-new',
      'shared.md', 'shared.md', 'index', 'source-cleanup',
      'source-cleanup', 'revision-cleanup-new',
      'object-cleanup-shared-current', ${"0".repeat(64)}, 3, 3, 'staged'
    )
  `;
  await sql`
    INSERT INTO focowiki.object_owners (
      public_id, knowledge_base_id, object_id, owner_kind,
      generated_page_candidate_public_id
    ) VALUES (
      'owner-cleanup-shared-old', 'kb-cleanup',
      'object-cleanup-shared-page', 'generated_page_candidate',
      'candidate-cleanup-shared-old'
    ), (
      'owner-cleanup-shared-current', 'kb-cleanup',
      'object-cleanup-shared-current', 'generated_page_candidate',
      'candidate-cleanup-shared-current'
    )
  `;
  await sql`
    INSERT INTO focowiki.generated_page_heads (
      knowledge_base_id, logical_path, normalized_path, entry_kind,
      source_file_public_id, source_revision_public_id,
      page_candidate_public_id, object_id, checksum_sha256, byte_count,
      activation_revision
    ) VALUES (
      'kb-cleanup', 'shared.md', 'shared.md', 'index', 'source-cleanup',
      'revision-cleanup-old', 'candidate-cleanup-shared-old',
      'object-cleanup-shared-page', ${"9".repeat(64)}, 2, 2
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
    INSERT INTO focowiki.object_owners (
      public_id, knowledge_base_id, object_id, owner_kind,
      source_revision_public_id
    ) VALUES (
      'owner-cleanup-old-source', 'kb-cleanup', 'object-cleanup-old',
      'source_revision', 'revision-cleanup-old'
    )
  `;
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
