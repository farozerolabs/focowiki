import { createHash } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type {
  PublicationGenerationRepository,
  SourceCompletionCommitResult
} from "../src/application/ports/publication-generation-repository.js";
import { createChangeFactIdentity } from "../src/domain/generation.js";
import { normalizeSourceRelativePath } from "../src/domain/source-path.js";
import { createPostgresPublicationGenerationRepository } from "../src/infrastructure/postgres/publication-generation-repository.js";
import { createPostgresPublicationImpactRepository } from "../src/infrastructure/postgres/publication-impact-repository.js";
import { createPostgresGenerationObjectReferenceRepository } from "../src/infrastructure/postgres/generation-object-reference-repository.js";
import { createPostgresImmutableObjectRepository } from "../src/infrastructure/postgres/immutable-object-repository.js";
import { createPostgresProjectionRecordRepository } from "../src/infrastructure/postgres/projection-record-repository.js";
import { createPostgresProjectionSegmentRepository } from "../src/infrastructure/postgres/projection-segment-repository.js";
import { createPostgresUploadSessionRepository } from "../src/infrastructure/postgres/upload-session-repository.js";
import { planPublicationImpacts } from "../src/publication/impact-planner.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("publication generation repository integration", () => {
  const statements: string[] = [];
  const sql = postgres(databaseUrl!, {
    max: 4,
    debug: (_connection, query) => statements.push(query)
  });
  const uploads = createPostgresUploadSessionRepository(sql);
  const generations = createPostgresPublicationGenerationRepository(sql);
  const publicationImpacts = createPostgresPublicationImpactRepository(sql);
  const references = createPostgresGenerationObjectReferenceRepository(sql);
  const objects = createPostgresImmutableObjectRepository(sql);
  const projectionRecords = createPostgresProjectionRecordRepository(sql);
  const projectionSegments = createPostgresProjectionSegmentRepository(sql);
  const knowledgeBaseId = "kb-generation-integration";

  beforeEach(async () => {
    await cleanup();
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Generation integration')
    `;
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
  });

  it("atomically commits source facts and coalesces one open generation", async () => {
    const first = await registerSource(1);
    const second = await registerSource(2);

    const firstCommit = await commit(first);
    const secondCommit = await commit(second);
    expect(secondCommit.generationId).toBe(firstCommit.generationId);

    const replay = await commit(first);
    expect(replay).toMatchObject({
      generationId: firstCommit.generationId,
      replayed: true,
      impactCount: firstCommit.impactCount
    });
    const counts = await sql<Array<{ facts: number; impacts: number; jobs: number }>>`
      SELECT
        (SELECT count(*)::int FROM focowiki.publication_change_facts
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS facts,
        (SELECT count(*)::int FROM focowiki.publication_impacts
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS impacts,
        (SELECT count(*)::int FROM focowiki.role_jobs
         WHERE knowledge_base_id = ${knowledgeBaseId} AND role = 'publication') AS jobs
    `;
    expect(counts[0]!.facts).toBe(2);
    expect(counts[0]!.jobs).toBe(1);
    expect(counts[0]!.impacts).toBeLessThan(
      firstCommit.impactCount + secondCommit.impactCount
    );

    const repeatedRoots = await sql<Array<{ projection_key: string; count: number }>>`
      SELECT projection_key, count(*)::int AS count
      FROM focowiki.publication_impacts
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND generation_id = ${firstCommit.generationId}
        AND projection_kind = 'root'
      GROUP BY projection_key
      ORDER BY projection_key
    `;
    expect(repeatedRoots).toHaveLength(5);
    expect(repeatedRoots.every((row) => row.count === 1)).toBe(true);

    const causes = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.publication_impact_causes cause
      JOIN focowiki.publication_change_facts fact ON fact.id = cause.change_fact_id
      WHERE fact.knowledge_base_id = ${knowledgeBaseId}
    `;
    expect(causes[0]!.count).toBe(
      firstCommit.impactCount + secondCommit.impactCount
    );
  });

  it("keeps source completion file-local without per-impact writes or corpus counts", async () => {
    const source = await registerSource(101);
    statements.length = 0;

    await commit(source, { assemble: false });

    expect(countStatements("INSERT INTO focowiki.publication_impacts")).toBe(0);
    expect(countStatements("INSERT INTO focowiki.publication_impact_causes")).toBe(0);
    expect(countStatements("FROM focowiki.publication_change_facts")).toBeLessThanOrEqual(1);
  });

  it("derives bounded publication throughput from durable progress timestamps", async () => {
    const generationId = "generation-progress-summary";
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, state, generation_kind
      ) VALUES (${generationId}, ${knowledgeBaseId}, 'building', 'normal')
    `;
    await sql`
      INSERT INTO focowiki.publication_progress (
        knowledge_base_id, generation_id, stage, processed_impact_count,
        total_impact_count, touched_shard_count, started_at, heartbeat_at
      ) VALUES (
        ${knowledgeBaseId}, ${generationId}, 'projection', 3, 5, 2,
        '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:02.000Z'
      )
    `;

    await expect(generations.getProgressSummary({ knowledgeBaseId })).resolves.toMatchObject({
      generationId,
      processedImpactCount: 3,
      totalImpactCount: 5,
      touchedShardCount: 2,
      throughputPerMinute: 90
    });
  });

  it("persists one bounded change-fact page through set-based projection writes", async () => {
    const sources = await Promise.all([
      registerSource(104),
      registerSource(105),
      registerSource(106)
    ]);
    for (const source of sources) await commit(source, { assemble: false });
    statements.length = 0;

    const assembled = await assemble("2026-07-17T01:00:01.000Z");

    expect(assembled).toMatchObject({ assembledChangeCount: 3, hasMore: false });
    expect(countStatements("INSERT INTO focowiki.publication_impacts")).toBe(1);
    expect(countStatements("INSERT INTO focowiki.publication_impact_causes")).toBe(1);
    expect(countStatements("INSERT INTO focowiki.publication_projection_inputs")).toBe(1);
  });

  it("assembles deferred directory descendants before scheduling the final directory mutation", async () => {
    const source = await registerSource(107);
    const operationId = "resource-operation-directory-move-batch";
    const movedPath = "archive/moved-file-107.md";
    const sourceFactId = createChangeFactIdentity({
      knowledgeBaseId,
      sourceRevisionId: source.sourceRevisionId,
      kind: "source_moved",
      previousPath: source.path,
      path: movedPath,
      mutationIdentity: operationId
    });
    await generations.commitMutation({
      knowledgeBaseId,
      sourceFileId: source.sourceFileId,
      sourceRevisionId: source.sourceRevisionId,
      kind: "source_moved",
      previousPath: source.path,
      path: movedPath,
      resourceRevision: 2,
      operationId,
      deletionIntentId: null,
      changeFactId: sourceFactId,
      impacts: planPublicationImpacts({
        changeFactId: sourceFactId,
        kind: "source_moved",
        sourceFileId: source.sourceFileId,
        previousPath: source.path,
        path: movedPath,
        config: {
          searchShardCount: 16,
          linkShardCount: 16,
          manifestShardCount: 16,
          treeShardCount: 16,
          graphNodeShardCount: 16,
          graphEdgeShardCount: 16
        }
      }),
      publicationSettingsSnapshot: publicationSettingsSnapshot(),
      publicationMaxAttempts: 3,
      schedulePublication: false,
      committedAt: "2026-07-17T01:00:00.000Z"
    });

    const deferred = await assemble("2026-07-17T01:00:01.000Z");
    expect(deferred).toMatchObject({ assembledChangeCount: 1, hasMore: false });
    expect(deferred.generationId).not.toBeNull();
    const jobsBeforeFinal = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.role_jobs
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND kind = 'generation_publication'
    `;
    expect(jobsBeforeFinal[0]?.count).toBe(0);

    const directoryFactId = createChangeFactIdentity({
      knowledgeBaseId,
      sourceRevisionId: null,
      kind: "directory_moved",
      previousPath: "docs",
      path: "archive",
      mutationIdentity: operationId
    });
    await generations.commitMutation({
      knowledgeBaseId,
      sourceFileId: null,
      sourceRevisionId: null,
      kind: "directory_moved",
      previousPath: "docs",
      path: "archive",
      resourceRevision: 2,
      operationId,
      deletionIntentId: null,
      changeFactId: directoryFactId,
      impacts: planPublicationImpacts({
        changeFactId: directoryFactId,
        kind: "directory_moved",
        sourceFileId: null,
        previousPath: "docs",
        path: "archive",
        config: {
          searchShardCount: 16,
          linkShardCount: 16,
          manifestShardCount: 16,
          treeShardCount: 16,
          graphNodeShardCount: 16,
          graphEdgeShardCount: 16
        }
      }),
      publicationSettingsSnapshot: publicationSettingsSnapshot(),
      publicationMaxAttempts: 3,
      committedAt: "2026-07-17T01:00:02.000Z"
    });

    const finalized = await assemble("2026-07-17T01:00:03.000Z");
    expect(finalized.generationId).toBe(deferred.generationId);
    const facts = await sql<Array<{ id: string; generation_id: string | null }>>`
      SELECT id, generation_id
      FROM focowiki.publication_change_facts
      WHERE id IN (${sourceFactId}, ${directoryFactId})
      ORDER BY id
    `;
    expect(facts).toHaveLength(2);
    expect(facts.every((fact) => fact.generation_id === deferred.generationId)).toBe(true);
    const sourceInputs = await sql<Array<{ payload_json: { document?: { relativePath?: string } } }>>`
      SELECT payload_json
      FROM focowiki.publication_projection_inputs
      WHERE generation_id = ${deferred.generationId}
        AND input_key = ${`source:${source.sourceFileId}`}
    `;
    expect(sourceInputs[0]?.payload_json.document?.relativePath).toBe(movedPath);
    const jobsAfterFinal = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.role_jobs
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND kind = 'generation_publication'
        AND generation_id = ${deferred.generationId}
    `;
    expect(jobsAfterFinal[0]?.count).toBe(1);
  });

  it("rejects a stale source completion after a concurrent move or rename", async () => {
    const source = await registerSource(102);
    await sql`
      UPDATE focowiki.source_files
      SET relative_path = 'docs/renamed-102.md',
          path_key = 'docs/renamed-102.md',
          name = 'renamed-102.md',
          resource_revision = resource_revision + 1
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND id = ${source.sourceFileId}
    `;

    await expect(commit(source, { assemble: false })).rejects.toThrow(
      "Source revision is no longer eligible for publication"
    );
    const facts = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.publication_change_facts
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;
    expect(facts[0]?.count).toBe(0);
  });

  it("replays source completion and assembly after worker replacement", async () => {
    const source = await registerSource(103);
    const request = sourceCompletionRequest(source);
    const restartedRepository = createPostgresPublicationGenerationRepository(sql);
    const results = await Promise.all([
      generations.commitSourceCompletion(request),
      restartedRepository.commitSourceCompletion(request)
    ]);
    const first = results.find((result) => !result.replayed)!;
    const replay = results.find((result) => result.replayed)!;
    expect(replay).toEqual({
      generationId: null,
      changeFactId: request.changeFactId,
      impactCount: 0,
      replayed: true
    });
    const assembled = await restartedRepository.assemblePendingChanges({
      knowledgeBaseId,
      assemblerJobId: "assembly-worker-replacement-a",
      limit: 100,
      assembledAt: "2026-07-17T01:00:01.000Z"
    });
    expect(assembled).toMatchObject({
      assembledChangeCount: 1,
      hasMore: false
    });
    const repeatedAssembly = await generations.assemblePendingChanges({
      knowledgeBaseId,
      assemblerJobId: "assembly-worker-replacement-b",
      limit: 100,
      assembledAt: "2026-07-17T01:00:02.000Z"
    });
    expect(repeatedAssembly).toEqual({
      generationId: null,
      assembledChangeCount: 0,
      impactCount: 0,
      hasMore: false
    });

    const rows = await sql<Array<{ facts: number; generations: number }>>`
      SELECT
        (SELECT count(*)::int FROM focowiki.publication_change_facts
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS facts,
        (SELECT count(*)::int FROM focowiki.publication_generations
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS generations
    `;
    expect(rows[0]).toEqual({ facts: 1, generations: 1 });
    expect(first.replayed).toBe(false);
  });

  it("freezes stable membership and assigns later changes to one successor", async () => {
    const first = await registerSource(1);
    const firstCommit = await commit(first);
    const frozen = await generations.freezeGeneration({
      knowledgeBaseId,
      generationId: firstCommit.generationId,
      frozenAt: "2026-07-17T02:00:00.000Z"
    });
    expect(frozen?.totalImpactCount).toBe(firstCommit.impactCount);

    const second = await registerSource(2);
    const third = await registerSource(3);
    const secondCommit = await commit(second);
    const thirdCommit = await commit(third);
    expect(secondCommit.generationId).not.toBe(firstCommit.generationId);
    expect(thirdCommit.generationId).toBe(secondCommit.generationId);

    const memberships = await sql<Array<{ generation_id: string; count: number }>>`
      SELECT generation_id, count(*)::int AS count
      FROM focowiki.publication_change_facts
      WHERE knowledge_base_id = ${knowledgeBaseId}
      GROUP BY generation_id
      ORDER BY generation_id
    `;
    expect(memberships.map((row) => row.count).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("cancels unfinished impacts when a generation fails", async () => {
    const source = await registerSource(1);
    const committed = await commit(source);
    await generations.freezeGeneration({
      knowledgeBaseId,
      generationId: committed.generationId,
      frozenAt: "2026-07-17T02:00:00.000Z"
    });
    await generations.markGenerationState({
      knowledgeBaseId,
      generationId: committed.generationId,
      expectedState: "frozen",
      state: "building",
      updatedAt: "2026-07-17T02:00:01.000Z"
    });
    await publicationImpacts.claimBatch({
      knowledgeBaseId,
      generationId: committed.generationId,
      workerId: "failed-generation-worker",
      limit: 1,
      now: "2026-07-17T02:00:02.000Z",
      staleBefore: "2026-07-17T01:55:00.000Z"
    });

    await generations.failGeneration({
      knowledgeBaseId,
      generationId: committed.generationId,
      code: "PUBLICATION_RETRIES_EXHAUSTED",
      message: "Publication retries are exhausted",
      failedAt: "2026-07-17T02:00:03.000Z"
    });

    const impacts = await sql<Array<{
      status: string;
      claimed_by: string | null;
      completed_at: Date | null;
    }>>`
      SELECT status, claimed_by, completed_at
      FROM focowiki.publication_impacts
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND generation_id = ${committed.generationId}
    `;
    expect(impacts.length).toBeGreaterThan(0);
    expect(impacts.every((impact) =>
      impact.status === "cancelled"
      && impact.claimed_by === null
      && impact.completed_at !== null
    )).toBe(true);
  });

  it("keeps frozen projection inputs stable after mutable source state advances", async () => {
    const source = await registerSource(1);
    const committed = await commit(source);
    await generations.freezeGeneration({
      knowledgeBaseId,
      generationId: committed.generationId,
      frozenAt: "2026-07-17T02:00:00.000Z"
    });

    await sql`
      UPDATE focowiki.source_files
      SET name = 'latest.md', relative_path = 'latest/latest.md', path_key = 'latest/latest.md'
      WHERE knowledge_base_id = ${knowledgeBaseId} AND id = ${source.sourceFileId}
    `;

    const storedInputs = await sql<Array<{
      projection_kind: string;
      projection_input_key: string | null;
      payload_json: unknown;
    }>>`
      SELECT impact.projection_kind, impact.projection_input_key, projection_input.payload_json
      FROM focowiki.publication_impacts impact
      LEFT JOIN focowiki.publication_projection_inputs projection_input
        ON projection_input.generation_id = impact.generation_id
       AND projection_input.input_key = impact.projection_input_key
      WHERE impact.knowledge_base_id = ${knowledgeBaseId}
        AND impact.generation_id = ${committed.generationId}
        AND impact.projection_kind = 'page'
    `;
    expect(storedInputs).toMatchObject([{
      projection_kind: "page",
      projection_input_key: `source:${source.sourceFileId}`,
      payload_json: {
        kind: "source",
        document: {
          sourceFileId: source.sourceFileId,
          sourceRevisionId: source.sourceRevisionId,
          relativePath: source.path,
          generatedPath: `pages/${source.path}`
        }
      }
    }]);

    const claimed = await publicationImpacts.claimBatch({
      knowledgeBaseId,
      generationId: committed.generationId,
      workerId: "snapshot-test-worker",
      limit: 100,
      now: "2026-07-17T02:00:01.000Z",
      staleBefore: "2026-07-17T01:55:00.000Z"
    });
    const page = claimed.find((impact) => impact.projectionKind === "page");
    expect(page, JSON.stringify(claimed, null, 2)).toBeDefined();
    expect(page?.projectionInput).toMatchObject({
      kind: "source",
      document: {
        sourceFileId: source.sourceFileId,
        sourceRevisionId: source.sourceRevisionId,
        relativePath: source.path,
        generatedPath: `pages/${source.path}`
      }
    });
  });

  it("advances a processed replacement operation through publication activation", async () => {
    const source = await registerSource(1);
    const initial = await commit(source);
    const operationId = "resource-operation-generation-replace";
    const replacementRevisionId = "source-revision-generation-replace";
    const replacementContent = "# Replacement generation";
    const replacementChecksum = createHash("sha256")
      .update(replacementContent)
      .digest("hex");
    await sql`
      INSERT INTO focowiki.resource_operations (
        id, knowledge_base_id, operation_kind, state, idempotency_key,
        request_fingerprint, candidate_catalog_generation
      ) VALUES (
        ${operationId}, ${knowledgeBaseId}, 'source_file_replace', 'processing',
        'generation-replace', 'generation-replace', 1
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revisions (
        id, knowledge_base_id, source_file_id, revision, object_key,
        content_type, size_bytes, checksum_sha256, metadata_json, processing_status
      ) VALUES (
        ${replacementRevisionId}, ${knowledgeBaseId}, ${source.sourceFileId}, 2,
        'test/replacement.md', 'text/markdown', ${Buffer.byteLength(replacementContent)},
        ${replacementChecksum}, ${sql.json({ title: "Replacement generation" })}, 'running'
      )
    `;
    await sql`
      UPDATE focowiki.source_files
      SET candidate_operation_id = ${operationId},
          candidate_revision_id = ${replacementRevisionId},
          candidate_name = 'file-1.md', candidate_relative_path = ${source.path},
          candidate_path_key = ${source.path}, candidate_directory_id = directory_id,
          candidate_object_key = 'test/replacement.md',
          candidate_content_type = 'text/markdown',
          candidate_size_bytes = ${Buffer.byteLength(replacementContent)},
          candidate_checksum_sha256 = ${replacementChecksum},
          candidate_metadata_json = ${sql.json({ title: "Replacement generation" })},
          candidate_model_suggestions_json = ${sql.json({
            title: "Replacement suggestion",
            description: "Replacement description",
            tags: ["replacement"],
            relatedLinks: []
          })}
      WHERE knowledge_base_id = ${knowledgeBaseId} AND id = ${source.sourceFileId}
    `;
    const replacementFactId = createChangeFactIdentity({
      knowledgeBaseId,
      sourceRevisionId: replacementRevisionId,
      kind: "source_replaced",
      previousPath: source.path,
      path: source.path
    });
    await generations.commitSourceCompletion({
      knowledgeBaseId,
      sourceFileId: source.sourceFileId,
      sourceRevisionId: replacementRevisionId,
      kind: "source_replaced",
      previousPath: source.path,
      path: source.path,
      resourceRevision: 2,
      operationId,
      changeFactId: replacementFactId,
      impacts: planPublicationImpacts({
        changeFactId: replacementFactId,
        kind: "source_replaced",
        sourceFileId: source.sourceFileId,
        previousPath: source.path,
        path: source.path,
        config: {
          searchShardCount: 16,
          linkShardCount: 16,
          manifestShardCount: 16,
          treeShardCount: 16,
          graphNodeShardCount: 16,
          graphEdgeShardCount: 16
        }
      }),
      publicationSettingsSnapshot: {
        publication: { mode: "batch", batchSize: 50, intervalSeconds: 30 }
      },
      publicationMaxAttempts: 3,
      completedAt: "2026-07-17T01:05:00.000Z"
    });
    await assemble("2026-07-17T01:05:01.000Z");
    const publishing = await sql<Array<{ state: string }>>`
      SELECT state FROM focowiki.resource_operations WHERE id = ${operationId}
    `;
    expect(publishing[0]?.state).toBe("publishing");

    await prepareGenerationForActivation({
      generationId: initial.generationId,
      source,
      checksum: replacementChecksum,
      timestampPrefix: "2026-07-17T02:00"
    });
    expect(await generations.activateGeneration({
      knowledgeBaseId,
      generationId: initial.generationId,
      expectedPredecessorGenerationId: null,
      rootManifestChecksumSha256: replacementChecksum,
      rootManifestObjectKey: `generated/${replacementChecksum}`,
      activatedAt: "2026-07-17T02:00:03.000Z"
    })).toBe(true);
    const completed = await sql<Array<{
      state: string;
      active_revision_id: string;
      candidate_operation_id: string | null;
    }>>`
      SELECT operation.state, source.active_revision_id, source.candidate_operation_id
      FROM focowiki.resource_operations operation
      JOIN focowiki.source_files source
        ON source.knowledge_base_id = operation.knowledge_base_id
       AND source.id = ${source.sourceFileId}
      WHERE operation.id = ${operationId}
    `;
    expect(completed[0]).toEqual({
      state: "completed",
      active_revision_id: replacementRevisionId,
      candidate_operation_id: null
    });
  });

  it("advances an accepted source deletion operation to publication", async () => {
    const source = await registerSource(1);
    await commit(source);
    const operationId = "resource-operation-generation-delete";
    const deletionIntentId = "deletion-intent-generation-delete";
    await sql`
      INSERT INTO focowiki.deletion_intents (
        id, knowledge_base_id, target_kind, target_id, catalog_generation, state
      ) VALUES (
        ${deletionIntentId}, ${knowledgeBaseId}, 'source_file',
        ${source.sourceFileId}, 1, 'accepted'
      )
    `;
    await sql`
      INSERT INTO focowiki.resource_operations (
        id, knowledge_base_id, operation_kind, state, idempotency_key,
        request_fingerprint, candidate_catalog_generation
      ) VALUES (
        ${operationId}, ${knowledgeBaseId}, 'source_file_delete', 'accepted',
        'generation-delete', 'generation-delete', 1
      )
    `;
    await sql`
      UPDATE focowiki.source_files
      SET deletion_intent_id = ${deletionIntentId},
          deleted_at = '2026-07-17T01:10:00.000Z'
      WHERE knowledge_base_id = ${knowledgeBaseId} AND id = ${source.sourceFileId}
    `;
    const changeFactId = createChangeFactIdentity({
      knowledgeBaseId,
      sourceRevisionId: source.sourceRevisionId,
      kind: "source_deleted",
      previousPath: source.path,
      path: null,
      mutationIdentity: deletionIntentId
    });
    await generations.commitMutation({
      knowledgeBaseId,
      sourceFileId: source.sourceFileId,
      sourceRevisionId: source.sourceRevisionId,
      kind: "source_deleted",
      previousPath: source.path,
      path: null,
      resourceRevision: 1,
      operationId,
      deletionIntentId,
      changeFactId,
      impacts: planPublicationImpacts({
        changeFactId,
        kind: "source_deleted",
        sourceFileId: source.sourceFileId,
        previousPath: source.path,
        path: null,
        config: {
          searchShardCount: 16,
          linkShardCount: 16,
          manifestShardCount: 16,
          treeShardCount: 16,
          graphNodeShardCount: 16,
          graphEdgeShardCount: 16
        }
      }),
      publicationSettingsSnapshot: {
        publication: { mode: "batch", batchSize: 50, intervalSeconds: 30 }
      },
      publicationMaxAttempts: 3,
      committedAt: "2026-07-17T01:10:00.000Z"
    });

    const operations = await sql<Array<{ state: string }>>`
      SELECT state FROM focowiki.resource_operations WHERE id = ${operationId}
    `;
    expect(operations[0]?.state).toBe("publishing");
  });

  it("commits path mutations and inverse deletion facts through the same generation", async () => {
    const source = await registerSource(1);
    await commit(source);
    const movedPath = "archive/file-1.md";
    await sql`
      INSERT INTO focowiki.source_directories (
        id, knowledge_base_id, parent_id, name, relative_path, path_key, depth
      ) VALUES (
        'source-directory-generation-archive', ${knowledgeBaseId}, NULL,
        'archive', 'archive', 'archive', 1
      )
    `;
    const movedFactId = createChangeFactIdentity({
      knowledgeBaseId,
      sourceRevisionId: source.sourceRevisionId,
      kind: "source_moved",
      previousPath: source.path,
      path: movedPath
    });
    await generations.commitMutation({
      knowledgeBaseId,
      sourceFileId: source.sourceFileId,
      sourceRevisionId: source.sourceRevisionId,
      kind: "source_moved",
      previousPath: source.path,
      path: movedPath,
      resourceRevision: 2,
      operationId: "operation-move-a",
      deletionIntentId: null,
      changeFactId: movedFactId,
      impacts: planPublicationImpacts({
        changeFactId: movedFactId,
        kind: "source_moved",
        sourceFileId: source.sourceFileId,
        previousPath: source.path,
        path: movedPath,
        config: {
          searchShardCount: 16,
          linkShardCount: 16,
          manifestShardCount: 16,
          treeShardCount: 16,
          graphNodeShardCount: 16,
          graphEdgeShardCount: 16
        }
      }),
      publicationSettingsSnapshot: {
        publication: { mode: "batch", batchSize: 50, intervalSeconds: 30 }
      },
      publicationMaxAttempts: 3,
      committedAt: "2026-07-17T01:01:00.000Z"
    });
    const renamedPath = "archive/renamed-file-1.md";
    const renamedFactId = createChangeFactIdentity({
      knowledgeBaseId,
      sourceRevisionId: source.sourceRevisionId,
      kind: "source_renamed",
      previousPath: movedPath,
      path: renamedPath
    });
    await generations.commitMutation({
      knowledgeBaseId,
      sourceFileId: source.sourceFileId,
      sourceRevisionId: source.sourceRevisionId,
      kind: "source_renamed",
      previousPath: movedPath,
      path: renamedPath,
      resourceRevision: 3,
      operationId: "operation-rename-a",
      deletionIntentId: null,
      changeFactId: renamedFactId,
      impacts: planPublicationImpacts({
        changeFactId: renamedFactId,
        kind: "source_renamed",
        sourceFileId: source.sourceFileId,
        previousPath: movedPath,
        path: renamedPath,
        config: {
          searchShardCount: 16,
          linkShardCount: 16,
          manifestShardCount: 16,
          treeShardCount: 16,
          graphNodeShardCount: 16,
          graphEdgeShardCount: 16
        }
      }),
      publicationSettingsSnapshot: publicationSettingsSnapshot(),
      publicationMaxAttempts: 3,
      committedAt: "2026-07-17T01:01:30.000Z"
    });
    const deletedFactId = createChangeFactIdentity({
      knowledgeBaseId,
      sourceRevisionId: source.sourceRevisionId,
      kind: "source_deleted",
      previousPath: renamedPath,
      path: null
    });
    await generations.commitMutation({
      knowledgeBaseId,
      sourceFileId: source.sourceFileId,
      sourceRevisionId: source.sourceRevisionId,
      kind: "source_deleted",
      previousPath: renamedPath,
      path: null,
      resourceRevision: 4,
      operationId: "operation-delete-a",
      deletionIntentId: "deletion-delete-a",
      changeFactId: deletedFactId,
      impacts: planPublicationImpacts({
        changeFactId: deletedFactId,
        kind: "source_deleted",
        sourceFileId: source.sourceFileId,
        previousPath: renamedPath,
        path: null,
        config: {
          searchShardCount: 16,
          linkShardCount: 16,
          manifestShardCount: 16,
          treeShardCount: 16,
          graphNodeShardCount: 16,
          graphEdgeShardCount: 16
        }
      }),
      publicationSettingsSnapshot: {
        publication: { mode: "batch", batchSize: 50, intervalSeconds: 30 }
      },
      publicationMaxAttempts: 3,
      committedAt: "2026-07-17T01:02:00.000Z"
    });
    const assembled = await assemble("2026-07-17T01:02:01.000Z");
    expect(assembled.generationId).not.toBeNull();
    const facts = await sql<Array<{
      kind: string;
      previous_path: string | null;
      path: string | null;
      generation_id: string | null;
    }>>`
      SELECT kind, previous_path, path, generation_id
      FROM focowiki.publication_change_facts
      WHERE id IN (${movedFactId}, ${renamedFactId}, ${deletedFactId})
      ORDER BY created_at, id
    `;
    expect(facts).toEqual([
      {
        kind: "source_moved",
        previous_path: source.path,
        path: movedPath,
        generation_id: assembled.generationId
      },
      {
        kind: "source_renamed",
        previous_path: movedPath,
        path: renamedPath,
        generation_id: assembled.generationId
      },
      {
        kind: "source_deleted",
        previous_path: renamedPath,
        path: null,
        generation_id: assembled.generationId
      }
    ]);
    const effectiveImpacts = await sql<Array<{
      projection_kind: string;
      projection_key: string;
      record_identity: string;
      action: string;
    }>>`
      SELECT projection_kind, projection_key, record_identity, action
      FROM focowiki.publication_impacts
      WHERE generation_id = ${assembled.generationId}
        AND (
          (projection_kind = 'page' AND record_identity = ${source.sourceFileId})
          OR projection_kind = 'directory'
          OR projection_kind = 'root'
        )
      ORDER BY projection_kind, projection_key, record_identity
    `;
    expect(effectiveImpacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        projection_kind: "page",
        record_identity: source.sourceFileId,
        action: "delete"
      }),
      expect.objectContaining({ projection_kind: "directory", projection_key: "docs" }),
      expect.objectContaining({ projection_kind: "directory", projection_key: "archive" })
    ]));
    expect(effectiveImpacts.filter((impact) => impact.projection_kind === "root"))
      .toHaveLength(5);
  });

  it("activates with compare-and-swap and rejects a stale predecessor", async () => {
    const source = await registerSource(1);
    const committed = await commit(source);
    await generations.freezeGeneration({
      knowledgeBaseId,
      generationId: committed.generationId,
      frozenAt: "2026-07-17T02:00:00.000Z"
    });
    expect(await generations.markGenerationState({
      knowledgeBaseId,
      generationId: committed.generationId,
      expectedState: "frozen",
      state: "building",
      updatedAt: "2026-07-17T02:00:01.000Z"
    })).toBe(true);
    expect(await generations.markGenerationState({
      knowledgeBaseId,
      generationId: committed.generationId,
      expectedState: "building",
      state: "validating",
      updatedAt: "2026-07-17T02:00:02.000Z"
    })).toBe(true);

    const checksum = "ab".repeat(32);
    await registerVerifiedObject({
      checksumSha256: checksum,
      formatVersion: 1,
      objectKey: `generated/${checksum}`,
      contentType: "text/markdown",
      sizeBytes: 8,
      verifiedAt: "2026-07-17T02:00:02.000Z"
    });
    await references.stageUpsert({
      knowledgeBaseId,
      generationId: committed.generationId,
      refKind: "page",
      refKey: source.sourceFileId,
      fileId: source.sourceFileId,
      checksumSha256: checksum,
      formatVersion: 1,
      logicalPath: source.path,
      sourceFileId: source.sourceFileId,
      projectionShardId: null
    });
    await projectionRecords.stageUpsert({
      knowledgeBaseId,
      generationId: committed.generationId,
      projectionKind: "search",
      recordId: source.sourceFileId,
      shardKey: "search/v1/0000",
      sourceFileId: source.sourceFileId,
      relatedSourceFileId: null,
      logicalPath: source.path,
      parentPath: null,
      sortKey: source.path,
      title: "Generation integration",
      summary: "Candidate projection record",
      searchableText: "generation integration candidate",
      payload: { path: source.path }
    });
    await projectionSegments.registerAndAttach({
      id: "projection-segment-activation-integration",
      knowledgeBaseId,
      generationId: committed.generationId,
      projectionKind: "search",
      logicalPartition: "search/v1/0000",
      segmentKind: "delta",
      sequenceNumber: 0,
      ordinal: 0,
      formatVersion: 2,
      checksumSha256: "12".repeat(32),
      objectKey: "generated/segment-activation",
      logicalPath: "_segments/search/search/v1/0000/delta.json",
      entryCount: 1,
      encodedBytes: 128,
      firstRecordIdentity: source.sourceFileId,
      lastRecordIdentity: source.sourceFileId,
      baseSegmentId: null,
      lifecycleState: "active"
    });
    await projectionSegments.setGenerationRecordCount({
      knowledgeBaseId,
      generationId: committed.generationId,
      projectionKind: "search",
      logicalPartition: "search/v1/0000",
      recordCount: 1
    });
    expect(await references.findActiveByPath({ knowledgeBaseId, logicalPath: source.path })).toBeNull();
    expect(await projectionRecords.findActive({
      knowledgeBaseId,
      projectionKind: "search",
      recordId: source.sourceFileId
    })).toBeNull();
    expect(await generations.activateGeneration({
      knowledgeBaseId,
      generationId: committed.generationId,
      expectedPredecessorGenerationId: "generation-stale",
      rootManifestChecksumSha256: checksum,
      rootManifestObjectKey: `generated/${checksum}`,
      activatedAt: "2026-07-17T02:00:03.000Z"
    })).toBe(false);
    expect(await generations.activateGeneration({
      knowledgeBaseId,
      generationId: committed.generationId,
      expectedPredecessorGenerationId: null,
      rootManifestChecksumSha256: checksum,
      rootManifestObjectKey: `generated/${checksum}`,
      activatedAt: "2026-07-17T02:00:03.000Z"
    })).toBe(true);
    expect(await references.findActiveByPath({
      knowledgeBaseId,
      logicalPath: source.path
    })).toMatchObject({
      refKind: "page",
      refKey: source.sourceFileId,
      fileId: source.sourceFileId,
      lastChangedGenerationId: committed.generationId,
      objectKey: `generated/${checksum}`
    });
    expect(await projectionRecords.findActive({
      knowledgeBaseId,
      projectionKind: "search",
      recordId: source.sourceFileId
    })).toMatchObject({
      lastChangedGenerationId: committed.generationId,
      logicalPath: source.path,
      payload: { path: source.path }
    });
    const activeSegments = await sql<Array<{ segment_id: string }>>`
      SELECT segment_id
      FROM focowiki.active_projection_segments
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND projection_kind = 'search'
        AND logical_partition = 'search/v1/0000'
    `;
    expect(activeSegments).toEqual([{ segment_id: "projection-segment-activation-integration" }]);
    const activeStatistics = await sql<Array<{ record_count: number }>>`
      SELECT record_count
      FROM focowiki.active_projection_partition_stats
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND projection_kind = 'search'
        AND logical_partition = 'search/v1/0000'
    `;
    expect(Number(activeStatistics[0]?.record_count)).toBe(1);
  });

  it("supersedes the active predecessor before activating its successor", async () => {
    const firstSource = await registerSource(1);
    const first = await commit(firstSource);
    const firstChecksum = "ab".repeat(32);
    await prepareGenerationForActivation({
      generationId: first.generationId,
      source: firstSource,
      checksum: firstChecksum,
      timestampPrefix: "2026-07-17T02:00"
    });
    expect(await generations.activateGeneration({
      knowledgeBaseId,
      generationId: first.generationId,
      expectedPredecessorGenerationId: null,
      rootManifestChecksumSha256: firstChecksum,
      rootManifestObjectKey: `generated/${firstChecksum}`,
      activatedAt: "2026-07-17T02:00:03.000Z"
    })).toBe(true);

    const secondSource = await registerSource(2);
    const second = await commit(secondSource);
    const secondChecksum = "cd".repeat(32);
    await prepareGenerationForActivation({
      generationId: second.generationId,
      source: secondSource,
      checksum: secondChecksum,
      timestampPrefix: "2026-07-17T03:00"
    });
    expect(await generations.activateGeneration({
      knowledgeBaseId,
      generationId: second.generationId,
      expectedPredecessorGenerationId: first.generationId,
      rootManifestChecksumSha256: secondChecksum,
      rootManifestObjectKey: `generated/${secondChecksum}`,
      activatedAt: "2026-07-17T03:00:03.000Z"
    })).toBe(true);

    const states = await sql<Array<{ id: string; state: string }>>`
      SELECT id, state
      FROM focowiki.publication_generations
      WHERE knowledge_base_id = ${knowledgeBaseId}
      ORDER BY activated_at NULLS LAST, id
    `;
    expect(states).toEqual([
      { id: first.generationId, state: "superseded" },
      { id: second.generationId, state: "active" }
    ]);
  });

  it("transfers active path ownership when a deleted path is recreated", async () => {
    const original = await registerSource(1);
    const first = await commit(original);
    const firstChecksum = "ab".repeat(32);
    await prepareGenerationForActivation({
      generationId: first.generationId,
      source: original,
      checksum: firstChecksum,
      timestampPrefix: "2026-07-17T02:00"
    });
    expect(await generations.activateGeneration({
      knowledgeBaseId,
      generationId: first.generationId,
      expectedPredecessorGenerationId: null,
      rootManifestChecksumSha256: firstChecksum,
      rootManifestObjectKey: `generated/${firstChecksum}`,
      activatedAt: "2026-07-17T02:00:03.000Z"
    })).toBe(true);
    await sql`
      INSERT INTO focowiki.active_object_refs (
        knowledge_base_id, ref_kind, ref_key, file_id,
        last_changed_generation_id, checksum_sha256, format_version,
        logical_path, updated_at
      ) VALUES (
        ${knowledgeBaseId}, 'root', 'index.md', 'bundle-file-index',
        ${first.generationId}, ${firstChecksum}, 1,
        'index.md', '2026-07-17T02:00:03.000Z'
      )
    `;

    await sql`
      UPDATE focowiki.source_files
      SET deleted_at = '2026-07-17T02:30:00.000Z'
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND id = ${original.sourceFileId}
    `;
    const recreated = await registerSource(2);
    await sql`
      UPDATE focowiki.source_files
      SET name = 'file-1.md',
          relative_path = ${original.path},
          path_key = ${original.path}
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND id = ${recreated.sourceFileId}
    `;
    const recreatedAtOriginalPath = { ...recreated, path: original.path };
    const second = await commit(recreatedAtOriginalPath);
    const secondChecksum = "cd".repeat(32);
    await prepareGenerationForActivation({
      generationId: second.generationId,
      source: recreatedAtOriginalPath,
      checksum: secondChecksum,
      timestampPrefix: "2026-07-17T03:00"
    });

    expect(await generations.activateGeneration({
      knowledgeBaseId,
      generationId: second.generationId,
      expectedPredecessorGenerationId: first.generationId,
      rootManifestChecksumSha256: secondChecksum,
      rootManifestObjectKey: `generated/${secondChecksum}`,
      activatedAt: "2026-07-17T03:00:03.000Z"
    })).toBe(true);

    const activeAtPath = await sql<Array<{
      ref_kind: string;
      ref_key: string;
      source_file_id: string | null;
    }>>`
      SELECT ref_kind, ref_key, source_file_id
      FROM focowiki.active_object_refs
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND logical_path = ${original.path}
    `;
    expect(activeAtPath).toEqual([{
      ref_kind: "page",
      ref_key: recreated.sourceFileId,
      source_file_id: recreated.sourceFileId
    }]);
    const unrelated = await sql<Array<{ ref_key: string }>>`
      SELECT ref_key
      FROM focowiki.active_object_refs
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND logical_path = 'index.md'
    `;
    expect(unrelated).toEqual([{ ref_key: "index.md" }]);
  });

  it("reattaches one open successor when its predecessor activates", async () => {
    const firstSource = await registerSource(1);
    const first = await commit(firstSource);
    await generations.freezeGeneration({
      knowledgeBaseId,
      generationId: first.generationId,
      frozenAt: "2026-07-17T02:00:00.000Z"
    });
    const secondSource = await registerSource(2);
    const second = await commit(secondSource);
    const checksum = "ef".repeat(32);
    await prepareGenerationForActivation({
      generationId: first.generationId,
      source: firstSource,
      checksum,
      timestampPrefix: "2026-07-17T02:00"
    });
    expect(await generations.activateGeneration({
      knowledgeBaseId,
      generationId: first.generationId,
      expectedPredecessorGenerationId: null,
      rootManifestChecksumSha256: checksum,
      rootManifestObjectKey: `generated/${checksum}`,
      activatedAt: "2026-07-17T02:00:03.000Z"
    })).toBe(true);

    const successor = await generations.freezeGeneration({
      knowledgeBaseId,
      generationId: second.generationId,
      frozenAt: "2026-07-17T03:00:00.000Z"
    });
    expect(successor?.predecessorGenerationId).toBe(first.generationId);
  });

  async function registerSource(index: number) {
    const sessionId = `upload-session-generation-${index}`;
    const entryId = `upload-entry-generation-${index}`;
    const sourceFileId = `source-file-generation-${index}`;
    const path = `docs/file-${index}.md`;
    const content = `# Generation ${index}`;
    const checksum = createHash("sha256").update(content).digest("hex");
    await uploads.createSession({
      id: sessionId,
      knowledgeBaseId,
      idempotencyKey: `generation-${index}`,
      declaredFileCount: 1,
      declaredByteCount: Buffer.byteLength(content),
      expiresAt: "2026-07-18T00:00:00.000Z"
    });
    await uploads.addManifestEntries({
      knowledgeBaseId,
      sessionId,
      entries: [{
        id: entryId,
        sourceFileId,
        path: normalizeSourceRelativePath(path),
        declaredSize: Buffer.byteLength(content),
        checksumSha256: checksum
      }]
    });
    await uploads.sealManifest({
      knowledgeBaseId,
      sessionId,
      manifestFingerprint: checksum
    });
    await uploads.markEntryUploaded({
      knowledgeBaseId,
      sessionId,
      entryId,
      stagingObjectKey: `test/${entryId}.md`,
      receivedSize: Buffer.byteLength(content),
      receivedChecksumSha256: checksum
    });
    const revisions = await sql<Array<{ id: string }>>`
      SELECT id FROM focowiki.source_revisions
      WHERE source_file_id = ${sourceFileId} AND revision = 1
    `;
    return { sourceFileId, sourceRevisionId: revisions[0]!.id, path };
  }

  function commit(source: {
    sourceFileId: string;
    sourceRevisionId: string;
    path: string;
  }, options: { assemble: false }): Promise<SourceCompletionCommitResult>;
  function commit(source: {
    sourceFileId: string;
    sourceRevisionId: string;
    path: string;
  }, options?: { assemble?: true }): Promise<SourceCompletionCommitResult & { generationId: string }>;
  async function commit(source: {
    sourceFileId: string;
    sourceRevisionId: string;
    path: string;
  }, options: { assemble?: boolean } = {}): Promise<SourceCompletionCommitResult> {
    const request = sourceCompletionRequest(source);
    const committed = await generations.commitSourceCompletion(request);
    if (options.assemble === false || committed.generationId) return committed;
    const assembled = await assemble("2026-07-17T01:00:01.000Z");
    if (!assembled.generationId) {
      throw new Error("Expected pending source completion to assemble a generation");
    }
    return {
      generationId: assembled.generationId,
      changeFactId: request.changeFactId,
      impactCount: assembled.impactCount,
      replayed: committed.replayed
    };
  }

  function sourceCompletionRequest(source: {
    sourceFileId: string;
    sourceRevisionId: string;
    path: string;
  }): Parameters<PublicationGenerationRepository["commitSourceCompletion"]>[0] {
    const changeFactId = createChangeFactIdentity({
      knowledgeBaseId,
      sourceRevisionId: source.sourceRevisionId,
      kind: "source_created",
      previousPath: null,
      path: source.path
    });
    const impacts = planPublicationImpacts({
      changeFactId,
      kind: "source_created",
      sourceFileId: source.sourceFileId,
      previousPath: null,
      path: source.path,
      config: {
        searchShardCount: 16,
        linkShardCount: 16,
        manifestShardCount: 16,
        treeShardCount: 16,
        graphNodeShardCount: 16,
        graphEdgeShardCount: 16
      }
    });
    return {
      knowledgeBaseId,
      sourceFileId: source.sourceFileId,
      sourceRevisionId: source.sourceRevisionId,
      kind: "source_created",
      previousPath: null,
      path: source.path,
      resourceRevision: 1,
      operationId: null,
      changeFactId,
      impacts,
      publicationSettingsSnapshot: publicationSettingsSnapshot(),
      publicationMaxAttempts: 3,
      completedAt: "2026-07-17T01:00:00.000Z"
    };
  }

  async function assemble(assembledAt: string) {
    return generations.assemblePendingChanges({
      knowledgeBaseId,
      assemblerJobId: `role-job-generation-assembly-${knowledgeBaseId}`,
      limit: 1_000,
      assembledAt
    });
  }

  function publicationSettingsSnapshot() {
    return {
      publication: { mode: "batch" as const, batchSize: 50, intervalSeconds: 30 }
    };
  }

  async function prepareGenerationForActivation(input: {
    generationId: string;
    source: { sourceFileId: string; path: string };
    checksum: string;
    timestampPrefix: string;
  }) {
    await generations.freezeGeneration({
      knowledgeBaseId,
      generationId: input.generationId,
      frozenAt: `${input.timestampPrefix}:00.000Z`
    });
    expect(await generations.markGenerationState({
      knowledgeBaseId,
      generationId: input.generationId,
      expectedState: "frozen",
      state: "building",
      updatedAt: `${input.timestampPrefix}:01.000Z`
    })).toBe(true);
    expect(await generations.markGenerationState({
      knowledgeBaseId,
      generationId: input.generationId,
      expectedState: "building",
      state: "validating",
      updatedAt: `${input.timestampPrefix}:02.000Z`
    })).toBe(true);
    await registerVerifiedObject({
      checksumSha256: input.checksum,
      formatVersion: 1,
      objectKey: `generated/${input.checksum}`,
      contentType: "text/markdown",
      sizeBytes: 8,
      verifiedAt: `${input.timestampPrefix}:02.000Z`
    });
    await references.stageUpsert({
      knowledgeBaseId,
      generationId: input.generationId,
      refKind: "page",
      refKey: input.source.sourceFileId,
      fileId: input.source.sourceFileId,
      checksumSha256: input.checksum,
      formatVersion: 1,
      logicalPath: input.source.path,
      sourceFileId: input.source.sourceFileId,
      projectionShardId: null
    });
  }

  async function cleanup() {
    await sql.begin(async (transaction) => {
      await transaction`DELETE FROM focowiki.role_jobs WHERE knowledge_base_id = ${knowledgeBaseId}`;
      await transaction`DELETE FROM focowiki.publication_progress WHERE knowledge_base_id = ${knowledgeBaseId}`;
      await transaction`DELETE FROM focowiki.active_object_refs WHERE knowledge_base_id = ${knowledgeBaseId}`;
      await transaction`DELETE FROM focowiki.active_projection_records WHERE knowledge_base_id = ${knowledgeBaseId}`;
      await transaction`DELETE FROM focowiki.generation_object_refs WHERE knowledge_base_id = ${knowledgeBaseId}`;
      await transaction`
        DELETE FROM focowiki.publication_impact_causes cause
        USING focowiki.publication_change_facts fact
        WHERE cause.change_fact_id = fact.id
          AND fact.knowledge_base_id = ${knowledgeBaseId}
      `;
      await transaction`DELETE FROM focowiki.publication_impacts WHERE knowledge_base_id = ${knowledgeBaseId}`;
      await transaction`DELETE FROM focowiki.publication_change_facts WHERE knowledge_base_id = ${knowledgeBaseId}`;
      await transaction`DELETE FROM focowiki.publication_generations WHERE knowledge_base_id = ${knowledgeBaseId}`;
      await transaction`DELETE FROM focowiki.source_dispatch_markers WHERE knowledge_base_id = ${knowledgeBaseId}`;
      await transaction`DELETE FROM focowiki.upload_sessions WHERE knowledge_base_id = ${knowledgeBaseId}`;
      await transaction`DELETE FROM focowiki.source_files WHERE knowledge_base_id = ${knowledgeBaseId}`;
      await transaction`DELETE FROM focowiki.source_directories WHERE knowledge_base_id = ${knowledgeBaseId}`;
      await transaction`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
    });
  }

  async function registerVerifiedObject(input: {
    checksumSha256: string;
    formatVersion: number;
    objectKey: string;
    contentType: string;
    sizeBytes: number;
    verifiedAt: string;
  }) {
    const writeToken = `test-write-${input.checksumSha256.slice(0, 12)}`;
    await objects.reserve({
      ...input,
      writeToken,
      writeStartedAt: input.verifiedAt,
      staleBefore: input.verifiedAt
    });
    await objects.activate({
      ...input,
      writeToken
    });
  }

  function countStatements(fragment: string): number {
    return statements.filter((statement) => statement.includes(fragment)).length;
  }
});
