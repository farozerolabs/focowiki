import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresGenerationCleanupRepository } from "../src/infrastructure/postgres/generation-cleanup-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("generation cleanup repository integration", () => {
  const sql = postgres(databaseUrl!, { max: 4 });
  const repository = createPostgresGenerationCleanupRepository(sql);
  const knowledgeBaseId = "kb-cleanup-integration";
  const sharedKnowledgeBaseId = "kb-cleanup-shared-integration";
  const sourceFileId = "source-file-cleanup-integration";
  const deletionIntentId = "deletion-cleanup-integration";
  const referencedChecksum = "ca".repeat(32);
  const unreferencedChecksum = "cb".repeat(32);

  beforeEach(async () => {
    await cleanup();
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Cleanup integration')
    `;
    await sql`
      INSERT INTO focowiki.deletion_intents (
        id, knowledge_base_id, target_kind, target_id, catalog_generation, state
      ) VALUES (
        ${deletionIntentId}, ${knowledgeBaseId}, 'source_file', ${sourceFileId}, 1, 'running'
      )
    `;
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, name, relative_path, path_key, object_key,
          content_type, size_bytes, checksum_sha256, processing_status,
          active_revision_id, deletion_intent_id, deleted_at
        ) VALUES (
          ${sourceFileId}, ${knowledgeBaseId}, 'cleanup.md', 'cleanup.md', 'cleanup.md',
          'sources/cleanup-integration/current.md', 'text/markdown', 10,
          ${"cc".repeat(32)}, 'completed', 'source-revision-cleanup',
          ${deletionIntentId}, now()
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256, processing_status
        ) VALUES (
          'source-revision-cleanup', ${knowledgeBaseId}, ${sourceFileId}, 1,
          'sources/cleanup-integration/revision.md', 'text/markdown', 10,
          ${"cc".repeat(32)}, 'completed'
        )
      `;
    });
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
  });

  it("waits for activated deletion intent and absence from active projections", async () => {
    const target = {
      kind: "source_file" as const,
      knowledgeBaseId,
      sourceFileId,
      deletionIntentId
    };
    await expect(repository.isReady({ jobId: "cleanup-job", target })).resolves.toBe(false);

    await sql`
      UPDATE focowiki.deletion_intents
      SET state = 'completed', completed_at = now()
      WHERE id = ${deletionIntentId}
    `;
    await expect(repository.isReady({ jobId: "cleanup-job", target })).resolves.toBe(true);

    await insertActiveGeneration();
    await sql`
      INSERT INTO focowiki.active_object_refs (
        knowledge_base_id, ref_kind, ref_key, file_id, last_changed_generation_id,
        checksum_sha256, format_version, logical_path, source_file_id
      ) VALUES (
        ${knowledgeBaseId}, 'page', ${sourceFileId}, ${sourceFileId}, 'generation-cleanup',
        ${referencedChecksum}, 1, 'pages/cleanup.md', ${sourceFileId}
      )
    `;
    await expect(repository.isReady({ jobId: "cleanup-job", target })).resolves.toBe(false);
  });

  it("discovers source objects through a stable bounded cursor", async () => {
    const target = {
      kind: "source_file" as const,
      knowledgeBaseId,
      sourceFileId,
      deletionIntentId
    };
    const first = await repository.discoverSourceObjectKeys({ target, cursor: null, limit: 1 });
    expect(first).toEqual({
      objectKeys: ["sources/cleanup-integration/current.md"],
      nextCursor: "sources/cleanup-integration/current.md"
    });
    await expect(repository.discoverSourceObjectKeys({
      target,
      cursor: first.nextCursor,
      limit: 1
    })).resolves.toEqual({
      objectKeys: ["sources/cleanup-integration/revision.md"],
      nextCursor: null
    });
  });

  it("never returns immutable objects retained by a generation or active reference", async () => {
    await insertActiveGeneration();
    await sql`
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key, content_type, size_bytes,
        created_at, verified_at
      ) VALUES (
        ${unreferencedChecksum}, 1,
        'generated/cleanup-integration/unreferenced.md',
        'text/markdown', 10, '2026-01-01', '2026-01-01'
      )
    `;
    await sql`
      INSERT INTO focowiki.generation_object_refs (
        generation_id, knowledge_base_id, ref_kind, ref_key, file_id, action,
        checksum_sha256, format_version, logical_path, source_file_id
      ) VALUES (
        'generation-cleanup', ${knowledgeBaseId}, 'page', ${sourceFileId}, ${sourceFileId},
        'upsert', ${referencedChecksum}, 1, 'pages/cleanup.md', ${sourceFileId}
      )
    `;

    const result = await repository.claimUnreferencedImmutableObjects({
      jobId: "gc-job",
      cursor: null,
      olderThan: "2026-07-17T00:00:00.000Z",
      limit: 10
    });
    expect(result.objects.map((object) => object.objectKey)).toEqual([
      "generated/cleanup-integration/unreferenced.md"
    ]);
  });

  it("purges a deleted knowledge base with source and model records", async () => {
    const target = {
      kind: "knowledge_base" as const,
      knowledgeBaseId,
      deletionIntentId
    };
    await repository.saveCheckpoint({
      jobId: "knowledge-base-cleanup-job",
      target,
      checkpoint: {
        phase: "database_cleanup",
        discoveryCursor: null,
        discoveryCompleted: true
      },
      updatedAt: new Date().toISOString()
    });
    await insertActiveGeneration();
    await sql`
      INSERT INTO focowiki.active_object_refs (
        knowledge_base_id, ref_kind, ref_key, file_id, last_changed_generation_id,
        checksum_sha256, format_version, logical_path, source_file_id
      ) VALUES (
        ${knowledgeBaseId}, 'page', ${sourceFileId}, ${sourceFileId}, 'generation-cleanup',
        ${referencedChecksum}, 1, 'pages/cleanup.md', ${sourceFileId}
      )
    `;
    await sql`
      INSERT INTO focowiki.model_invocations (
        id, knowledge_base_id, source_file_id, model_name, status, started_at
      ) VALUES (
        'model-invocation-cleanup', ${knowledgeBaseId}, ${sourceFileId},
        'test-model', 'completed', now()
      )
    `;
    await sql`
      UPDATE focowiki.knowledge_bases SET deleted_at = now() WHERE id = ${knowledgeBaseId}
    `;

    await expect(repository.purgeTargetBatch({
      jobId: "knowledge-base-cleanup-job",
      target,
      limit: 10,
      purgedAt: new Date().toISOString()
    })).resolves.toEqual({ deletedRows: 0, hasMore: true });

    const activeReferences = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.active_object_refs
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;
    expect(activeReferences[0]?.count).toBe(0);

    await expect(repository.listPendingObjectKeys({
      jobId: "knowledge-base-cleanup-job",
      limit: 10
    })).resolves.toEqual(["generated/cleanup-integration/referenced.md"]);

    const claimedObjects = await sql<Array<{
      lifecycle_state: string;
      deletion_job_id: string | null;
    }>>`
      SELECT lifecycle_state, deletion_job_id
      FROM focowiki.immutable_objects
      WHERE checksum_sha256 = ${referencedChecksum} AND format_version = 1
    `;
    expect(claimedObjects).toEqual([{
      lifecycle_state: "deleting",
      deletion_job_id: "knowledge-base-cleanup-job"
    }]);

    await repository.markObjectKeysDeleted({
      jobId: "knowledge-base-cleanup-job",
      objectKeys: ["generated/cleanup-integration/referenced.md"],
      deletedAt: new Date().toISOString()
    });
    const immutableObjects = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.immutable_objects
      WHERE checksum_sha256 = ${referencedChecksum} AND format_version = 1
    `;
    expect(immutableObjects[0]?.count).toBe(0);

    await expect(repository.purgeTargetBatch({
      jobId: "knowledge-base-cleanup-job",
      target,
      limit: 10,
      purgedAt: new Date().toISOString()
    })).resolves.toEqual({ deletedRows: 1, hasMore: false });

    const remaining = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.model_invocations
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;
    expect(remaining[0]?.count).toBe(0);

    await repository.complete({
      jobId: "knowledge-base-cleanup-job",
      target,
      completedAt: new Date().toISOString()
    });
    const cleanupRows = await sql<Array<{ checkpoint_count: number; object_count: number }>>`
      SELECT
        (SELECT count(*)::int FROM focowiki.cleanup_checkpoints
         WHERE job_id = 'knowledge-base-cleanup-job') AS checkpoint_count,
        (SELECT count(*)::int FROM focowiki.cleanup_object_deletions
         WHERE job_id = 'knowledge-base-cleanup-job') AS object_count
    `;
    expect(cleanupRows).toEqual([{ checkpoint_count: 0, object_count: 0 }]);
  });

  it("purges a source directory retained by completed upload history", async () => {
    const directoryId = "source-directory-cleanup-integration";
    const directoryDeletionIntentId = "deletion-directory-cleanup-integration";
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.deletion_intents (
          id, knowledge_base_id, target_kind, target_id, catalog_generation,
          state, completed_at
        ) VALUES (
          ${directoryDeletionIntentId}, ${knowledgeBaseId}, 'source_directory',
          ${directoryId}, 2, 'completed', now()
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_directories (
          id, knowledge_base_id, name, relative_path, path_key, depth,
          deletion_intent_id, deleted_at
        ) VALUES (
          ${directoryId}, ${knowledgeBaseId}, 'archive', 'archive', 'archive', 1,
          ${directoryDeletionIntentId}, now()
        )
      `;
      await transaction`
        INSERT INTO focowiki.upload_sessions (
          id, knowledge_base_id, state, idempotency_key,
          declared_file_count, declared_byte_count, expires_at
        ) VALUES (
          'upload-session-directory-cleanup', ${knowledgeBaseId}, 'completed',
          'upload-session-directory-cleanup', 1, 10, now() + interval '1 day'
        )
      `;
      await transaction`
        INSERT INTO focowiki.upload_session_entries (
          id, session_id, knowledge_base_id, sequence_number, relative_path,
          path_key, directory_path, name, declared_size, disposition,
          transfer_state, source_directory_id, generated_path
        ) VALUES (
          'upload-entry-directory-cleanup', 'upload-session-directory-cleanup',
          ${knowledgeBaseId}, 1, 'archive/file.md', 'archive/file.md', 'archive',
          'file.md', 10, 'skipped_existing', 'skipped', ${directoryId},
          'pages/archive/file.md'
        )
      `;
    });

    await expect(repository.purgeTargetBatch({
      jobId: "directory-cleanup-job",
      target: {
        kind: "source_directory",
        knowledgeBaseId,
        sourceDirectoryId: directoryId,
        deletionIntentId: directoryDeletionIntentId
      },
      limit: 10,
      purgedAt: new Date().toISOString()
    })).resolves.toEqual({ deletedRows: 0, hasMore: false });

    const rows = await sql<Array<{
      directory_count: number;
      retained_directory_id: string | null;
    }>>`
      SELECT
        (SELECT count(*)::int FROM focowiki.source_directories
         WHERE id = ${directoryId}) AS directory_count,
        (SELECT source_directory_id FROM focowiki.upload_session_entries
         WHERE id = 'upload-entry-directory-cleanup') AS retained_directory_id
    `;
    expect(rows).toEqual([{ directory_count: 0, retained_directory_id: null }]);
  });

  it("clears subsumed child cleanup state when knowledge-base deletion completes", async () => {
    const target = {
      kind: "knowledge_base" as const,
      knowledgeBaseId,
      deletionIntentId
    };
    await repository.saveCheckpoint({
      jobId: "knowledge-base-cleanup-job",
      target,
      checkpoint: {
        phase: "database_cleanup",
        discoveryCursor: null,
        discoveryCompleted: true
      },
      updatedAt: new Date().toISOString()
    });
    await sql`
      INSERT INTO focowiki.cleanup_checkpoints (
        job_id, knowledge_base_id, target_kind, target_id, deletion_intent_id,
        phase, discovery_completed
      ) VALUES (
        'subsumed-directory-cleanup-job', ${knowledgeBaseId}, 'source_directory',
        'source-directory-subsumed', 'deletion-intent-subsumed',
        'database_cleanup', true
      )
    `;
    await sql`
      INSERT INTO focowiki.cleanup_object_deletions (
        job_id, knowledge_base_id, object_key
      ) VALUES
        ('knowledge-base-cleanup-job', ${knowledgeBaseId}, 'sources/current.md'),
        ('subsumed-directory-cleanup-job', ${knowledgeBaseId}, 'sources/subsumed.md')
    `;

    await repository.complete({
      jobId: "knowledge-base-cleanup-job",
      target,
      completedAt: new Date().toISOString()
    });

    const rows = await sql<Array<{ checkpoint_count: number; object_count: number }>>`
      SELECT
        (SELECT count(*)::int FROM focowiki.cleanup_checkpoints
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS checkpoint_count,
        (SELECT count(*)::int FROM focowiki.cleanup_object_deletions
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS object_count
    `;
    expect(rows).toEqual([{ checkpoint_count: 0, object_count: 0 }]);
  });

  it("retains immutable objects still referenced by another knowledge base", async () => {
    await insertActiveGeneration();
    await sql`
      INSERT INTO focowiki.active_object_refs (
        knowledge_base_id, ref_kind, ref_key, file_id, last_changed_generation_id,
        checksum_sha256, format_version, logical_path, source_file_id
      ) VALUES (
        ${knowledgeBaseId}, 'page', ${sourceFileId}, ${sourceFileId}, 'generation-cleanup',
        ${referencedChecksum}, 1, 'pages/cleanup.md', ${sourceFileId}
      )
    `;
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${sharedKnowledgeBaseId}, 'Shared cleanup integration')
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, state, activated_at
      ) VALUES ('generation-cleanup-shared', ${sharedKnowledgeBaseId}, 'active', now())
    `;
    await sql`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = 'generation-cleanup-shared'
      WHERE id = ${sharedKnowledgeBaseId}
    `;
    await sql`
      INSERT INTO focowiki.active_object_refs (
        knowledge_base_id, ref_kind, ref_key, file_id, last_changed_generation_id,
        checksum_sha256, format_version, logical_path
      ) VALUES (
        ${sharedKnowledgeBaseId}, 'page', 'shared-page', 'shared-page',
        'generation-cleanup-shared', ${referencedChecksum}, 1, 'pages/shared.md'
      )
    `;
    await sql`
      UPDATE focowiki.knowledge_bases SET deleted_at = now() WHERE id = ${knowledgeBaseId}
    `;

    await expect(repository.purgeTargetBatch({
      jobId: "knowledge-base-shared-cleanup-job",
      target: {
        kind: "knowledge_base",
        knowledgeBaseId,
        deletionIntentId
      },
      limit: 10,
      purgedAt: new Date().toISOString()
    })).resolves.toEqual({ deletedRows: 1, hasMore: false });

    await expect(repository.listPendingObjectKeys({
      jobId: "knowledge-base-shared-cleanup-job",
      limit: 10
    })).resolves.toEqual([]);
    const retained = await sql<Array<{ lifecycle_state: string; reference_count: number }>>`
      SELECT object.lifecycle_state,
             count(reference.knowledge_base_id)::int AS reference_count
      FROM focowiki.immutable_objects object
      JOIN focowiki.active_object_refs reference
        ON reference.checksum_sha256 = object.checksum_sha256
       AND reference.format_version = object.format_version
      WHERE object.checksum_sha256 = ${referencedChecksum} AND object.format_version = 1
      GROUP BY object.lifecycle_state
    `;
    expect(retained).toEqual([{ lifecycle_state: "active", reference_count: 1 }]);
  });

  async function insertActiveGeneration(): Promise<void> {
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, state, activated_at
      ) VALUES ('generation-cleanup', ${knowledgeBaseId}, 'active', now())
    `;
    await sql`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = 'generation-cleanup'
      WHERE id = ${knowledgeBaseId}
    `;
    await sql`
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key, content_type, size_bytes
      ) VALUES (
        ${referencedChecksum}, 1,
        'generated/cleanup-integration/referenced.md', 'text/markdown', 10
      )
      ON CONFLICT DO NOTHING
    `;
  }

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM focowiki.active_object_refs WHERE knowledge_base_id = ${sharedKnowledgeBaseId}`;
    await sql`DELETE FROM focowiki.generation_object_refs WHERE knowledge_base_id = ${sharedKnowledgeBaseId}`;
    await sql`DELETE FROM focowiki.publication_generations WHERE knowledge_base_id = ${sharedKnowledgeBaseId}`;
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${sharedKnowledgeBaseId}`;
    await sql`DELETE FROM focowiki.cleanup_object_deletions WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.cleanup_checkpoints WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.active_object_refs WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.generation_object_refs WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.active_projection_records WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.generation_projection_records WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.role_jobs WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.model_invocations WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.upload_sessions WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_files WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_directories WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.deletion_intents WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.publication_generations WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
    await sql`
      DELETE FROM focowiki.immutable_objects
      WHERE object_key LIKE 'generated/cleanup-integration/%'
    `;
  }
});
