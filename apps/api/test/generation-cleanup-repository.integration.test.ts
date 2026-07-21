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
  const rootManifestChecksum = "7b".repeat(32);
  const unreferencedChecksum = "ff".repeat(32);

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
      ) VALUES
        (
          ${unreferencedChecksum}, 1,
          'generated/cleanup-integration/unreferenced.md',
          'text/markdown', 10, '2026-01-01', '2026-01-01'
        ),
        (
          ${rootManifestChecksum}, 1,
          'generated/cleanup-integration/root-manifest.json',
          'application/json', 10, '2026-01-01', '2026-01-01'
        )
    `;
    await sql`
      UPDATE focowiki.publication_generations
      SET root_manifest_checksum_sha256 = ${rootManifestChecksum},
          root_manifest_object_key = 'generated/cleanup-integration/root-manifest.json'
      WHERE id = 'generation-cleanup'
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

  it("reclaims an unreferenced deleting object whose owner job no longer exists", async () => {
    await sql`
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key, content_type, size_bytes,
        lifecycle_state, deletion_job_id, created_at, verified_at
      ) VALUES (
        ${unreferencedChecksum}, 1,
        'generated/cleanup-integration/orphaned-deleting.md',
        'text/markdown', 10, 'deleting', 'missing-hard-delete-job',
        '2026-07-20', '2026-07-20'
      )
    `;

    const result = await repository.claimUnreferencedImmutableObjects({
      jobId: "gc-repair-job",
      cursor: `${unreferencedChecksum}:0000000000`,
      olderThan: "2026-07-17T00:00:00.000Z",
      limit: 10
    });

    expect(result.objects).toEqual([{
      checksumSha256: unreferencedChecksum,
      formatVersion: 1,
      objectKey: "generated/cleanup-integration/orphaned-deleting.md"
    }]);
    const claimed = await sql<Array<{ deletion_job_id: string | null }>>`
      SELECT deletion_job_id
      FROM focowiki.immutable_objects
      WHERE checksum_sha256 = ${unreferencedChecksum} AND format_version = 1
    `;
    expect(claimed).toEqual([{ deletion_job_id: "gc-repair-job" }]);
  });

  it("retains superseded generations referenced by the active read model", async () => {
    await insertActiveGeneration();
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, state, updated_at
      ) VALUES (
        'generation-cleanup-superseded', ${knowledgeBaseId}, 'superseded',
        '2026-01-01T00:00:00.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.active_projection_records (
        knowledge_base_id, projection_kind, record_id,
        last_changed_generation_id, shard_key, logical_path
      ) VALUES (
        ${knowledgeBaseId}, 'search', 'cleanup-active-record',
        'generation-cleanup-superseded', 'search/v2/0001', 'pages/cleanup.md'
      )
    `;
    await sql`
      INSERT INTO focowiki.active_object_refs (
        knowledge_base_id, ref_kind, ref_key, file_id,
        last_changed_generation_id, checksum_sha256, format_version,
        logical_path, source_file_id
      ) VALUES (
        ${knowledgeBaseId}, 'page', 'cleanup-expired-page', 'cleanup-expired-page',
        'generation-cleanup-superseded', ${referencedChecksum}, 1,
        'pages/cleanup.md', ${sourceFileId}
      )
    `;
    await sql`
      INSERT INTO focowiki.active_projection_partition_stats (
        knowledge_base_id, projection_kind, logical_partition,
        record_count, last_changed_generation_id
      ) VALUES (
        ${knowledgeBaseId}, 'search', 'search/v2/0001', 1,
        'generation-cleanup-superseded'
      )
    `;

    await expect(repository.deleteExpiredGenerations({
      olderThan: '2026-07-20T00:00:00.000Z',
      limit: 10
    })).resolves.toBe(0);

    await sql`
      UPDATE focowiki.active_projection_records
      SET last_changed_generation_id = 'generation-cleanup'
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND record_id = 'cleanup-active-record'
    `;
    await expect(repository.deleteExpiredGenerations({
      olderThan: '2026-07-20T00:00:00.000Z',
      limit: 10
    })).resolves.toBe(0);

    await sql`
      UPDATE focowiki.active_object_refs
      SET last_changed_generation_id = 'generation-cleanup'
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND ref_key = 'cleanup-expired-page'
    `;
    await expect(repository.deleteExpiredGenerations({
      olderThan: '2026-07-20T00:00:00.000Z',
      limit: 10
    })).resolves.toBe(0);

    await sql`
      UPDATE focowiki.active_projection_partition_stats
      SET last_changed_generation_id = 'generation-cleanup'
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND logical_partition = 'search/v2/0001'
    `;
    await expect(repository.deleteExpiredGenerations({
      olderThan: '2026-07-20T00:00:00.000Z',
      limit: 10
    })).resolves.toBe(1);
  });

  it("does not reclaim a deleting object owned by queued maintenance work", async () => {
    const ownedChecksum = "fe".repeat(32);
    await sql`
      INSERT INTO focowiki.role_jobs (
        id, role, kind, knowledge_base_id, status, run_after, max_attempts
      ) VALUES (
        'active-hard-delete-job', 'maintenance', 'hard_delete',
        ${knowledgeBaseId}, 'queued', now(), 3
      )
    `;
    await sql`
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key, content_type, size_bytes,
        lifecycle_state, deletion_job_id, created_at, verified_at
      ) VALUES (
        ${ownedChecksum}, 1,
        'generated/cleanup-integration/owned-deleting.md',
        'text/markdown', 10, 'deleting', 'active-hard-delete-job',
        '2026-07-20', '2026-07-20'
      )
    `;

    const result = await repository.claimUnreferencedImmutableObjects({
      jobId: "gc-must-not-steal",
      cursor: `${ownedChecksum}:0000000000`,
      olderThan: "2026-07-17T00:00:00.000Z",
      limit: 10
    });

    expect(result.objects).toEqual([]);
  });

  it("purges optimized source ownership while retaining protected projection segments", async () => {
    await insertActiveGeneration();
    await sql`
      UPDATE focowiki.deletion_intents
      SET state = 'completed', completed_at = now()
      WHERE id = ${deletionIntentId}
    `;
    await sql`
      INSERT INTO focowiki.source_file_graph_term_documents (
        knowledge_base_id, source_file_id, source_revision_id,
        term_fingerprint, lexical_text, exact_terms
      ) VALUES (
        ${knowledgeBaseId}, ${sourceFileId}, 'source-revision-cleanup',
        ${"ab".repeat(16)}, 'cleanup term', ARRAY['cleanup-term']
      )
    `;
    await sql`
      INSERT INTO focowiki.source_file_graph_nodes (
        knowledge_base_id, source_file_id, path, title, profile_version, profile_source
      ) VALUES (
        ${knowledgeBaseId}, ${sourceFileId}, 'pages/cleanup.md', 'Cleanup', 'v1', 'content'
      )
    `;
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, name, relative_path, path_key, object_key,
          content_type, size_bytes, checksum_sha256, processing_status,
          active_revision_id
        ) VALUES (
          'source-file-neighbor-cleanup', ${knowledgeBaseId}, 'neighbor.md',
          'neighbor.md', 'neighbor.md', 'sources/cleanup-integration/neighbor.md',
          'text/markdown', 10, ${"cd".repeat(32)}, 'completed',
          'source-revision-neighbor-cleanup'
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256, processing_status
        ) VALUES (
          'source-revision-neighbor-cleanup', ${knowledgeBaseId},
          'source-file-neighbor-cleanup', 1,
          'sources/cleanup-integration/neighbor.md', 'text/markdown', 10,
          ${"cd".repeat(32)}, 'completed'
        )
      `;
    });
    await sql`
      INSERT INTO focowiki.source_file_graph_edges (
        id, knowledge_base_id, from_source_file_id, to_source_file_id,
        relation_type, weight, reason, source
      ) VALUES (
        'edge-cleanup-integration', ${knowledgeBaseId}, ${sourceFileId},
        'source-file-neighbor-cleanup', 'related', 0.8, 'Shared subject', 'content'
      )
    `;
    await sql`
      INSERT INTO focowiki.publication_change_facts (
        id, knowledge_base_id, source_file_id, source_revision_id,
        operation_id, deletion_intent_id, kind, path, resource_revision,
        generation_id, assembly_state, assembled_at
      ) VALUES (
        'change-fact-cleanup-integration', ${knowledgeBaseId}, ${sourceFileId},
        'source-revision-cleanup', 'operation-cleanup-integration',
        ${deletionIntentId}, 'source_deleted', 'cleanup.md', 1,
        'generation-cleanup', 'assembled', now()
      )
    `;
    await sql`
      INSERT INTO focowiki.publication_projection_inputs (
        knowledge_base_id, generation_id, input_key, payload_json
      ) VALUES (
        ${knowledgeBaseId}, 'generation-cleanup', ${`source:${sourceFileId}`},
        ${sql.json({ sourceFileId })}
      )
    `;
    await sql`
      INSERT INTO focowiki.publication_impacts (
        id, knowledge_base_id, generation_id, projection_kind,
        projection_key, record_identity, action, projection_input_key
      ) VALUES (
        'impact-cleanup-integration', ${knowledgeBaseId}, 'generation-cleanup',
        'search', 'search/v2/0001', ${sourceFileId}, 'delete',
        ${`source:${sourceFileId}`}
      )
    `;
    await sql`
      INSERT INTO focowiki.publication_impact_causes (impact_id, change_fact_id)
      VALUES ('impact-cleanup-integration', 'change-fact-cleanup-integration')
    `;
    await sql`
      INSERT INTO focowiki.generation_projection_records (
        generation_id, knowledge_base_id, projection_kind, record_id,
        shard_key, source_file_id, logical_path, payload_json
      ) VALUES (
        'generation-cleanup', ${knowledgeBaseId}, 'search', ${sourceFileId},
        'search/v2/0001', ${sourceFileId}, 'pages/cleanup.md',
        ${sql.json({ sourceFileId })}
      )
    `;
    await sql`
      INSERT INTO focowiki.generation_object_refs (
        generation_id, knowledge_base_id, ref_kind, ref_key, file_id,
        action, checksum_sha256, format_version, logical_path, source_file_id
      ) VALUES (
        'generation-cleanup', ${knowledgeBaseId}, 'page', ${sourceFileId},
        ${sourceFileId}, 'upsert', ${referencedChecksum}, 1,
        'pages/cleanup.md', ${sourceFileId}
      )
    `;
    await sql`
      INSERT INTO focowiki.projection_segments (
        id, knowledge_base_id, projection_kind, logical_partition,
        segment_kind, sequence_number, format_version, checksum_sha256,
        object_key, logical_path, entry_count, encoded_bytes, lifecycle_state
      ) VALUES (
        'segment-cleanup-tombstone', ${knowledgeBaseId}, 'search', 'search/v2/0001',
        'tombstone', 1, 1, ${unreferencedChecksum},
        'generated/cleanup-integration/tombstone.json',
        '_segments/search/tombstone.json', 1, 32, 'retained'
      )
    `;
    await sql`
      INSERT INTO focowiki.generation_projection_segments (
        generation_id, segment_id, ordinal, effective
      ) VALUES ('generation-cleanup', 'segment-cleanup-tombstone', 0, true)
    `;
    await sql`
      INSERT INTO focowiki.generation_graph_summaries (
        knowledge_base_id, generation_id, node_count, edge_count,
        graph_index_available
      ) VALUES (${knowledgeBaseId}, 'generation-cleanup', 1, 1, true)
    `;
    await sql`
      INSERT INTO focowiki.source_file_graph_jobs (
        id, knowledge_base_id, source_file_id, status, started_at, ended_at
      ) VALUES (
        'graph-job-cleanup-integration', ${knowledgeBaseId}, ${sourceFileId},
        'completed', now(), now()
      )
    `;
    await sql`
      INSERT INTO focowiki.role_jobs (
        id, role, kind, knowledge_base_id, source_file_id,
        source_revision_id, status, completed_at
      ) VALUES (
        'role-job-cleanup-integration', 'source', 'source_file_processing',
        ${knowledgeBaseId}, ${sourceFileId}, 'source-revision-cleanup',
        'completed', now()
      )
    `;

    await expect(repository.purgeTargetBatch({
      jobId: 'source-cleanup-job',
      target: {
        kind: 'source_file',
        knowledgeBaseId,
        sourceFileId,
        deletionIntentId
      },
      limit: 10,
      purgedAt: new Date().toISOString()
    })).resolves.toEqual({ deletedRows: 1, hasMore: false });

    const residuals = await sql<Array<{
      source_count: number;
      term_count: number;
      frequency_count: number;
      node_count: number;
      edge_count: number;
      fact_count: number;
      impact_count: number;
      input_count: number;
      projection_count: number;
      object_ref_count: number;
      segment_count: number;
      segment_ownership_count: number;
      graph_summary_count: number;
      graph_job_count: number;
      role_job_count: number;
    }>>`
      SELECT
        (SELECT count(*)::int FROM focowiki.source_files WHERE id = ${sourceFileId}) AS source_count,
        (SELECT count(*)::int FROM focowiki.source_file_graph_term_documents WHERE source_file_id = ${sourceFileId}) AS term_count,
        (SELECT count(*)::int FROM focowiki.source_file_graph_term_frequencies WHERE knowledge_base_id = ${knowledgeBaseId} AND term = 'cleanup-term') AS frequency_count,
        (SELECT count(*)::int FROM focowiki.source_file_graph_nodes WHERE source_file_id = ${sourceFileId}) AS node_count,
        (SELECT count(*)::int FROM focowiki.source_file_graph_edges WHERE from_source_file_id = ${sourceFileId} OR to_source_file_id = ${sourceFileId}) AS edge_count,
        (SELECT count(*)::int FROM focowiki.publication_change_facts WHERE source_file_id = ${sourceFileId}) AS fact_count,
        (SELECT count(*)::int FROM focowiki.publication_impacts WHERE record_identity = ${sourceFileId}) AS impact_count,
        (SELECT count(*)::int FROM focowiki.publication_projection_inputs WHERE input_key = ${`source:${sourceFileId}`}) AS input_count,
        (SELECT count(*)::int FROM focowiki.generation_projection_records WHERE source_file_id = ${sourceFileId} OR related_source_file_id = ${sourceFileId}) AS projection_count,
        (SELECT count(*)::int FROM focowiki.generation_object_refs WHERE source_file_id = ${sourceFileId}) AS object_ref_count,
        (SELECT count(*)::int FROM focowiki.projection_segments WHERE id = 'segment-cleanup-tombstone') AS segment_count,
        (SELECT ownership_count::int FROM focowiki.projection_segments WHERE id = 'segment-cleanup-tombstone') AS segment_ownership_count,
        (SELECT count(*)::int FROM focowiki.generation_graph_summaries WHERE generation_id = 'generation-cleanup') AS graph_summary_count,
        (SELECT count(*)::int FROM focowiki.source_file_graph_jobs WHERE source_file_id = ${sourceFileId}) AS graph_job_count,
        (SELECT count(*)::int FROM focowiki.role_jobs WHERE source_file_id = ${sourceFileId}) AS role_job_count
    `;
    expect(residuals).toEqual([{
      source_count: 0,
      term_count: 0,
      frequency_count: 0,
      node_count: 0,
      edge_count: 0,
      fact_count: 0,
      impact_count: 0,
      input_count: 0,
      projection_count: 0,
      object_ref_count: 0,
      segment_count: 1,
      segment_ownership_count: 1,
      graph_summary_count: 1,
      graph_job_count: 0,
      role_job_count: 0
    }]);
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
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key, content_type, size_bytes,
        created_at, verified_at
      ) VALUES (
        ${rootManifestChecksum}, 1,
        'generated/cleanup-integration/root-manifest.json',
        'application/json', 10, '2026-01-01', '2026-01-01'
      )
    `;
    await sql`
      UPDATE focowiki.publication_generations
      SET root_manifest_checksum_sha256 = ${rootManifestChecksum},
          root_manifest_object_key = 'generated/cleanup-integration/root-manifest.json'
      WHERE id = 'generation-cleanup'
    `;
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
      INSERT INTO focowiki.projection_segments (
        id, knowledge_base_id, projection_kind, logical_partition,
        segment_kind, sequence_number, format_version, checksum_sha256,
        object_key, logical_path, entry_count, encoded_bytes, lifecycle_state
      ) VALUES (
        'segment-knowledge-base-cleanup', ${knowledgeBaseId}, 'search', 'search/v2/0001',
        'base', 1, 1, ${referencedChecksum},
        'generated/cleanup-integration/referenced.md',
        '_segments/search/base.json', 1, 10, 'active'
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
    })).resolves.toEqual([
      "generated/cleanup-integration/referenced.md",
      "generated/cleanup-integration/root-manifest.json"
    ]);

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
      objectKeys: [
        "generated/cleanup-integration/referenced.md",
        "generated/cleanup-integration/root-manifest.json"
      ],
      deletedAt: new Date().toISOString()
    });
    const immutableObjects = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.immutable_objects
      WHERE checksum_sha256 = ${referencedChecksum} AND format_version = 1
    `;
    expect(immutableObjects[0]?.count).toBe(1);

    await expect(repository.purgeTargetBatch({
      jobId: "knowledge-base-cleanup-job",
      target,
      limit: 10,
      purgedAt: new Date().toISOString()
    })).resolves.toEqual({ deletedRows: 1, hasMore: false });

    const immutableObjectsAfterPurge = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.immutable_objects
      WHERE checksum_sha256 = ${referencedChecksum} AND format_version = 1
    `;
    expect(immutableObjectsAfterPurge[0]?.count).toBe(0);
    const rootManifestObjectsAfterPurge = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.immutable_objects
      WHERE checksum_sha256 = ${rootManifestChecksum} AND format_version = 1
    `;
    expect(rootManifestObjectsAfterPurge[0]?.count).toBe(0);

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

  it("supersedes all knowledge-base work without creating per-file cleanup jobs", async () => {
    await insertActiveGeneration();
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, state, format_version
      ) VALUES ('generation-cleanup-pending', ${knowledgeBaseId}, 'building', 2)
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_optimization_migrations (
        knowledge_base_id, state, phase, prior_active_generation_id,
        lease_owner, lease_token, lease_expires_at
      ) VALUES (
        ${knowledgeBaseId}, 'backfilling', 'source_terms', 'generation-cleanup',
        'migration-worker', 'migration-lease', now() + interval '5 minutes'
      )
    `;
    await sql`
      INSERT INTO focowiki.projection_compaction_jobs (
        id, knowledge_base_id, projection_kind, logical_partition,
        active_generation_id, expected_segment_ids, reason_codes,
        state, locked_by, lease_token, lease_expires_at
      ) VALUES (
        'compaction-cleanup-integration', ${knowledgeBaseId}, 'search',
        'search/v2/0001', 'generation-cleanup', ARRAY[]::text[],
        ARRAY['depth'], 'running', 'maintenance-worker', 'compaction-lease',
        now() + interval '5 minutes'
      )
    `;
    await sql`
      INSERT INTO focowiki.publication_change_facts (
        id, knowledge_base_id, source_file_id, source_revision_id,
        kind, path, resource_revision, assembly_state,
        assembly_claimed_by, assembly_claimed_at
      ) VALUES (
        'change-fact-kb-cleanup', ${knowledgeBaseId}, ${sourceFileId},
        'source-revision-cleanup', 'source_replaced', 'cleanup.md', 1,
        'claimed', 'assembler-worker', now()
      )
    `;
    await sql`
      INSERT INTO focowiki.publication_impacts (
        id, knowledge_base_id, generation_id, projection_kind,
        projection_key, record_identity, action, status,
        claimed_by, claimed_at, heartbeat_at
      ) VALUES (
        'impact-kb-cleanup', ${knowledgeBaseId}, 'generation-cleanup-pending',
        'search', 'search/v2/0001', ${sourceFileId}, 'upsert', 'running',
        'publication-worker', now(), now()
      )
    `;
    await sql`
      INSERT INTO focowiki.publication_subtasks (
        id, knowledge_base_id, generation_id, task_kind,
        projection_kind, physical_partition, state,
        lease_owner, lease_token, lease_expires_at
      ) VALUES (
        'subtask-kb-cleanup', ${knowledgeBaseId}, 'generation-cleanup-pending',
        'projection_partition', 'search', 'search/v2/0001', 'running',
        'publication-worker', 'publication-lease', now() + interval '5 minutes'
      )
    `;
    await sql`
      INSERT INTO focowiki.source_file_graph_jobs (
        id, knowledge_base_id, source_file_id, status, started_at
      ) VALUES (
        'graph-job-kb-cleanup', ${knowledgeBaseId}, ${sourceFileId},
        'running', now()
      )
    `;
    await sql`
      INSERT INTO focowiki.role_jobs (
        id, role, kind, knowledge_base_id, source_file_id,
        source_revision_id, status, locked_by, locked_at, heartbeat_at
      ) VALUES (
        'source-role-job-kb-cleanup', 'source', 'source_file_processing',
        ${knowledgeBaseId}, ${sourceFileId}, 'source-revision-cleanup',
        'running', 'source-worker', now(), now()
      )
    `;
    await sql`
      UPDATE focowiki.knowledge_bases
      SET deleted_at = now()
      WHERE id = ${knowledgeBaseId}
    `;

    const target = {
      kind: "knowledge_base" as const,
      knowledgeBaseId,
      deletionIntentId
    };
    await repository.supersedeTargetWork({
      jobId: "knowledge-base-cleanup-job",
      target,
      supersededAt: new Date().toISOString()
    });

    const state = await sql<Array<{
      role_status: string;
      graph_status: string;
      fact_status: string;
      impact_status: string;
      subtask_status: string;
      generation_status: string;
      compaction_status: string;
      migration_status: string;
      hard_delete_job_count: number;
    }>>`
      SELECT
        (SELECT status FROM focowiki.role_jobs WHERE id = 'source-role-job-kb-cleanup') AS role_status,
        (SELECT status FROM focowiki.source_file_graph_jobs WHERE id = 'graph-job-kb-cleanup') AS graph_status,
        (SELECT assembly_state FROM focowiki.publication_change_facts WHERE id = 'change-fact-kb-cleanup') AS fact_status,
        (SELECT status FROM focowiki.publication_impacts WHERE id = 'impact-kb-cleanup') AS impact_status,
        (SELECT state FROM focowiki.publication_subtasks WHERE id = 'subtask-kb-cleanup') AS subtask_status,
        (SELECT state FROM focowiki.publication_generations WHERE id = 'generation-cleanup-pending') AS generation_status,
        (SELECT state FROM focowiki.projection_compaction_jobs WHERE id = 'compaction-cleanup-integration') AS compaction_status,
        (SELECT state FROM focowiki.knowledge_base_optimization_migrations WHERE knowledge_base_id = ${knowledgeBaseId}) AS migration_status,
        (SELECT count(*)::int FROM focowiki.role_jobs WHERE knowledge_base_id = ${knowledgeBaseId} AND kind = 'hard_delete') AS hard_delete_job_count
    `;
    expect(state).toEqual([{
      role_status: "cancelled",
      graph_status: "failed",
      fact_status: "cancelled",
      impact_status: "cancelled",
      subtask_status: "cancelled",
      generation_status: "superseded",
      compaction_status: "superseded",
      migration_status: "failed",
      hard_delete_job_count: 0
    }]);
    await expect(repository.isReady({
      jobId: "knowledge-base-cleanup-job",
      target
    })).resolves.toBe(true);
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

  it("purges nested directory sources and pending optimized work in bounded pages", async () => {
    const directoryId = "source-directory-bounded-cleanup";
    const childDirectoryId = "source-directory-bounded-child-cleanup";
    const directoryDeletionIntentId = "deletion-directory-bounded-cleanup";
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.deletion_intents (
          id, knowledge_base_id, target_kind, target_id, catalog_generation,
          state, completed_at
        ) VALUES (
          ${directoryDeletionIntentId}, ${knowledgeBaseId}, 'source_directory',
          ${directoryId}, 3, 'completed', now()
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_directories (
          id, knowledge_base_id, parent_id, name, relative_path,
          path_key, depth, deletion_intent_id, deleted_at
        ) VALUES
          (${directoryId}, ${knowledgeBaseId}, NULL, 'archive', 'archive',
           'archive', 1, ${directoryDeletionIntentId}, now()),
          (${childDirectoryId}, ${knowledgeBaseId}, ${directoryId}, 'nested',
           'archive/nested', 'archive/nested', 2,
           ${directoryDeletionIntentId}, now())
      `;
    });
    await insertDeletedDirectorySource({
      sourceFileId: "source-file-directory-cleanup-a",
      relativePath: "archive/a.md",
      directoryId,
      deletionIntentId: directoryDeletionIntentId
    });
    await insertDeletedDirectorySource({
      sourceFileId: "source-file-directory-cleanup-b",
      relativePath: "archive/nested/b.md",
      directoryId: childDirectoryId,
      deletionIntentId: directoryDeletionIntentId
    });
    for (const [index, sourceId] of [
      "source-file-directory-cleanup-a",
      "source-file-directory-cleanup-b"
    ].entries()) {
      await sql`
        INSERT INTO focowiki.publication_change_facts (
          id, knowledge_base_id, source_file_id, source_revision_id,
          kind, path, resource_revision, assembly_state
        ) VALUES (
          ${`change-fact-directory-cleanup-${index}`}, ${knowledgeBaseId},
          ${sourceId}, ${`source-revision-${sourceId}`}, 'source_deleted',
          ${index === 0 ? "archive/a.md" : "archive/nested/b.md"},
          1, 'pending'
        )
      `;
      await sql`
        INSERT INTO focowiki.role_jobs (
          id, role, kind, knowledge_base_id, source_file_id,
          source_revision_id, status
        ) VALUES (
          ${`role-job-directory-cleanup-${index}`}, 'source',
          'source_file_processing', ${knowledgeBaseId}, ${sourceId},
          ${`source-revision-${sourceId}`}, 'queued'
        )
      `;
    }

    const target = {
      kind: "source_directory" as const,
      knowledgeBaseId,
      sourceDirectoryId: directoryId,
      deletionIntentId: directoryDeletionIntentId
    };
    await expect(repository.purgeTargetBatch({
      jobId: "directory-bounded-cleanup-job",
      target,
      limit: 1,
      purgedAt: new Date().toISOString()
    })).resolves.toEqual({ deletedRows: 1, hasMore: true });
    const firstPage = await sql<Array<{
      source_count: number;
      fact_count: number;
      role_job_count: number;
      directory_count: number;
    }>>`
      SELECT
        (SELECT count(*)::int FROM focowiki.source_files WHERE deletion_intent_id = ${directoryDeletionIntentId}) AS source_count,
        (SELECT count(*)::int FROM focowiki.publication_change_facts WHERE source_file_id LIKE 'source-file-directory-cleanup-%') AS fact_count,
        (SELECT count(*)::int FROM focowiki.role_jobs WHERE source_file_id LIKE 'source-file-directory-cleanup-%') AS role_job_count,
        (SELECT count(*)::int FROM focowiki.source_directories WHERE deletion_intent_id = ${directoryDeletionIntentId}) AS directory_count
    `;
    expect(firstPage).toEqual([{
      source_count: 1,
      fact_count: 1,
      role_job_count: 1,
      directory_count: 2
    }]);

    for (let page = 0; page < 3; page += 1) {
      await repository.purgeTargetBatch({
        jobId: "directory-bounded-cleanup-job",
        target,
        limit: 1,
        purgedAt: new Date().toISOString()
      });
    }
    const residuals = await sql<Array<{
      source_count: number;
      fact_count: number;
      role_job_count: number;
      directory_count: number;
    }>>`
      SELECT
        (SELECT count(*)::int FROM focowiki.source_files WHERE deletion_intent_id = ${directoryDeletionIntentId}) AS source_count,
        (SELECT count(*)::int FROM focowiki.publication_change_facts WHERE source_file_id LIKE 'source-file-directory-cleanup-%') AS fact_count,
        (SELECT count(*)::int FROM focowiki.role_jobs WHERE source_file_id LIKE 'source-file-directory-cleanup-%') AS role_job_count,
        (SELECT count(*)::int FROM focowiki.source_directories WHERE deletion_intent_id = ${directoryDeletionIntentId}) AS directory_count
    `;
    expect(residuals).toEqual([{
      source_count: 0,
      fact_count: 0,
      role_job_count: 0,
      directory_count: 0
    }]);
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
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key, content_type, size_bytes,
        created_at, verified_at
      ) VALUES (
        ${rootManifestChecksum}, 1,
        'generated/cleanup-integration/shared-root-manifest.json',
        'application/json', 10, '2026-01-01', '2026-01-01'
      )
    `;
    await sql`
      UPDATE focowiki.publication_generations
      SET root_manifest_checksum_sha256 = ${rootManifestChecksum},
          root_manifest_object_key = 'generated/cleanup-integration/shared-root-manifest.json'
      WHERE id IN ('generation-cleanup', 'generation-cleanup-shared')
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
    const retainedRootManifest = await sql<Array<{ lifecycle_state: string }>>`
      SELECT lifecycle_state
      FROM focowiki.immutable_objects
      WHERE checksum_sha256 = ${rootManifestChecksum} AND format_version = 1
    `;
    expect(retainedRootManifest).toEqual([{ lifecycle_state: "active" }]);
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
        checksum_sha256, format_version, object_key, content_type, size_bytes,
        verified_at
      ) VALUES (
        ${referencedChecksum}, 1,
        'generated/cleanup-integration/referenced.md', 'text/markdown', 10, now()
      )
      ON CONFLICT DO NOTHING
    `;
  }

  async function insertDeletedDirectorySource(input: {
    sourceFileId: string;
    relativePath: string;
    directoryId: string;
    deletionIntentId: string;
  }): Promise<void> {
    const revisionId = `source-revision-${input.sourceFileId}`;
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, name, relative_path, path_key, directory_id,
          object_key, content_type, size_bytes, checksum_sha256,
          processing_status, active_revision_id, deletion_intent_id, deleted_at
        ) VALUES (
          ${input.sourceFileId}, ${knowledgeBaseId},
          ${input.relativePath.split("/").at(-1) ?? input.relativePath},
          ${input.relativePath}, ${input.relativePath.toLocaleLowerCase("en-US")},
          ${input.directoryId}, ${`sources/${input.sourceFileId}.md`},
          'text/markdown', 10, ${"ce".repeat(32)}, 'completed',
          ${revisionId}, ${input.deletionIntentId}, now()
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256, processing_status
        ) VALUES (
          ${revisionId}, ${knowledgeBaseId}, ${input.sourceFileId}, 1,
          ${`sources/${input.sourceFileId}.md`}, 'text/markdown', 10,
          ${"ce".repeat(32)}, 'completed'
        )
      `;
    });
  }

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM focowiki.active_object_refs WHERE knowledge_base_id = ${sharedKnowledgeBaseId}`;
    await sql`DELETE FROM focowiki.generation_object_refs WHERE knowledge_base_id = ${sharedKnowledgeBaseId}`;
    await sql`DELETE FROM focowiki.publication_generations WHERE knowledge_base_id = ${sharedKnowledgeBaseId}`;
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${sharedKnowledgeBaseId}`;
    await sql`DELETE FROM focowiki.cleanup_object_deletions WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.cleanup_checkpoints WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.active_object_refs WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.active_projection_partition_stats WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.generation_object_refs WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.active_projection_records WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.generation_projection_records WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.role_jobs WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.model_invocations WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.upload_sessions WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_file_graph_edges WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_file_graph_jobs WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_file_graph_nodes WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_file_graph_term_documents WHERE knowledge_base_id = ${knowledgeBaseId}`;
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
