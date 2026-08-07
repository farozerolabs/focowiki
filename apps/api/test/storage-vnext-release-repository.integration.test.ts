import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPostgresStorageVnextReleaseRepository
} from "../src/storage-vnext/release/postgres-repository.js";
import { deriveStorageVnextReleaseDependencyClosure } from
  "../src/storage-vnext/release/dependency-closure.js";
import {
  createPostgresStorageVnextActiveSearchProjectionRepository
} from "../src/storage-vnext/search/postgres-active-projection.js";
import {
  measureStorageVnextObjectFanout
} from "../src/storage-vnext/ownership/object-fanout-budget.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(
  databaseUrl
  && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedDatabase = hasOwnedTarget ? describe : describe.skip;
describeOwnedDatabase("storage vNext bounded release repository", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const ownerToken = (runOwner ?? "invalid").replaceAll("-", "_");
  const databaseName = `focowiki_vnext_release_${ownerToken}_${randomUUID()
    .replaceAll("-", "").slice(0, 10)}`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 6 });
  const releases = createPostgresStorageVnextReleaseRepository(sql);
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
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

  it("creates exactly one live candidate with bounded facts and dependencies", async () => {
    await createKnowledgeBase("kb-release");
    await createOperation({
      knowledgeBaseId: "kb-release",
      operationPublicId: "operation-release-1",
      idempotencyKey: "release-key-1",
      requestHash: "1".repeat(64)
    });
    const input = {
      publicId: "candidate-release-1",
      knowledgeBaseId: "kb-release",
      operationPublicId: "operation-release-1",
      candidateRootPublicId: "root-release-1",
      expectedActiveRootPublicId: null,
      expectedActiveRevision: 0,
      changedFacts: [
        { kind: "source_file" as const, publicId: "file-a", change: "created" as const },
        { kind: "graph_node" as const, publicId: "node-a", change: "created" as const }
      ],
      dependencies: [
        { kind: "path" as const, publicId: "pages/A.md", reasonCode: "source_path" },
        { kind: "index" as const, publicId: "index.md", reasonCode: "root_index" }
      ],
      idempotency: { key: "release-key-1", requestHash: "1".repeat(64) },
      createdAt: "2026-08-01T01:00:00.000Z"
    };

    const created = await releases.createCandidate(input);
    await expect(releases.createCandidate(input)).resolves.toMatchObject({
      ...created,
      updatedAt: expect.any(String)
    });
    const merged = await releases.createCandidate({
      ...input,
      changedFacts: [{
        kind: "source_file",
        publicId: "file-b",
        change: "created"
      }],
      dependencies: [{
        kind: "path",
        publicId: "pages/B.md",
        reasonCode: "source_path"
      }]
    });
    expect(created).toMatchObject({
      candidateRootPublicId: "root-release-1",
      expectedActiveRevision: 0,
      state: "building",
      changedFactCount: 2,
      affectedDependencyCount: 2
    });
    expect(merged).toMatchObject({
      changedFactCount: 3,
      affectedDependencyCount: 3
    });
    await expect(releases.getLiveCandidate("kb-release")).resolves.toEqual(merged);
    await expect(releases.getActiveRoot("kb-release")).resolves.toBeNull();

    const factPage = await releases.listCandidateChangedFacts({
      candidatePublicId: "candidate-release-1",
      limit: 10,
      cursor: null
    });
    expect(factPage.items).toHaveLength(3);
    await expect(releases.listCandidateDependencies({
      candidatePublicId: "candidate-release-1",
      limit: 10,
      cursor: null
    })).resolves.toMatchObject({
      items: [{ kind: "index" }, { kind: "path" }, { kind: "path" }]
    });

    await createOperation({
      knowledgeBaseId: "kb-release",
      operationPublicId: "operation-release-conflict",
      idempotencyKey: "release-key-conflict",
      requestHash: "2".repeat(64)
    });
    await expect(releases.createCandidate({
      ...input,
      publicId: "candidate-release-conflict",
      operationPublicId: "operation-release-conflict",
      candidateRootPublicId: "root-release-conflict",
      idempotency: {
        key: "release-key-conflict",
        requestHash: "2".repeat(64)
      }
    })).rejects.toMatchObject({
      code: "live_candidate_exists"
    });
  });

  it("stores narrow descriptors and activates one pointer without legacy copies", async () => {
    await expect(releases.hasCandidateCatalogEntries("candidate-release-1"))
      .resolves.toBe(false);
    await createVerifiedObject("object-release-1", "a".repeat(64), 128);
    const shard = {
      publicId: "shard-release-1",
      logicalKind: "generated-markdown",
      firstLogicalPath: "index.md",
      lastLogicalPath: "pages/A.md",
      recordCount: 2,
      byteCount: 128,
      checksum: "a".repeat(64),
      objectId: "object-release-1",
      ordinal: 0
    };
    await releases.addCandidateShards({
      candidatePublicId: "candidate-release-1",
      shards: [shard]
    });
    await releases.addCandidateShards({
      candidatePublicId: "candidate-release-1",
      shards: [shard]
    });
    await releases.addCandidateCatalogEntries({
      candidatePublicId: "candidate-release-1",
      entries: [{
        logicalPath: "index.md",
        kind: "index",
        sourceFilePublicId: null,
        checksum: "a".repeat(64),
        objectId: "object-release-1",
        byteCount: 128,
        ordinal: 0
      }]
    });
    await expect(releases.hasCandidateCatalogEntries("candidate-release-1"))
      .resolves.toBe(true);
    const summaries = {
      candidatePublicId: "candidate-release-1",
      directories: [
        {
          directoryPublicId: null,
          logicalPath: "_index",
          firstLeafPath: null,
          directFileCount: 2,
          descendantFileCount: 5,
          ordinal: 0
        },
        {
          directoryPublicId: null,
          logicalPath: "_index/search",
          firstLeafPath: null,
          directFileCount: 1,
          descendantFileCount: 3,
          ordinal: 1
        },
        {
          directoryPublicId: null,
          logicalPath: "pages",
          firstLeafPath: null,
          directFileCount: 0,
          descendantFileCount: 0,
          ordinal: 2
        }
      ],
      knowledgeBase: {
        sourceFileCount: 1,
        directoryCount: 0,
        generatedEntryCount: 2,
        graphNodeCount: 1,
        graphEdgeCount: 0,
        generatedByteCount: 128
      }
    };
    await releases.replaceCandidateSummaries(summaries);
    await releases.replaceCandidateSummaries(summaries);
    expect(await releases.listCandidateShards({
      candidatePublicId: "candidate-release-1",
      limit: 10,
      cursor: null
    })).toEqual({ items: [shard], nextCursor: null });
    await expect(releases.countCandidateOwnedObjects("candidate-release-1"))
      .resolves.toBe(1);
    expect(await releases.listRootCatalogEntries({
      knowledgeBaseId: "kb-release",
      releaseRootPublicId: "root-release-1",
      limit: 10,
      cursor: null
    })).toMatchObject({ items: [{ logicalPath: "index.md", kind: "index" }] });
    await expect(releases.listDirectorySummaries({
      knowledgeBaseId: "kb-release",
      releaseRootPublicId: "root-release-1",
      limit: 10,
      cursor: null
    })).resolves.toMatchObject({
      items: [
        { logicalPath: "_index" },
        { logicalPath: "_index/search" },
        { logicalPath: "pages" }
      ],
      nextCursor: null
    });
    await expect(releases.getKnowledgeBaseSummary({
      knowledgeBaseId: "kb-release",
      releaseRootPublicId: "root-release-1"
    })).resolves.toMatchObject({ generatedEntryCount: 2 });
    const summaryRows = await sql<Array<{ count: number | string }>>`
      SELECT count(*) AS count
      FROM focowiki.knowledge_base_summaries
      WHERE release_root_public_id = 'root-release-1'
    `;
    expect(summaryRows[0]?.count).toBe("1");

    await expect(releases.markCandidateValidating({
      candidatePublicId: "candidate-release-1"
    })).resolves.toBe(true);
    await createSearchCandidate("kb-release", "search-release-1", 1);
    const validation = {
      candidatePublicId: "candidate-release-1",
      manifestChecksum: "f".repeat(64),
      searchProjectionPublicId: "search-release-1",
      objectOwnerCount: 1,
      searchDocumentCount: 1,
      graphNodeCount: 1,
      graphEdgeCount: 0,
      linkCount: 0,
      generatedEntryCount: 2,
      navigationProfileVersion: 1,
      objectValidationPassed: true,
      searchValidationPassed: true,
      graphValidationPassed: true,
      linkValidationPassed: true,
      countValidationPassed: true,
      pathValidationPassed: true,
      validatedAt: "2026-08-01T01:30:00.000Z"
    };
    await expect(releases.recordCandidateValidation({
      ...validation,
      pathValidationPassed: false
    })).resolves.toBe(false);
    const unvalidatedProfile = await sql<Array<{
      navigation_profile_version: number;
    }>>`
      SELECT navigation_profile_version
      FROM focowiki.release_roots
      WHERE public_id = 'root-release-1'
    `;
    expect(unvalidatedProfile[0]?.navigation_profile_version).toBe(0);
    await expect(releases.markCandidateReady({
      candidatePublicId: "candidate-release-1",
      manifestChecksum: "f".repeat(64)
    })).resolves.toBe(false);
    await expect(releases.recordCandidateValidation(validation)).resolves.toBe(true);
    await expect(releases.markCandidateReady({
      candidatePublicId: "candidate-release-1",
      manifestChecksum: "f".repeat(64)
    })).resolves.toBe(true);

    const activationInput = {
      knowledgeBaseId: "kb-release",
      candidatePublicId: "candidate-release-1",
      expectedActiveRootPublicId: null,
      expectedActiveRevision: 0,
      searchProjectionPublicId: "search-release-1",
      rollbackExpiresAt: null,
      eventPublicId: "event-release-1",
      eventExpiresAt: "2026-09-01T01:00:00.000Z",
      activatedAt: "2026-08-01T02:00:00.000Z"
    };
    await expect(releases.activateCandidate({
      ...activationInput,
      searchProjectionPublicId: "search-release-mismatch"
    })).resolves.toEqual({ outcome: "not_ready" });
    await expect(releases.activateCandidate({
      ...activationInput,
      expectedActiveRevision: 1
    })).resolves.toEqual({
      outcome: "stale",
      activeRootPublicId: null,
      activeRevision: 0
    });
    await expect(releases.getActiveRoot("kb-release")).resolves.toBeNull();
    await expect(releases.getLiveCandidate("kb-release")).resolves.toMatchObject({
      publicId: "candidate-release-1",
      state: "ready"
    });
    const activation = await releases.activateCandidate(activationInput);
    expect(activation).toMatchObject({
      outcome: "activated",
      snapshot: {
        releaseRootPublicId: "root-release-1",
        revision: 1,
        searchProjectionPublicId: "search-release-1",
        navigationProfileVersion: 1
      },
      rollbackRootPublicId: null
    });
    const restartedReleases = createPostgresStorageVnextReleaseRepository(sql);
    await expect(restartedReleases.activateCandidate(activationInput)).resolves.toMatchObject({
      outcome: "activated",
      snapshot: {
        activatedByOperationPublicId: "operation-release-1",
        releaseRootPublicId: "root-release-1",
        searchProjectionPublicId: "search-release-1",
        revision: 1
      }
    });
    await expect(releases.getLiveCandidate("kb-release")).resolves.toBeNull();
    await expect(releases.getActiveRoot("kb-release")).resolves.toMatchObject({
      publicId: "root-release-1",
      role: "active",
      manifestChecksum: "f".repeat(64),
      navigationProfileVersion: 1
    });
    await expect(
      createPostgresStorageVnextActiveSearchProjectionRepository(sql)
        .getActiveProjection("kb-release")
    ).resolves.toMatchObject({
      publicId: "search-release-1",
      knowledgeBaseId: "kb-release",
      providerIndexUid: "index-search-release-1",
      documentChecksum: "d".repeat(64),
      documentCount: 1
    });
    await expect(releases.listReleaseEvents({
      knowledgeBaseId: "kb-release",
      limit: 10,
      cursor: null
    })).resolves.toMatchObject({
      items: [{ outcome: "activated", candidatePublicId: "candidate-release-1" }]
    });

    const counts = await sql<Array<{
      roots: number | string;
      candidates: number | string;
      shards: number | string;
      root_shards: number | string;
      owners: number | string;
      events: number | string;
    }>>`
      SELECT
        (SELECT count(*) FROM focowiki.release_roots
          WHERE knowledge_base_id = 'kb-release') AS roots,
        (SELECT count(*) FROM focowiki.release_candidates
          WHERE knowledge_base_id = 'kb-release') AS candidates,
        (SELECT count(*) FROM focowiki.release_shards
          WHERE knowledge_base_id = 'kb-release') AS shards,
        (SELECT count(*) FROM focowiki.release_root_shards
          WHERE knowledge_base_id = 'kb-release') AS root_shards,
        (SELECT count(*) FROM focowiki.object_owners
          WHERE knowledge_base_id = 'kb-release') AS owners,
        (SELECT count(*) FROM focowiki.release_event_summaries
          WHERE knowledge_base_id = 'kb-release') AS events
    `;
    expect(counts[0]).toEqual({
      roots: "1",
      candidates: "0",
      shards: "1",
      root_shards: "1",
      owners: "1",
      events: "1"
    });
    const forbiddenTables = await sql<Array<{ table_name: string }>>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'focowiki'
        AND table_name = ANY(${[
          "publication_generations",
          "generation_projection_records",
          "generation_object_refs",
          "active_projection_records",
          "active_object_refs"
        ]})
    `;
    expect(forbiddenTables).toEqual([]);
  });

  it("replaces a changed candidate shard in the same logical slot", async () => {
    const knowledgeBaseId = "kb-release-shard-retry";
    const operationPublicId = "operation-release-shard-retry";
    const candidatePublicId = "candidate-release-shard-retry";
    const candidateRootPublicId = "root-release-shard-retry";
    await createKnowledgeBase(knowledgeBaseId);
    await createOperation({
      knowledgeBaseId,
      operationPublicId,
      idempotencyKey: "release-shard-retry-key",
      requestHash: "8".repeat(64)
    });
    await releases.createCandidate({
      publicId: candidatePublicId,
      knowledgeBaseId,
      operationPublicId,
      candidateRootPublicId,
      expectedActiveRootPublicId: null,
      expectedActiveRevision: 0,
      changedFacts: [],
      dependencies: [],
      idempotency: {
        key: "release-shard-retry-key",
        requestHash: "8".repeat(64)
      },
      createdAt: "2026-08-01T01:30:00.000Z"
    });
    await createVerifiedObject(
      "object-release-shard-retry-old",
      "8".repeat(64),
      128
    );
    await createVerifiedObject(
      "object-release-shard-retry-new",
      "9".repeat(64),
      144
    );
    const oldShard = {
      publicId: "shard-release-shard-retry-old",
      logicalKind: "directory_navigation",
      firstLogicalPath: "pages/retry",
      lastLogicalPath: "pages/retry",
      recordCount: 1,
      byteCount: 128,
      checksum: "8".repeat(64),
      objectId: "object-release-shard-retry-old",
      ordinal: 0
    };
    const newShard = {
      ...oldShard,
      publicId: "shard-release-shard-retry-new",
      byteCount: 144,
      checksum: "9".repeat(64),
      objectId: "object-release-shard-retry-new"
    };
    await releases.addCandidateShards({
      candidatePublicId,
      shards: [oldShard]
    });
    await releases.addCandidateShards({
      candidatePublicId,
      shards: [newShard]
    });

    await expect(releases.listCandidateShards({
      candidatePublicId,
      limit: 10,
      cursor: null
    })).resolves.toEqual({ items: [newShard], nextCursor: null });
    const rows = await sql<Array<{
      attachments: number | string;
      old_owners: number | string;
      new_owners: number | string;
    }>>`
      SELECT
        (SELECT count(*) FROM focowiki.release_root_shards
         WHERE release_root_public_id = ${candidateRootPublicId}) AS attachments,
        (SELECT count(*) FROM focowiki.object_owners
         WHERE owner_public_id = ${candidateRootPublicId}
           AND object_id = ${oldShard.objectId}) AS old_owners,
        (SELECT count(*) FROM focowiki.object_owners
         WHERE owner_public_id = ${candidateRootPublicId}
           AND object_id = ${newShard.objectId}) AS new_owners
    `;
    expect(rows[0]).toEqual({
      attachments: "1",
      old_owners: "0",
      new_owners: "1"
    });
    const cleanupActions = await sql<Array<{
      operation_public_id: string;
      knowledge_base_id: string;
      action_kind: string;
      resource_kind: string;
      resource_public_id: string;
      state: string;
    }>>`
      SELECT operation_public_id, knowledge_base_id, action_kind,
             resource_kind, resource_public_id, state
      FROM focowiki.cleanup_actions
      WHERE operation_public_id = ${operationPublicId}
      ORDER BY resource_public_id
    `;
    expect(cleanupActions).toEqual([{
      operation_public_id: operationPublicId,
      knowledge_base_id: knowledgeBaseId,
      action_kind: "candidate_projection",
      resource_kind: "superseded_candidate_object",
      resource_public_id: oldShard.objectId,
      state: "queued"
    }]);
  });

  it("keeps maintenance active and rollback roots standalone while retiring old lineage", async () => {
    const knowledgeBaseId = "kb-release-maintenance-compact";
    await createKnowledgeBase(knowledgeBaseId);
    await createVerifiedObject("object-maintenance-base", "a".repeat(64), 32);
    await createVerifiedObject("object-maintenance-active", "b".repeat(64), 32);
    await createVerifiedObject("object-maintenance-next", "c".repeat(64), 32);

    await activateSimpleRoot({
      knowledgeBaseId,
      sequence: 1,
      operationKind: "publication",
      objectId: "object-maintenance-base",
      checksum: "a".repeat(64),
      expectedActiveRootPublicId: null,
      expectedActiveRevision: 0
    });
    await activateSimpleRoot({
      knowledgeBaseId,
      sequence: 2,
      operationKind: "publication",
      objectId: "object-maintenance-active",
      checksum: "b".repeat(64),
      expectedActiveRootPublicId: "root-maintenance-compact-1",
      expectedActiveRevision: 1
    });
    await activateSimpleRoot({
      knowledgeBaseId,
      sequence: 3,
      operationKind: "maintenance",
      objectId: "object-maintenance-next",
      checksum: "c".repeat(64),
      expectedActiveRootPublicId: "root-maintenance-compact-2",
      expectedActiveRevision: 2
    });

    const roots = await sql<Array<{
      public_id: string;
      base_root_public_id: string | null;
      root_role: string;
    }>>`
      SELECT public_id, base_root_public_id, root_role
      FROM focowiki.release_roots
      WHERE knowledge_base_id = ${knowledgeBaseId}
      ORDER BY root_role, public_id
    `;
    expect(roots).toEqual([
      {
        public_id: "root-maintenance-compact-3",
        base_root_public_id: null,
        root_role: "active"
      },
      {
        public_id: "root-maintenance-compact-2",
        base_root_public_id: null,
        root_role: "rollback"
      }
    ]);
    const owners = await sql<Array<{
      object_id: string;
      owner_kind: string;
    }>>`
      SELECT object_id, owner_kind
      FROM focowiki.object_owners
      WHERE knowledge_base_id = ${knowledgeBaseId}
      ORDER BY object_id, owner_kind
    `;
    expect(owners).toEqual([
      { object_id: "object-maintenance-active", owner_kind: "rollback_root" },
      { object_id: "object-maintenance-next", owner_kind: "active_root" }
    ]);
    const cleanup = await sql<Array<{
      operation_public_id: string;
      resource_public_id: string;
    }>>`
      SELECT operation_public_id, resource_public_id
      FROM focowiki.cleanup_actions
      WHERE knowledge_base_id = ${knowledgeBaseId}
      ORDER BY resource_public_id
    `;
    expect(cleanup).toContainEqual({
      operation_public_id: "operation-maintenance-compact-3",
      resource_public_id: "object-maintenance-base"
    });
  });

  it("scopes identical release shard descriptors to each knowledge base", async () => {
    const shard = {
      publicId: "shard-cross-knowledge-base",
      logicalKind: "generated-markdown",
      firstLogicalPath: "index.md",
      lastLogicalPath: "index.md",
      recordCount: 1,
      byteCount: 96,
      checksum: "f".repeat(64),
      objectId: "object-cross-knowledge-base",
      ordinal: 0
    };
    await createVerifiedObject(shard.objectId, shard.checksum, shard.byteCount);
    for (const suffix of ["a", "b"]) {
      const knowledgeBaseId = `kb-release-cross-${suffix}`;
      const operationPublicId = `operation-release-cross-${suffix}`;
      const candidatePublicId = `candidate-release-cross-${suffix}`;
      await createKnowledgeBase(knowledgeBaseId);
      await createOperation({
        knowledgeBaseId,
        operationPublicId,
        idempotencyKey: `release-cross-key-${suffix}`,
        requestHash: suffix.repeat(64)
      });
      await releases.createCandidate({
        publicId: candidatePublicId,
        knowledgeBaseId,
        operationPublicId,
        candidateRootPublicId: `root-release-cross-${suffix}`,
        expectedActiveRootPublicId: null,
        expectedActiveRevision: 0,
        changedFacts: [],
        dependencies: [],
        idempotency: {
          key: `release-cross-key-${suffix}`,
          requestHash: suffix.repeat(64)
        },
        createdAt: "2026-08-01T01:00:00.000Z"
      });
      await expect(releases.addCandidateShards({
        candidatePublicId,
        shards: [shard]
      })).resolves.toEqual({
        createdDescriptorCount: 1,
        reusedDescriptorCount: 0,
        attachedCount: 1
      });
    }
    const rows = await sql<Array<{ total: number | string }>>`
      SELECT count(*) AS total
      FROM focowiki.release_shards
      WHERE public_id = ${shard.publicId}
    `;
    expect(rows[0]?.total).toBe("2");
  });

  it("rejects a candidate above the bounded small-sample completeness budget", async () => {
    await createKnowledgeBase("kb-fanout");
    await createOperation({
      knowledgeBaseId: "kb-fanout",
      operationPublicId: "operation-fanout",
      idempotencyKey: "fanout-key",
      requestHash: "7".repeat(64)
    });
    await releases.createCandidate({
      publicId: "candidate-fanout",
      knowledgeBaseId: "kb-fanout",
      operationPublicId: "operation-fanout",
      candidateRootPublicId: "root-fanout",
      expectedActiveRootPublicId: null,
      expectedActiveRevision: 0,
      changedFacts: [{
        kind: "source_file",
        publicId: "file-fanout",
        change: "created"
      }],
      dependencies: [],
      idempotency: { key: "fanout-key", requestHash: "7".repeat(64) },
      createdAt: "2026-08-01T03:00:00.000Z"
    });
    const overBudgetObjectCount = 141;
    const shards = [];
    for (let index = 0; index < overBudgetObjectCount; index += 1) {
      const checksum = index.toString(16).padStart(2, "0").repeat(32);
      const objectId = `object-fanout-${index}`;
      await createVerifiedObject(objectId, checksum, 10);
      shards.push({
        publicId: `shard-fanout-${index}`,
        logicalKind: "generated-markdown",
        firstLogicalPath: `pages/${index}.md`,
        lastLogicalPath: `pages/${index}.md`,
        recordCount: 1,
        byteCount: 10,
        checksum,
        objectId,
        ordinal: index
      });
    }
    await releases.addCandidateShards({
      candidatePublicId: "candidate-fanout",
      shards
    });
    await releases.replaceCandidateSummaries({
      candidatePublicId: "candidate-fanout",
      directories: [],
      knowledgeBase: {
        sourceFileCount: 1,
        directoryCount: 0,
        generatedEntryCount: overBudgetObjectCount,
        graphNodeCount: 0,
        graphEdgeCount: 0,
        generatedByteCount: overBudgetObjectCount * 10
      }
    });
    await createSearchCandidate("kb-fanout", "search-fanout", 1);
    await expect(releases.markCandidateValidating({
      candidatePublicId: "candidate-fanout"
    })).resolves.toBe(true);
    await expect(releases.recordCandidateValidation({
      candidatePublicId: "candidate-fanout",
      manifestChecksum: "8".repeat(64),
      searchProjectionPublicId: "search-fanout",
      objectOwnerCount: overBudgetObjectCount,
      searchDocumentCount: 1,
      graphNodeCount: 0,
      graphEdgeCount: 0,
      linkCount: 0,
      generatedEntryCount: overBudgetObjectCount,
      navigationProfileVersion: 1,
      objectValidationPassed: true,
      searchValidationPassed: true,
      graphValidationPassed: true,
      linkValidationPassed: true,
      countValidationPassed: true,
      pathValidationPassed: true,
      validatedAt: "2026-08-01T03:01:00.000Z"
    })).resolves.toBe(false);
    await expect(releases.markCandidateReady({
      candidatePublicId: "candidate-fanout",
      manifestChecksum: "8".repeat(64)
    })).resolves.toBe(false);
  });

  it("persists the exact deterministic move dependency closure", async () => {
    await createKnowledgeBase("kb-release-closure");
    await createOperation({
      knowledgeBaseId: "kb-release-closure",
      operationPublicId: "operation-release-closure",
      idempotencyKey: "release-key-closure",
      requestHash: "3".repeat(64)
    });
    const closure = deriveStorageVnextReleaseDependencyClosure({
      knowledgeBaseId: "kb-release-closure",
      mutationKind: "move",
      sourceFilePublicIds: ["file-closure"],
      sourceLogicalPaths: ["Guides/New/Guide.md"],
      previousSourceLogicalPaths: ["Manuals/Old/Guide.md"],
      directoryLogicalPaths: [],
      searchSourceFilePublicIds: ["file-closure"],
      graphSourceFilePublicIds: ["file-related"],
      graphEdgePublicIds: ["edge-closure"]
    });
    await releases.createCandidate({
      publicId: "candidate-release-closure",
      knowledgeBaseId: "kb-release-closure",
      operationPublicId: "operation-release-closure",
      candidateRootPublicId: "root-release-closure",
      expectedActiveRootPublicId: null,
      expectedActiveRevision: 0,
      changedFacts: [{
        kind: "source_file",
        publicId: "file-closure",
        change: "updated"
      }],
      dependencies: closure.dependencies,
      idempotency: {
        key: "release-key-closure",
        requestHash: "3".repeat(64)
      },
      createdAt: "2026-08-01T03:00:00.000Z"
    });
    const stored = await releases.listCandidateDependencies({
      candidatePublicId: "candidate-release-closure",
      limit: 1_000,
      cursor: null
    });
    expect(stored).toEqual({ items: closure.dependencies, nextCursor: null });
    expect(stored.items).toContainEqual({
      kind: "ancestor",
      publicId: "pages/Manuals/Old",
      reasonCode: "directory_ancestor"
    });
    expect(stored.items).toContainEqual({
      kind: "ancestor",
      publicId: "pages/Guides/New",
      reasonCode: "directory_ancestor"
    });
  });

  it("releases nonactive candidate owners across termination, retry, and restart", async () => {
    const knowledgeBaseId = "kb-release-terminal";
    const retryOperation = {
      knowledgeBaseId,
      operationPublicId: "operation-terminal-retry",
      idempotencyKey: "release-terminal-retry-key",
      requestHash: "5".repeat(64)
    };
    await createKnowledgeBase(knowledgeBaseId);
    await createOperation(retryOperation);
    const outcomes = ["failed", "cancelled", "superseded", "timed_out"] as const;

    for (const [index, outcome] of outcomes.entries()) {
      const sequence = index + 1;
      const operation = sequence <= 2 ? retryOperation : {
        knowledgeBaseId,
        operationPublicId: `operation-terminal-${sequence}`,
        idempotencyKey: `release-terminal-key-${sequence}`,
        requestHash: String(sequence + 4).repeat(64)
      };
      if (sequence > 2) await createOperation(operation);
      const candidatePublicId = `candidate-terminal-${sequence}`;
      const rootPublicId = `root-terminal-${sequence}`;
      const searchPublicId = `search-terminal-${sequence}`;
      const objectId = `object-terminal-${sequence}`;
      const checksum = String(sequence + 5).repeat(64);
      await createVerifiedObject(objectId, checksum, 32);
      await releases.createCandidate({
        publicId: candidatePublicId,
        knowledgeBaseId,
        operationPublicId: operation.operationPublicId,
        candidateRootPublicId: rootPublicId,
        expectedActiveRootPublicId: null,
        expectedActiveRevision: 0,
        changedFacts: [{
          kind: "source_file",
          publicId: `file-terminal-${sequence}`,
          change: "updated"
        }],
        dependencies: [{
          kind: "path",
          publicId: `pages/Terminal-${sequence}.md`,
          reasonCode: "source_path"
        }],
        idempotency: {
          key: operation.idempotencyKey,
          requestHash: operation.requestHash
        },
        createdAt: `2026-08-${String(sequence + 10).padStart(2, "0")}T01:00:00.000Z`
      });
      await releases.addCandidateShards({
        candidatePublicId,
        shards: [{
          publicId: `shard-terminal-${sequence}`,
          logicalKind: "generated-markdown",
          firstLogicalPath: `pages/Terminal-${sequence}.md`,
          lastLogicalPath: `pages/Terminal-${sequence}.md`,
          recordCount: 1,
          byteCount: 32,
          checksum,
          objectId,
          ordinal: 0
        }]
      });
      await releases.markCandidateValidating({ candidatePublicId });
      await createSearchCandidate(knowledgeBaseId, searchPublicId, sequence);
      await expect(releases.recordCandidateValidation({
        candidatePublicId,
        manifestChecksum: checksum,
        searchProjectionPublicId: searchPublicId,
        objectOwnerCount: 1,
        searchDocumentCount: 1,
        graphNodeCount: 0,
        graphEdgeCount: 0,
        linkCount: 0,
        generatedEntryCount: 0,
        navigationProfileVersion: 1,
        objectValidationPassed: true,
        searchValidationPassed: true,
        graphValidationPassed: true,
        linkValidationPassed: true,
        countValidationPassed: true,
        pathValidationPassed: true,
        validatedAt: `2026-08-${String(sequence + 10).padStart(2, "0")}T02:00:00.000Z`
      })).resolves.toBe(true);
      await expect(releases.markCandidateReady({
        candidatePublicId,
        manifestChecksum: checksum
      })).resolves.toBe(true);

      const restartedReleases = createPostgresStorageVnextReleaseRepository(sql);
      await expect(restartedReleases.getLiveCandidate(knowledgeBaseId)).resolves
        .toMatchObject({ publicId: candidatePublicId, state: "ready" });
      const terminalInput = {
        knowledgeBaseId,
        candidatePublicId,
        outcome,
        reasonCode: `release_${outcome}`,
        safeMessage: null,
        eventPublicId: `event-terminal-${sequence}`,
        eventExpiresAt: "2027-01-01T00:00:00.000Z",
        terminatedAt: `2026-08-${String(sequence + 10).padStart(2, "0")}T03:00:00.000Z`
      };
      await expect(restartedReleases.terminateCandidate(terminalInput)).resolves.toBe(true);
      await expect(restartedReleases.terminateCandidate(terminalInput)).resolves.toBe(true);

      const counts = await sql<Array<{
        candidates: number | string;
        roots: number | string;
        shards: number | string;
        attachments: number | string;
        owners: number | string;
        validations: number | string;
        searches: number | string;
      }>>`
        SELECT
          (SELECT count(*) FROM focowiki.release_candidates
            WHERE knowledge_base_id = ${knowledgeBaseId}) AS candidates,
          (SELECT count(*) FROM focowiki.release_roots
            WHERE knowledge_base_id = ${knowledgeBaseId}) AS roots,
          (SELECT count(*) FROM focowiki.release_shards
            WHERE knowledge_base_id = ${knowledgeBaseId}) AS shards,
          (SELECT count(*) FROM focowiki.release_root_shards
            WHERE knowledge_base_id = ${knowledgeBaseId}) AS attachments,
          (SELECT count(*) FROM focowiki.object_owners
            WHERE knowledge_base_id = ${knowledgeBaseId}) AS owners,
          (SELECT count(*) FROM focowiki.release_candidate_validations
            WHERE knowledge_base_id = ${knowledgeBaseId}) AS validations,
          (SELECT count(*) FROM focowiki.search_projections
            WHERE knowledge_base_id = ${knowledgeBaseId}
              AND projection_role = 'candidate') AS searches
      `;
      expect(counts[0]).toEqual({
        candidates: "0",
        roots: "0",
        shards: "0",
        attachments: "0",
        owners: "0",
        validations: "0",
        searches: "0"
      });
      const objects = await sql<Array<{ zero_owner_since: Date | null }>>`
        SELECT zero_owner_since
        FROM focowiki.object_registrations
        WHERE object_id = ${objectId}
      `;
      expect(objects[0]?.zero_owner_since).toBeInstanceOf(Date);
    }

    const events = await releases.listReleaseEvents({
      knowledgeBaseId,
      limit: 10,
      cursor: null
    });
    expect(new Set(events.items.map((item) => item.outcome))).toEqual(
      new Set(outcomes)
    );
    await expect(releases.deleteExpiredReleaseEvents({
      expiredBefore: "2027-01-02T00:00:00.000Z",
      limit: 2
    })).resolves.toBe(2);
    await expect(releases.deleteExpiredReleaseEvents({
      expiredBefore: "2027-01-02T00:00:00.000Z",
      limit: 2
    })).resolves.toBe(2);
    await expect(releases.deleteExpiredReleaseEvents({
      expiredBefore: "2027-01-02T00:00:00.000Z",
      limit: 2
    })).resolves.toBe(1);
    await expect(releases.deleteExpiredReleaseEvents({
      expiredBefore: "2027-01-02T00:00:00.000Z",
      limit: 2
    })).resolves.toBe(0);
    await expect(releases.listReleaseEvents({
      knowledgeBaseId,
      limit: 10,
      cursor: null
    })).resolves.toEqual({ items: [], nextCursor: null });
  });

  it("removes a same-identity search candidate when termination precedes validation", async () => {
    const knowledgeBaseId = "kb-release-unvalidated-terminal";
    const operationPublicId = "operation-release-unvalidated-terminal";
    const candidatePublicId = "candidate-release-unvalidated-terminal";
    await createKnowledgeBase(knowledgeBaseId);
    await createOperation({
      knowledgeBaseId,
      operationPublicId,
      idempotencyKey: "release-unvalidated-terminal-key",
      requestHash: "9".repeat(64)
    });
    await releases.createCandidate({
      publicId: candidatePublicId,
      knowledgeBaseId,
      operationPublicId,
      candidateRootPublicId: "root-release-unvalidated-terminal",
      expectedActiveRootPublicId: null,
      expectedActiveRevision: 0,
      changedFacts: [{
        kind: "source_file",
        publicId: "file-release-unvalidated-terminal",
        change: "updated"
      }],
      dependencies: [],
      idempotency: {
        key: "release-unvalidated-terminal-key",
        requestHash: "9".repeat(64)
      },
      createdAt: "2026-08-20T01:00:00.000Z"
    });
    await releases.markCandidateValidating({ candidatePublicId });
    await createSearchCandidate(knowledgeBaseId, candidatePublicId, 1);

    await expect(releases.terminateCandidate({
      knowledgeBaseId,
      candidatePublicId,
      outcome: "failed",
      reasonCode: "release_failed",
      safeMessage: null,
      eventPublicId: "event-release-unvalidated-terminal",
      eventExpiresAt: "2027-01-01T00:00:00.000Z",
      terminatedAt: "2026-08-20T02:00:00.000Z"
    })).resolves.toBe(true);

    const candidates = await sql<Array<{ total: number | string }>>`
      SELECT count(*) AS total
      FROM focowiki.search_projections
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND projection_role = 'candidate'
    `;
    expect(candidates[0]?.total).toBe("0");
  });

  it("bounds live shard and owner counts with periodic release-lineage compaction", async () => {
    const knowledgeBaseId = "kb-release-sharing";
    await createKnowledgeBase(knowledgeBaseId);
    await sql`
      INSERT INTO focowiki.source_directories (
        public_id, knowledge_base_id, parent_public_id,
        logical_path, normalized_path, title, revision
      ) VALUES (
        'directory-sharing', ${knowledgeBaseId}, NULL,
        'Moved-9', 'moved-9', 'Moved directory', 9
      )
    `;
    await createVerifiedObject("object-shared", "d".repeat(64), 64);
    const sharedShard = {
      publicId: "shard-shared",
      logicalKind: "generated-markdown",
      firstLogicalPath: "index.md",
      lastLogicalPath: "pages/Shared.md",
      recordCount: 2,
      byteCount: 64,
      checksum: "d".repeat(64),
      objectId: "object-shared",
      ordinal: 0
    };

    for (let cycle = 1; cycle <= 9; cycle += 1) {
      const operationPublicId = `operation-sharing-${cycle}`;
      const candidatePublicId = `candidate-sharing-${cycle}`;
      const rootPublicId = `root-sharing-${cycle}`;
      const searchPublicId = `search-sharing-${cycle}`;
      const requestHash = (cycle + 3).toString(16).repeat(64);
      const changedChecksum = cycle.toString(16).repeat(64);
      const changedObjectId = `object-changed-${cycle}`;
      const changedShard = {
        publicId: `shard-changed-${cycle}`,
        logicalKind: "generated-markdown",
        firstLogicalPath: "pages/Changed.md",
        lastLogicalPath: "pages/Changed.md",
        recordCount: 1,
        byteCount: 32 + cycle,
        checksum: changedChecksum,
        objectId: changedObjectId,
        ordinal: 1
      };
      await createVerifiedObject(changedObjectId, changedChecksum, 32 + cycle);
      await createOperation({
        knowledgeBaseId,
        operationPublicId,
        idempotencyKey: `release-sharing-key-${cycle}`,
        requestHash
      });
      await releases.createCandidate({
        publicId: candidatePublicId,
        knowledgeBaseId,
        operationPublicId,
        candidateRootPublicId: rootPublicId,
        expectedActiveRootPublicId: cycle === 1 ? null : `root-sharing-${cycle - 1}`,
        expectedActiveRevision: cycle - 1,
        changedFacts: [{
          kind: "source_file",
          publicId: "file-sharing",
          change: cycle === 1 ? "created" : "updated"
        }],
        dependencies: [{
          kind: "path",
          publicId: "pages/Changed.md",
          reasonCode: "source_path"
        }],
        idempotency: {
          key: `release-sharing-key-${cycle}`,
          requestHash
        },
        createdAt: `2026-08-${String(cycle).padStart(2, "0")}T01:00:00.000Z`
      });
      const attachment = await releases.addCandidateShards({
        candidatePublicId,
        shards: [sharedShard, changedShard]
      });
      expect(attachment).toEqual(cycle === 1
        ? { createdDescriptorCount: 2, reusedDescriptorCount: 0, attachedCount: 2 }
        : { createdDescriptorCount: 1, reusedDescriptorCount: 1, attachedCount: 2 });
      await expect(releases.addCandidateShards({
        candidatePublicId,
        shards: [sharedShard, changedShard]
      })).resolves.toEqual({
        createdDescriptorCount: 0,
        reusedDescriptorCount: 2,
        attachedCount: 0
      });
      await releases.replaceCandidateSummaries({
        candidatePublicId,
        directories: [{
          directoryPublicId: "directory-sharing",
          logicalPath: `pages/Moved-${cycle}`,
          firstLeafPath: null,
          directFileCount: 0,
          descendantFileCount: 0,
          ordinal: 0
        }],
        knowledgeBase: {
          sourceFileCount: 1,
          directoryCount: 0,
          generatedEntryCount: 0,
          graphNodeCount: 0,
          graphEdgeCount: 0,
          generatedByteCount: 0
        }
      });
      if (cycle === 5) {
        await expect(measureStorageVnextObjectFanout(sql, {
          knowledgeBaseId,
          candidateRootPublicId: rootPublicId
        })).resolves.toMatchObject({
          activeGeneratedObjectCount: 2,
          candidateGeneratedObjectCount: 2,
          candidateOnlyObjectCount: 1
        });
      }
      await releases.markCandidateValidating({ candidatePublicId });
      await createSearchCandidate(knowledgeBaseId, searchPublicId, cycle);
      await expect(releases.recordCandidateValidation({
        candidatePublicId,
        manifestChecksum: "e".repeat(64),
        searchProjectionPublicId: searchPublicId,
        objectOwnerCount: 2,
        searchDocumentCount: 1,
        graphNodeCount: 0,
        graphEdgeCount: 0,
        linkCount: 0,
        generatedEntryCount: 0,
        navigationProfileVersion: 1,
        objectValidationPassed: true,
        searchValidationPassed: true,
        graphValidationPassed: true,
        linkValidationPassed: true,
        countValidationPassed: true,
        pathValidationPassed: true,
        validatedAt: `2026-08-${String(cycle).padStart(2, "0")}T02:00:00.000Z`
      })).resolves.toBe(true);
      await releases.markCandidateReady({
        candidatePublicId,
        manifestChecksum: "e".repeat(64)
      });
      const day = String(cycle).padStart(2, "0");
      const activationInput = {
        knowledgeBaseId,
        candidatePublicId,
        expectedActiveRootPublicId: cycle === 1 ? null : `root-sharing-${cycle - 1}`,
        expectedActiveRevision: cycle - 1,
        searchProjectionPublicId: searchPublicId,
        rollbackExpiresAt: cycle === 1
          ? null
          : `2026-08-${day}T04:00:00.000Z`,
        eventPublicId: `event-sharing-activate-${cycle}`,
        eventExpiresAt: "2027-01-01T00:00:00.000Z",
        activatedAt: `2026-08-${day}T03:00:00.000Z`
      };
      await expect(releases.activateCandidate(activationInput)).resolves.toMatchObject({
        outcome: "activated"
      });

      expect(await liveReleaseCounts(knowledgeBaseId)).toEqual(cycle === 9
        ? { roots: 2, shards: 3, attachments: 4, owners: 4 }
        : {
            roots: cycle,
            shards: cycle + 1,
            attachments: cycle * 2,
            owners: cycle * 2
          });
    }

    const compactionCleanup = await sql<Array<{
      operation_public_id: string;
      resource_public_id: string;
      state: string;
    }>>`
      SELECT operation_public_id, resource_public_id, state
      FROM focowiki.cleanup_actions
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND operation_public_id = 'operation-sharing-9'
      ORDER BY resource_public_id
    `;
    expect(compactionCleanup).toEqual(
      Array.from({ length: 7 }, (_, index) => ({
        operation_public_id: "operation-sharing-9",
        resource_public_id: `object-changed-${index + 1}`,
        state: "queued"
      }))
    );

    await expect(releases.expireRollbackRoot({
      knowledgeBaseId,
      expiredBefore: "2026-08-09T05:00:00.000Z",
      eventPublicId: "event-sharing-expire-8",
      eventExpiresAt: "2027-01-01T00:00:00.000Z"
    })).resolves.toBe("root-sharing-8");
    await expect(releases.expireRollbackRoot({
      knowledgeBaseId,
      expiredBefore: "2026-08-09T05:00:00.000Z",
      eventPublicId: "event-sharing-expire-replay",
      eventExpiresAt: "2027-01-01T00:00:00.000Z"
    })).resolves.toBeNull();
    expect(await liveReleaseCounts(knowledgeBaseId)).toEqual({
      roots: 2,
      shards: 3,
      attachments: 4,
      owners: 4
    });
    await expect(releases.listDirectorySummaries({
      knowledgeBaseId,
      releaseRootPublicId: "root-sharing-9",
      limit: 10,
      cursor: null
    })).resolves.toMatchObject({
      items: [{
        directoryPublicId: "directory-sharing",
        logicalPath: "pages/Moved-9"
      }]
    });
    const finalZeroOwner = await sql<Array<{ zero_owner_since: Date | null }>>`
      SELECT zero_owner_since
      FROM focowiki.object_registrations
      WHERE object_id = 'object-changed-8'
    `;
    expect(finalZeroOwner[0]?.zero_owner_since).toBeNull();

    const sharedRows = await sql<Array<{
      registrations: number | string;
      descriptors: number | string;
      active_owners: number | string;
    }>>`
      SELECT
        (SELECT count(*) FROM focowiki.object_registrations
          WHERE object_id = 'object-shared') AS registrations,
        (SELECT count(*) FROM focowiki.release_shards
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND public_id = 'shard-shared') AS descriptors,
        (SELECT count(*) FROM focowiki.object_owners
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND object_id = 'object-shared'
            AND owner_kind = 'active_root') AS active_owners
    `;
    expect(sharedRows[0]).toEqual({
      registrations: "1",
      descriptors: "1",
      active_owners: "2"
    });
  });

  async function createKnowledgeBase(publicId: string) {
    await sql`
      INSERT INTO focowiki.knowledge_bases (
        public_id, name, revision, created_at, updated_at
      ) VALUES (${publicId}, ${publicId}, 0, now(), now())
    `;
  }

  async function createOperation(input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    idempotencyKey: string;
    requestHash: string;
    operationKind?: "maintenance" | "publication";
  }) {
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        created_at, updated_at
      ) VALUES (
        ${input.operationPublicId}, ${input.knowledgeBaseId},
        ${input.operationKind ?? "publication"},
        'publishing', now(), now()
      )
    `;
    await sql`
      INSERT INTO focowiki.operation_idempotency (
        public_id, knowledge_base_id, idempotency_key,
        request_hash, operation_public_id, expires_at, created_at
      ) VALUES (
        ${`idempotency-${input.operationPublicId}`}, ${input.knowledgeBaseId},
        ${input.idempotencyKey}, ${input.requestHash}, ${input.operationPublicId},
        '2027-01-01T00:00:00.000Z', now()
      )
    `;
  }

  async function activateSimpleRoot(input: {
    knowledgeBaseId: string;
    sequence: number;
    operationKind: "maintenance" | "publication";
    objectId: string;
    checksum: string;
    expectedActiveRootPublicId: string | null;
    expectedActiveRevision: number;
  }): Promise<void> {
    const operationPublicId = `operation-maintenance-compact-${input.sequence}`;
    const candidatePublicId = `candidate-maintenance-compact-${input.sequence}`;
    const rootPublicId = `root-maintenance-compact-${input.sequence}`;
    const searchPublicId = `search-maintenance-compact-${input.sequence}`;
    const idempotencyKey = `maintenance-compact-key-${input.sequence}`;
    await createOperation({
      knowledgeBaseId: input.knowledgeBaseId,
      operationPublicId,
      idempotencyKey,
      requestHash: input.checksum,
      operationKind: input.operationKind
    });
    await releases.createCandidate({
      publicId: candidatePublicId,
      knowledgeBaseId: input.knowledgeBaseId,
      operationPublicId,
      candidateRootPublicId: rootPublicId,
      expectedActiveRootPublicId: input.expectedActiveRootPublicId,
      expectedActiveRevision: input.expectedActiveRevision,
      changedFacts: [{
        kind: "knowledge_base",
        publicId: input.knowledgeBaseId,
        change: "updated"
      }],
      dependencies: [],
      idempotency: {
        key: idempotencyKey,
        requestHash: input.checksum
      },
      createdAt: `2026-08-0${input.sequence}T01:00:00.000Z`
    });
    await releases.addCandidateCatalogEntries({
      candidatePublicId,
      entries: [{
        logicalPath: "index.md",
        kind: "index",
        sourceFilePublicId: null,
        checksum: input.checksum,
        objectId: input.objectId,
        byteCount: 32,
        ordinal: 0
      }]
    });
    await releases.replaceCandidateSummaries({
      candidatePublicId,
      directories: [],
      knowledgeBase: {
        sourceFileCount: 0,
        directoryCount: 0,
        generatedEntryCount: 1,
        graphNodeCount: 0,
        graphEdgeCount: 0,
        generatedByteCount: 32
      }
    });
    await releases.markCandidateValidating({ candidatePublicId });
    await createSearchCandidate(input.knowledgeBaseId, searchPublicId, input.sequence);
    await releases.recordCandidateValidation({
      candidatePublicId,
      manifestChecksum: input.checksum,
      searchProjectionPublicId: searchPublicId,
      objectOwnerCount: 1,
      searchDocumentCount: 1,
      graphNodeCount: 0,
      graphEdgeCount: 0,
      linkCount: 0,
      generatedEntryCount: 1,
      navigationProfileVersion: 1,
      objectValidationPassed: true,
      searchValidationPassed: true,
      graphValidationPassed: true,
      linkValidationPassed: true,
      countValidationPassed: true,
      pathValidationPassed: true,
      validatedAt: `2026-08-0${input.sequence}T02:00:00.000Z`
    });
    await releases.markCandidateReady({
      candidatePublicId,
      manifestChecksum: input.checksum
    });
    await expect(releases.activateCandidate({
      knowledgeBaseId: input.knowledgeBaseId,
      candidatePublicId,
      expectedActiveRootPublicId: input.expectedActiveRootPublicId,
      expectedActiveRevision: input.expectedActiveRevision,
      searchProjectionPublicId: searchPublicId,
      rollbackExpiresAt: input.expectedActiveRootPublicId
        ? "2026-09-01T00:00:00.000Z"
        : null,
      eventPublicId: `event-maintenance-compact-${input.sequence}`,
      eventExpiresAt: "2028-01-01T00:00:00.000Z",
      activatedAt: `2026-08-0${input.sequence}T03:00:00.000Z`
    })).resolves.toMatchObject({ outcome: "activated" });
  }

  async function createVerifiedObject(
    objectId: string,
    checksum: string,
    byteCount: number
  ) {
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at, created_at
      ) VALUES (
        ${objectId}, ${`generated/${objectId}`}, ${checksum}, ${byteCount},
        'text/markdown', 'okf-v1', 'verified', ${`attempt-${objectId}`}, now(), now()
      )
    `;
  }

  async function createSearchCandidate(
    knowledgeBaseId: string,
    publicId: string,
    revision: number
  ) {
    await sql`
      INSERT INTO focowiki.search_projections (
        public_id, knowledge_base_id, projection_role,
        provider_index_uid, schema_checksum_sha256, settings_checksum_sha256,
        document_checksum_sha256,
        revision, document_count, state, created_at, updated_at
      ) VALUES (
        ${publicId}, ${knowledgeBaseId}, 'candidate',
        ${`index-${publicId}`}, ${"b".repeat(64)}, ${"c".repeat(64)},
        ${"d".repeat(64)}, ${revision}, 1, 'ready', now(), now()
      )
    `;
  }

  async function liveReleaseCounts(knowledgeBaseId: string) {
    const rows = await sql<Array<{
      roots: number | string;
      shards: number | string;
      attachments: number | string;
      owners: number | string;
    }>>`
      SELECT
        (SELECT count(*) FROM focowiki.release_roots
          WHERE knowledge_base_id = ${knowledgeBaseId}) AS roots,
        (SELECT count(*) FROM focowiki.release_shards
          WHERE knowledge_base_id = ${knowledgeBaseId}) AS shards,
        (SELECT count(*) FROM focowiki.release_root_shards
          WHERE knowledge_base_id = ${knowledgeBaseId}) AS attachments,
        (SELECT count(*) FROM focowiki.object_owners
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND owner_kind IN ('active_root', 'candidate_root', 'rollback_root')) AS owners
    `;
    return {
      roots: Number(rows[0]?.roots ?? 0),
      shards: Number(rows[0]?.shards ?? 0),
      attachments: Number(rows[0]?.attachments ?? 0),
      owners: Number(rows[0]?.owners ?? 0)
    };
  }
});

function databaseConnectionUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
