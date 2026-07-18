import { createHash } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createChangeFactIdentity } from "../src/domain/generation.js";
import { normalizeSourceRelativePath } from "../src/domain/source-path.js";
import { createPostgresPublicationGenerationRepository } from "../src/infrastructure/postgres/publication-generation-repository.js";
import { createPostgresPublicationImpactRepository } from "../src/infrastructure/postgres/publication-impact-repository.js";
import { createPostgresGenerationObjectReferenceRepository } from "../src/infrastructure/postgres/generation-object-reference-repository.js";
import { createPostgresImmutableObjectRepository } from "../src/infrastructure/postgres/immutable-object-repository.js";
import { createPostgresProjectionRecordRepository } from "../src/infrastructure/postgres/projection-record-repository.js";
import { createPostgresUploadSessionRepository } from "../src/infrastructure/postgres/upload-session-repository.js";
import { planPublicationImpacts } from "../src/publication/impact-planner.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("publication generation repository integration", () => {
  const sql = postgres(databaseUrl!, { max: 4 });
  const uploads = createPostgresUploadSessionRepository(sql);
  const generations = createPostgresPublicationGenerationRepository(sql);
  const publicationImpacts = createPostgresPublicationImpactRepository(sql);
  const references = createPostgresGenerationObjectReferenceRepository(sql);
  const objects = createPostgresImmutableObjectRepository(sql);
  const projectionRecords = createPostgresProjectionRecordRepository(sql);
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
    const moved = await generations.commitMutation({
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
    const deletedFactId = createChangeFactIdentity({
      knowledgeBaseId,
      sourceRevisionId: source.sourceRevisionId,
      kind: "source_deleted",
      previousPath: movedPath,
      path: null
    });
    const deleted = await generations.commitMutation({
      knowledgeBaseId,
      sourceFileId: source.sourceFileId,
      sourceRevisionId: source.sourceRevisionId,
      kind: "source_deleted",
      previousPath: movedPath,
      path: null,
      resourceRevision: 3,
      operationId: "operation-delete-a",
      deletionIntentId: "deletion-delete-a",
      changeFactId: deletedFactId,
      impacts: planPublicationImpacts({
        changeFactId: deletedFactId,
        kind: "source_deleted",
        sourceFileId: source.sourceFileId,
        previousPath: movedPath,
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
    expect(deleted.generationId).toBe(moved.generationId);
    const facts = await sql<Array<{
      kind: string;
      previous_path: string | null;
      path: string | null;
    }>>`
      SELECT kind, previous_path, path
      FROM focowiki.publication_change_facts
      WHERE id IN (${movedFactId}, ${deletedFactId})
      ORDER BY created_at, id
    `;
    expect(facts).toEqual([
      { kind: "source_moved", previous_path: source.path, path: movedPath },
      { kind: "source_deleted", previous_path: movedPath, path: null }
    ]);
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

  async function commit(source: {
    sourceFileId: string;
    sourceRevisionId: string;
    path: string;
  }) {
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
    return generations.commitSourceCompletion({
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
      publicationSettingsSnapshot: {
        publication: { mode: "batch", batchSize: 50, intervalSeconds: 30 }
      },
      publicationMaxAttempts: 3,
      completedAt: "2026-07-17T01:00:00.000Z"
    });
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
});
