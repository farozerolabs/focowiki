import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createPostgresStorageVnextCatalogRepository } from
  "../src/storage-vnext/catalog/postgres-repository.js";
import { createPostgresStorageVnextGraphRepository } from
  "../src/storage-vnext/graph/postgres-repository.js";
import {
  createStorageVnextMutationReleaseHandoff,
  planStorageVnextMutationCandidate
} from "../src/storage-vnext/mutation/candidate-planning.js";
import { createStorageVnextMutationCoordinator } from
  "../src/storage-vnext/mutation/mutation-coordinator.js";
import { createStorageVnextMutationTerminalCoordinator } from
  "../src/storage-vnext/mutation/mutation-terminal.js";
import { createPostgresStorageVnextMutationReleaseHooks } from
  "../src/storage-vnext/mutation/postgres-release-hooks.js";
import {
  createPostgresStorageVnextMutationCandidateCatalog,
  readPostgresStorageVnextMutationCandidateOverlay
} from "../src/storage-vnext/mutation/postgres-candidate-overlay.js";
import { createPostgresStorageVnextMutationCandidateGraph } from
  "../src/storage-vnext/mutation/postgres-candidate-graph.js";
import { createPostgresStorageVnextMutationCandidateSnapshot } from
  "../src/storage-vnext/mutation/candidate-snapshot.js";
import { createPostgresStorageVnextMutationRepository } from
  "../src/storage-vnext/mutation/postgres-repository.js";
import { createPostgresStorageVnextPublicationSnapshot } from
  "../src/storage-vnext/publication/postgres-snapshot.js";
import { createPostgresStorageVnextSearchHydration } from
  "../src/storage-vnext/search/postgres-hydration.js";
import { createPostgresStorageVnextReleaseRepository } from
  "../src/storage-vnext/release/postgres-repository.js";
import { createPostgresStorageVnextWorkflowRepository } from
  "../src/storage-vnext/workflow/postgres-repository.js";
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
describeOwnedDatabase("storage vNext mutation PostgreSQL repository", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const ownerToken = (runOwner ?? "invalid").replaceAll("-", "_");
  const databaseName = `focowiki_vnext_mutation_${ownerToken}_${randomUUID()
    .replaceAll("-", "").slice(0, 10)}`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 8 });
  const database = sql as unknown as DatabaseClient;
  const catalog = createPostgresStorageVnextCatalogRepository(database);
  const graph = createPostgresStorageVnextGraphRepository(database);
  const mutations = createPostgresStorageVnextMutationRepository(database);
  const coordinator = createStorageVnextMutationCoordinator({ repository: mutations });
  const releases = createPostgresStorageVnextReleaseRepository(database, {
    lifecycleHooks: createPostgresStorageVnextMutationReleaseHooks()
  });
  const workflow = createPostgresStorageVnextWorkflowRepository(database);
  const terminal = createStorageVnextMutationTerminalCoordinator({
    repository: mutations,
    releases,
    workflow
  });
  const handoff = createStorageVnextMutationReleaseHandoff(releases);
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
    await sql`
      INSERT INTO focowiki.runtime_setting_revisions
        (public_id, checksum_sha256, settings_values)
      VALUES ('settings-mutation-integration', ${"a".repeat(64)}, '{}'::jsonb)
    `;
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

  it("keeps a move candidate noncurrent until release and unified-search activation", async () => {
    await seedKnowledgeBase("kb-mutation-move");
    await seedSourceFile({
      knowledgeBaseId: "kb-mutation-move",
      sourceFilePublicId: "file-mutation-move",
      logicalPath: "Current.md",
      revision: 7
    });
    await seedVerifiedObject("object-mutation-move", "7".repeat(64), 9);
    await attachCurrentRevision({
      knowledgeBaseId: "kb-mutation-move",
      sourceFilePublicId: "file-mutation-move",
      sourceRevisionPublicId: "revision-mutation-move",
      objectId: "object-mutation-move",
      checksum: "7".repeat(64),
      byteCount: 9
    });
    await sql`
      INSERT INTO focowiki.graph_nodes (
        public_id, knowledge_base_id, source_file_public_id,
        source_revision_public_id, logical_path, label, node_kind,
        metadata, revision
      ) VALUES (
        'node-mutation-move', 'kb-mutation-move', 'file-mutation-move',
        'revision-mutation-move', 'pages/Current.md', 'Current', 'page',
        '{}'::jsonb, 1
      )
    `;
    await sql`
      INSERT INTO focowiki.graph_evidence_refs (
        public_id, knowledge_base_id, node_public_id, edge_public_id,
        source_file_public_id, source_revision_public_id, logical_path,
        start_offset, end_offset, checksum_sha256
      ) VALUES (
        'evidence-mutation-move', 'kb-mutation-move', 'node-mutation-move', NULL,
        'file-mutation-move', 'revision-mutation-move', 'pages/Current.md',
        0, 7, ${"7".repeat(64)}
      )
    `;
    const request = moveRequest("move", "kb-mutation-move", "Renamed.md");

    await expect(coordinator.acceptMutation(request)).resolves.toMatchObject({
      outcome: "queued"
    });
    await expect(coordinator.acceptMutation(request)).resolves.toMatchObject({
      outcome: "replayed"
    });
    await expect(currentSource("kb-mutation-move", "file-mutation-move"))
      .resolves.toMatchObject({ logical_path: "Current.md", revision: "7" });
    expect(await scopedCount(
      "mutation_path_reservations",
      "kb-mutation-move"
    )).toBe(1);

    const candidatePublicId = await prepareReadyCandidate({
      knowledgeBaseId: "kb-mutation-move",
      operationPublicId: request.operationPublicId,
      plan: planStorageVnextMutationCandidate({
        knowledgeBaseId: "kb-mutation-move",
        operationPublicId: request.operationPublicId,
        mutationKind: "rename",
        targetKind: "source_file",
        targetPublicId: "file-mutation-move",
        sourceFilePublicIds: ["file-mutation-move"],
        sourceLogicalPaths: ["Renamed.md"],
        previousSourceLogicalPaths: ["Current.md"],
        directoryLogicalPaths: [],
        graphSourceFilePublicIds: ["file-mutation-move"],
        graphEdgePublicIds: [],
        maximumChangedFacts: 20,
        maximumDependencies: 100
      })
    });

    await expect(releases.activateCandidate(activationRequest({
      knowledgeBaseId: "kb-mutation-move",
      candidatePublicId,
      operationPublicId: request.operationPublicId
    }))).resolves.toMatchObject({ outcome: "activated" });
    await expect(currentSource("kb-mutation-move", "file-mutation-move"))
      .resolves.toMatchObject({ logical_path: "Renamed.md", revision: "8" });
    const graphPaths = await sql<Array<{ logical_path: string }>>`
      SELECT logical_path FROM focowiki.graph_nodes
      WHERE knowledge_base_id = 'kb-mutation-move'
      UNION ALL
      SELECT logical_path FROM focowiki.graph_evidence_refs
      WHERE knowledge_base_id = 'kb-mutation-move'
      ORDER BY logical_path
    `;
    expect(graphPaths).toEqual([
      { logical_path: "pages/Renamed.md" },
      { logical_path: "pages/Renamed.md" }
    ]);
    expect(await scopedCount(
      "mutation_path_reservations",
      "kb-mutation-move"
    )).toBe(0);
    expect(await scopedCount("operation_work_items", "kb-mutation-move")).toBe(0);
    expect(await scopedCount("operation_results", "kb-mutation-move")).toBe(1);
    const search = await sql<Array<{
      public_id: string;
      projection_role: string;
    }>>`
      SELECT public_id, projection_role
      FROM focowiki.search_projections
      WHERE knowledge_base_id = 'kb-mutation-move'
    `;
    expect(search).toEqual([{
      public_id: candidatePublicId,
      projection_role: "active"
    }]);
  });

  it("moves one directory subtree atomically without rewriting unrelated files", async () => {
    await seedKnowledgeBase("kb-mutation-directory");
    await sql`
      INSERT INTO focowiki.source_directories (
        public_id, knowledge_base_id, parent_public_id, logical_path,
        normalized_path, title, revision
      ) VALUES
        ('dir-mutation-root', 'kb-mutation-directory', NULL,
         'Guides', 'guides', 'Guides', 3),
        ('dir-mutation-nested', 'kb-mutation-directory', 'dir-mutation-root',
         'Guides/Nested', 'guides/nested', 'Nested', 1)
    `;
    await seedDirectorySourceFile({
      publicId: "file-directory-a",
      directoryPublicId: "dir-mutation-root",
      logicalPath: "Guides/A.md"
    });
    await seedDirectorySourceFile({
      publicId: "file-directory-b",
      directoryPublicId: "dir-mutation-nested",
      logicalPath: "Guides/Nested/B.md"
    });
    await seedVerifiedObject("object-directory-a", "3".repeat(64), 10);
    await seedVerifiedObject("object-directory-b", "4".repeat(64), 11);
    await attachCurrentRevision({
      knowledgeBaseId: "kb-mutation-directory",
      sourceFilePublicId: "file-directory-a",
      sourceRevisionPublicId: "revision-directory-a",
      objectId: "object-directory-a",
      checksum: "3".repeat(64),
      byteCount: 10
    });
    await attachCurrentRevision({
      knowledgeBaseId: "kb-mutation-directory",
      sourceFilePublicId: "file-directory-b",
      sourceRevisionPublicId: "revision-directory-b",
      objectId: "object-directory-b",
      checksum: "4".repeat(64),
      byteCount: 11
    });
    await seedSourceFile({
      knowledgeBaseId: "kb-mutation-directory",
      sourceFilePublicId: "file-directory-unrelated",
      logicalPath: "Unrelated.md",
      revision: 5
    });
    const request = {
      kind: "source_directory_move" as const,
      knowledgeBaseId: "kb-mutation-directory",
      operationPublicId: "operation-mutation-directory",
      targetPublicId: "dir-mutation-root",
      expectedResourceRevision: 3,
      idempotencyKey: "mutation-directory",
      destinationParentPublicId: null,
      destinationLogicalPath: "Archive",
      settingsRevisionPublicId: "settings-mutation-integration",
      createdAt: "2026-08-01T01:00:00.000Z",
      expiresAt: "2026-08-02T01:00:00.000Z"
    };
    await coordinator.acceptMutation(request);
    const before = await directoryPaths("kb-mutation-directory");
    expect(before).toEqual([
      { kind: "directory", logical_path: "Guides" },
      { kind: "directory", logical_path: "Guides/Nested" },
      { kind: "file", logical_path: "Guides/A.md" },
      { kind: "file", logical_path: "Guides/Nested/B.md" },
      { kind: "file", logical_path: "Unrelated.md" }
    ]);
    const candidatePublicId = await prepareReadyCandidate({
      knowledgeBaseId: "kb-mutation-directory",
      operationPublicId: request.operationPublicId,
      plan: planStorageVnextMutationCandidate({
        knowledgeBaseId: "kb-mutation-directory",
        operationPublicId: request.operationPublicId,
        mutationKind: "move",
        targetKind: "source_directory",
        targetPublicId: "dir-mutation-root",
        sourceFilePublicIds: ["file-directory-a", "file-directory-b"],
        sourceLogicalPaths: ["Archive/A.md", "Archive/Nested/B.md"],
        previousSourceLogicalPaths: ["Guides/A.md", "Guides/Nested/B.md"],
        directoryLogicalPaths: ["Archive", "Archive/Nested", "Guides", "Guides/Nested"],
        graphSourceFilePublicIds: ["file-directory-a", "file-directory-b"],
        graphEdgePublicIds: [],
        maximumChangedFacts: 20,
        maximumDependencies: 100
      })
    });
    const candidateMutation = await readPostgresStorageVnextMutationCandidateOverlay(
      database,
      {
        knowledgeBaseId: "kb-mutation-directory",
        operationPublicId: request.operationPublicId,
        candidatePublicId
      }
    );
    expect(candidateMutation).not.toBeNull();
    const candidateSnapshot = createPostgresStorageVnextMutationCandidateSnapshot({
      sql: database,
      mutation: candidateMutation!,
      snapshot: createPostgresStorageVnextPublicationSnapshot(database, {
        objects: {
          async readVerified() {
            return new Uint8Array();
          }
        }
      })
    });
    await expect(candidateSnapshot.readDirectoryDescendantFileCounts({
      knowledgeBaseId: "kb-mutation-directory",
      directoryPaths: [
        "pages",
        "pages/Guides",
        "pages/Guides/Nested",
        "pages/Archive",
        "pages/Archive/Nested"
      ]
    })).resolves.toEqual(new Map([
      ["pages", 2],
      ["pages/Archive", 2],
      ["pages/Archive/Nested", 1],
      ["pages/Guides", 0],
      ["pages/Guides/Nested", 0]
    ]));
    const candidateCatalog = createPostgresStorageVnextMutationCandidateCatalog({
      sql: database,
      mutation: candidateMutation!,
      catalog
    });
    await expect(candidateCatalog.listDirectories({
      knowledgeBaseId: "kb-mutation-directory",
      parentPublicId: undefined,
      limit: 10,
      cursor: null
    })).resolves.toMatchObject({
      items: [
        expect.objectContaining({ logicalPath: "Archive" }),
        expect.objectContaining({ logicalPath: "Archive/Nested" })
      ],
      nextCursor: null
    });
    await expect(candidateCatalog.listSourceFiles({
      knowledgeBaseId: "kb-mutation-directory",
      directoryPublicId: "dir-mutation-root",
      limit: 10,
      cursor: null
    })).resolves.toMatchObject({
      items: [expect.objectContaining({ logicalPath: "Archive/A.md" })],
      nextCursor: null
    });
    await releases.activateCandidate(activationRequest({
      knowledgeBaseId: "kb-mutation-directory",
      candidatePublicId,
      operationPublicId: request.operationPublicId
    }));

    expect(await directoryPaths("kb-mutation-directory")).toEqual([
      { kind: "directory", logical_path: "Archive" },
      { kind: "directory", logical_path: "Archive/Nested" },
      { kind: "file", logical_path: "Archive/A.md" },
      { kind: "file", logical_path: "Archive/Nested/B.md" },
      { kind: "file", logical_path: "Unrelated.md" }
    ]);
    await expect(currentSource(
      "kb-mutation-directory",
      "file-directory-unrelated"
    )).resolves.toMatchObject({ logical_path: "Unrelated.md", revision: "5" });
  });

  it("activates knowledge-base metadata only after its root candidate is ready", async () => {
    await seedKnowledgeBase("kb-mutation-metadata");
    const request = {
      kind: "knowledge_base_metadata" as const,
      knowledgeBaseId: "kb-mutation-metadata",
      operationPublicId: "operation-mutation-metadata",
      targetPublicId: "kb-mutation-metadata",
      expectedResourceRevision: 1,
      idempotencyKey: "mutation-metadata",
      name: "Updated knowledge base",
      description: "Updated description",
      settingsRevisionPublicId: "settings-mutation-integration",
      createdAt: "2026-08-01T01:00:00.000Z",
      expiresAt: "2026-08-02T01:00:00.000Z"
    };
    await coordinator.acceptMutation(request);
    const before = await knowledgeBaseMetadata("kb-mutation-metadata");
    expect(before).toEqual({
      name: "kb-mutation-metadata",
      description: null,
      revision: "1"
    });
    const candidatePublicId = await prepareReadyCandidate({
      knowledgeBaseId: "kb-mutation-metadata",
      operationPublicId: request.operationPublicId,
      plan: planStorageVnextMutationCandidate({
        knowledgeBaseId: "kb-mutation-metadata",
        operationPublicId: request.operationPublicId,
        mutationKind: "metadata",
        targetKind: "knowledge_base",
        targetPublicId: "kb-mutation-metadata",
        sourceFilePublicIds: [],
        sourceLogicalPaths: [],
        previousSourceLogicalPaths: [],
        directoryLogicalPaths: [],
        graphSourceFilePublicIds: [],
        graphEdgePublicIds: [],
        maximumChangedFacts: 10,
        maximumDependencies: 20
      })
    });
    await releases.activateCandidate(activationRequest({
      knowledgeBaseId: "kb-mutation-metadata",
      candidatePublicId,
      operationPublicId: request.operationPublicId
    }));
    expect(await knowledgeBaseMetadata("kb-mutation-metadata")).toEqual({
      name: "Updated knowledge base",
      description: "Updated description",
      revision: "2"
    });
  });

  it("activates source metadata through the same changed-set release boundary", async () => {
    await seedKnowledgeBase("kb-mutation-source-metadata");
    await seedSourceFile({
      knowledgeBaseId: "kb-mutation-source-metadata",
      sourceFilePublicId: "file-mutation-source-metadata",
      logicalPath: "Metadata.md",
      revision: 4
    });
    const request = {
      kind: "source_file_metadata" as const,
      knowledgeBaseId: "kb-mutation-source-metadata",
      operationPublicId: "operation-mutation-source-metadata",
      targetPublicId: "file-mutation-source-metadata",
      expectedResourceRevision: 4,
      idempotencyKey: "mutation-source-metadata",
      title: "Updated title",
      metadata: { language: "en", priority: 2 },
      settingsRevisionPublicId: "settings-mutation-integration",
      createdAt: "2026-08-01T01:00:00.000Z",
      expiresAt: "2026-08-02T01:00:00.000Z"
    };
    await coordinator.acceptMutation(request);
    expect(await sourceMetadata(
      "kb-mutation-source-metadata",
      "file-mutation-source-metadata"
    )).toEqual({ title: "Metadata", metadata: {}, revision: "4" });
    const candidatePublicId = await prepareReadyCandidate({
      knowledgeBaseId: "kb-mutation-source-metadata",
      operationPublicId: request.operationPublicId,
      plan: planStorageVnextMutationCandidate({
        knowledgeBaseId: "kb-mutation-source-metadata",
        operationPublicId: request.operationPublicId,
        mutationKind: "metadata",
        targetKind: "source_file",
        targetPublicId: "file-mutation-source-metadata",
        sourceFilePublicIds: ["file-mutation-source-metadata"],
        sourceLogicalPaths: ["Metadata.md"],
        previousSourceLogicalPaths: ["Metadata.md"],
        directoryLogicalPaths: [],
        graphSourceFilePublicIds: ["file-mutation-source-metadata"],
        graphEdgePublicIds: [],
        maximumChangedFacts: 20,
        maximumDependencies: 100
      })
    });
    await releases.activateCandidate(activationRequest({
      knowledgeBaseId: "kb-mutation-source-metadata",
      candidatePublicId,
      operationPublicId: request.operationPublicId
    }));
    expect(await sourceMetadata(
      "kb-mutation-source-metadata",
      "file-mutation-source-metadata"
    )).toEqual({
      title: "Updated title",
      metadata: { language: "en", priority: 2 },
      revision: "5"
    });
  });

  it("rejects stale, unchanged, competing, and live-upload move acceptance", async () => {
    await seedKnowledgeBase("kb-mutation-conflict");
    await seedSourceFile({
      knowledgeBaseId: "kb-mutation-conflict",
      sourceFilePublicId: "file-mutation-conflict",
      logicalPath: "Current.md",
      revision: 7
    });
    await seedSourceFile({
      knowledgeBaseId: "kb-mutation-conflict",
      sourceFilePublicId: "file-mutation-occupied",
      logicalPath: "Occupied.md",
      revision: 1
    });

    await expect(coordinator.acceptMutation({
      ...moveRequest("stale", "kb-mutation-conflict", "Stale.md"),
      expectedResourceRevision: 6
    })).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(coordinator.acceptMutation(
      moveRequest("unchanged", "kb-mutation-conflict", "Current.md")
    )).rejects.toMatchObject({ code: "destination_unchanged" });
    await expect(coordinator.acceptMutation(
      moveRequest("occupied", "kb-mutation-conflict", "Occupied.md")
    )).rejects.toMatchObject({ code: "path_conflict" });

    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        target_kind, target_public_id
      ) VALUES (
        'operation-live-upload', 'kb-mutation-conflict', 'upload', 'processing',
        'knowledge_base', 'kb-mutation-conflict'
      )
    `;
    await sql`
      INSERT INTO focowiki.operation_work_items (
        operation_public_id, knowledge_base_id, work_kind, state,
        operation_revision, settings_revision_public_id, attempt_count,
        lease_owner, lease_expires_at, checkpoint
      ) VALUES (
        'operation-live-upload', 'kb-mutation-conflict', 'upload', 'running',
        1, 'settings-mutation-integration', 1,
        'upload-test', '2026-08-03T00:00:00.000Z', '{}'::jsonb
      )
    `;
    await expect(coordinator.acceptMutation(
      moveRequest("upload", "kb-mutation-conflict", "Upload.md")
    )).rejects.toMatchObject({ code: "upload_conflict" });
    expect(await scopedCount("mutation_path_reservations", "kb-mutation-conflict"))
      .toBe(0);
  });

  it("accepts a missing move parent for durable worker-side failure", async () => {
    await seedKnowledgeBase("kb-mutation-missing-parent");
    await seedSourceFile({
      knowledgeBaseId: "kb-mutation-missing-parent",
      sourceFilePublicId: "file-mutation-missing-parent",
      logicalPath: "Current.md",
      revision: 7
    });
    const request = {
      ...moveRequest(
        "missing-parent",
        "kb-mutation-missing-parent",
        "missing/Current.md"
      ),
      targetPublicId: "file-mutation-missing-parent"
    };

    await expect(coordinator.acceptMutation(request)).resolves.toMatchObject({
      outcome: "queued",
      operationPublicId: request.operationPublicId
    });
    const rows = await sql<Array<{ checkpoint: Record<string, unknown> }>>`
      SELECT checkpoint
      FROM focowiki.operation_work_items
      WHERE operation_public_id = ${request.operationPublicId}
    `;
    expect(rows[0]?.checkpoint).toMatchObject({
      candidateLogicalPath: "missing/Current.md",
      candidateDirectoryPublicId: null,
      terminalFailureCode: "RESOURCE_PATH_CONFLICT"
    });
    await terminal.failMutation({
      knowledgeBaseId: request.knowledgeBaseId,
      operationPublicId: request.operationPublicId,
      resultCode: "RESOURCE_PATH_CONFLICT",
      completedAt: "2026-08-01T03:00:00.000Z",
      resultExpiresAt: "2026-09-01T03:00:00.000Z"
    });
  });

  it("activates one immutable replacement and releases the superseded source owner", async () => {
    await seedKnowledgeBase("kb-mutation-replace");
    await seedVerifiedObject("object-replace-current", "b".repeat(64), 12);
    await seedVerifiedObject("object-replace-next", "c".repeat(64), 14);
    await seedSourceFile({
      knowledgeBaseId: "kb-mutation-replace",
      sourceFilePublicId: "file-mutation-replace",
      logicalPath: "Replace.md",
      revision: 7,
      sourceRevision: {
        publicId: "revision-replace-current",
        objectId: "object-replace-current",
        checksum: "b".repeat(64),
        byteCount: 12
      }
    });
    await sql`
      INSERT INTO focowiki.graph_nodes (
        public_id, knowledge_base_id, source_file_public_id,
        source_revision_public_id, logical_path, label, node_kind,
        metadata, revision
      ) VALUES (
        'node-mutation-replace', 'kb-mutation-replace',
        'file-mutation-replace', 'revision-replace-current',
        'pages/Replace.md', 'Replace', 'page', '{}'::jsonb, 7
      )
    `;
    await sql`
      INSERT INTO focowiki.graph_evidence_refs (
        public_id, knowledge_base_id, node_public_id, edge_public_id,
        source_file_public_id, source_revision_public_id, logical_path,
        start_offset, end_offset, checksum_sha256
      ) VALUES (
        'evidence-mutation-replace-current', 'kb-mutation-replace',
        'node-mutation-replace', NULL, 'file-mutation-replace',
        'revision-replace-current', 'pages/Replace.md', 0, 12,
        ${"b".repeat(64)}
      )
    `;
    const request = replaceRequest("replace", "kb-mutation-replace");

    await expect(coordinator.acceptMutation(request)).resolves.toMatchObject({
      outcome: "queued"
    });
    expect(await currentRevision("kb-mutation-replace", "file-mutation-replace"))
      .toBe("revision-replace-current");
    expect(await revisionRoles("kb-mutation-replace")).toEqual([
      { public_id: "revision-replace-current", revision_role: "current" },
      { public_id: "revision-replace-next", revision_role: "candidate" }
    ]);

    const candidatePublicId = await prepareReadyCandidate({
      knowledgeBaseId: "kb-mutation-replace",
      operationPublicId: request.operationPublicId,
      plan: planStorageVnextMutationCandidate({
        knowledgeBaseId: "kb-mutation-replace",
        operationPublicId: request.operationPublicId,
        mutationKind: "replacement",
        targetKind: "source_file",
        targetPublicId: "file-mutation-replace",
        candidateRevisionPublicId: "revision-replace-next",
        sourceFilePublicIds: ["file-mutation-replace"],
        sourceLogicalPaths: ["Replace.md"],
        previousSourceLogicalPaths: ["Replace.md"],
        directoryLogicalPaths: [],
        graphSourceFilePublicIds: ["file-mutation-replace"],
        graphEdgePublicIds: [],
        maximumChangedFacts: 20,
        maximumDependencies: 100
      })
    });
    const mutation = await readPostgresStorageVnextMutationCandidateOverlay(
      database,
      {
        knowledgeBaseId: "kb-mutation-replace",
        operationPublicId: request.operationPublicId,
        candidatePublicId
      }
    );
    expect(mutation).not.toBeNull();
    const candidateCatalog = createPostgresStorageVnextMutationCandidateCatalog({
      sql: database,
      mutation: mutation!,
      catalog
    });
    const candidateGraph = createPostgresStorageVnextMutationCandidateGraph({
      sql: database,
      candidatePublicId,
      mutation: mutation!,
      catalog: candidateCatalog,
      graph
    });
    await expect(candidateCatalog.getCurrentSourceRevision({
      knowledgeBaseId: "kb-mutation-replace",
      sourceFilePublicId: "file-mutation-replace"
    })).resolves.toMatchObject({ publicId: "revision-replace-next" });
    const candidateHydration = createPostgresStorageVnextSearchHydration(database);
    await expect(candidateHydration.hydrateCurrentSources({
      knowledgeBaseId: "kb-mutation-replace",
      candidatePublicId,
      sourceFilePublicIds: ["file-mutation-replace"]
    })).resolves.toEqual([{
      sourceFilePublicId: "file-mutation-replace",
      sourceRevisionPublicId: "revision-replace-next",
      logicalPath: "pages/Replace.md",
      title: "Replace"
    }]);
    await candidateGraph.replaceSourceFileGraph({
      knowledgeBaseId: "kb-mutation-replace",
      sourceFilePublicId: "file-mutation-replace",
      sourceRevisionPublicId: "revision-replace-next",
      node: {
        publicId: "node-mutation-replace",
        knowledgeBaseId: "kb-mutation-replace",
        sourceFilePublicId: "file-mutation-replace",
        sourceRevisionPublicId: "revision-replace-next",
        logicalPath: "pages/Replace.md",
        label: "Replace",
        kind: "page",
        metadata: {},
        evidence: [{
          publicId: "evidence-mutation-replace-next",
          sourceFilePublicId: "file-mutation-replace",
          sourceRevisionPublicId: "revision-replace-next",
          logicalPath: "pages/Replace.md",
          startOffset: 0,
          endOffset: 14,
          checksum: "c".repeat(64)
        }],
        revision: 8
      },
      edges: []
    });
    await expect(graph.getNode({
      knowledgeBaseId: "kb-mutation-replace",
      publicId: "node-mutation-replace"
    })).resolves.toMatchObject({
      sourceRevisionPublicId: "revision-replace-current"
    });
    await expect(candidateGraph.getNode({
      knowledgeBaseId: "kb-mutation-replace",
      publicId: "node-mutation-replace"
    })).resolves.toMatchObject({
      sourceRevisionPublicId: "revision-replace-next",
      evidence: [expect.objectContaining({ checksum: "c".repeat(64) })]
    });
    await releases.activateCandidate(activationRequest({
      knowledgeBaseId: "kb-mutation-replace",
      candidatePublicId,
      operationPublicId: request.operationPublicId
    }));

    expect(await currentRevision("kb-mutation-replace", "file-mutation-replace"))
      .toBe("revision-replace-next");
    expect(await revisionRoles("kb-mutation-replace")).toEqual([
      { public_id: "revision-replace-next", revision_role: "current" }
    ]);
    const activatedGraph = await sql<Array<{
      source_revision_public_id: string;
      checksum_sha256: string;
      end_offset: string;
    }>>`
      SELECT node.source_revision_public_id, evidence.checksum_sha256,
             evidence.end_offset::text
      FROM focowiki.graph_nodes node
      JOIN focowiki.graph_evidence_refs evidence
        ON evidence.knowledge_base_id = node.knowledge_base_id
       AND evidence.node_public_id = node.public_id
      WHERE node.knowledge_base_id = 'kb-mutation-replace'
        AND node.public_id = 'node-mutation-replace'
    `;
    expect(activatedGraph).toEqual([{
      source_revision_public_id: "revision-replace-next",
      checksum_sha256: "c".repeat(64),
      end_offset: "14"
    }]);
    expect(await scopedCount(
      "release_candidate_graph_nodes",
      "kb-mutation-replace"
    )).toBe(0);
    const owners = await sql<Array<{
      object_id: string;
      source_revision_public_id: string;
    }>>`
      SELECT object_id, source_revision_public_id
      FROM focowiki.object_owners
      WHERE knowledge_base_id = 'kb-mutation-replace'
        AND owner_kind = 'source_revision'
      ORDER BY object_id
    `;
    expect(owners).toEqual([{
      object_id: "object-replace-next",
      source_revision_public_id: "revision-replace-next"
    }]);
    const replacementObjects = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count
      FROM focowiki.object_registrations
      WHERE object_id IN ('object-replace-current', 'object-replace-next')
    `;
    expect(Number(replacementObjects[0]?.count ?? 0)).toBe(2);
    const oldObject = await sql<Array<{ zero_owner_since: Date | null }>>`
      SELECT zero_owner_since FROM focowiki.object_registrations
      WHERE object_id = 'object-replace-current'
    `;
    expect(oldObject[0]?.zero_owner_since).toBeInstanceOf(Date);
    await expect(coordinator.acceptMutation({
      ...replaceRequest("unchanged-replace", "kb-mutation-replace"),
      expectedResourceRevision: 8,
      candidateRevisionPublicId: "revision-replace-unchanged"
    })).rejects.toMatchObject({ code: "content_unchanged" });
  });

  it("cancels candidate and pre-candidate mutations without stale owners or work", async () => {
    await seedKnowledgeBase("kb-mutation-cancel-direct");
    await seedVerifiedObject("object-cancel-current", "4".repeat(64), 10);
    await seedVerifiedObject("object-cancel-next", "5".repeat(64), 11);
    await seedSourceFile({
      knowledgeBaseId: "kb-mutation-cancel-direct",
      sourceFilePublicId: "file-mutation-cancel-direct",
      logicalPath: "Cancel.md",
      revision: 3,
      sourceRevision: {
        publicId: "revision-cancel-current",
        objectId: "object-cancel-current",
        checksum: "4".repeat(64),
        byteCount: 10
      }
    });
    const directRequest = {
      ...replaceRequest("cancel-direct", "kb-mutation-cancel-direct"),
      targetPublicId: "file-mutation-cancel-direct",
      expectedResourceRevision: 3,
      candidateRevisionPublicId: "revision-cancel-next",
      objectId: "object-cancel-next",
      checksumSha256: "5".repeat(64),
      byteCount: 11
    };
    await coordinator.acceptMutation(directRequest);
    await terminal.cancelMutation({
      knowledgeBaseId: "kb-mutation-cancel-direct",
      operationPublicId: directRequest.operationPublicId,
      completedAt: "2026-08-01T03:00:00.000Z",
      resultExpiresAt: "2026-09-01T03:00:00.000Z"
    });
    expect(await currentRevision(
      "kb-mutation-cancel-direct",
      "file-mutation-cancel-direct"
    )).toBe("revision-cancel-current");
    expect(await revisionRoles("kb-mutation-cancel-direct")).toEqual([{
      public_id: "revision-cancel-current",
      revision_role: "current"
    }]);
    expect(await scopedCount("operation_work_items", "kb-mutation-cancel-direct"))
      .toBe(0);
    const cancelledObject = await sql<Array<{ zero_owner_since: Date | null }>>`
      SELECT zero_owner_since FROM focowiki.object_registrations
      WHERE object_id = 'object-cancel-next'
    `;
    expect(cancelledObject[0]?.zero_owner_since).toBeInstanceOf(Date);

    await seedKnowledgeBase("kb-mutation-cancel-candidate");
    await seedSourceFile({
      knowledgeBaseId: "kb-mutation-cancel-candidate",
      sourceFilePublicId: "file-mutation-cancel-candidate",
      logicalPath: "Current.md",
      revision: 2
    });
    const candidateRequest = {
      ...moveRequest(
        "cancel-candidate",
        "kb-mutation-cancel-candidate",
        "Candidate.md"
      ),
      targetPublicId: "file-mutation-cancel-candidate",
      expectedResourceRevision: 2
    };
    await coordinator.acceptMutation(candidateRequest);
    const plan = planStorageVnextMutationCandidate({
      knowledgeBaseId: "kb-mutation-cancel-candidate",
      operationPublicId: candidateRequest.operationPublicId,
      mutationKind: "rename",
      targetKind: "source_file",
      targetPublicId: candidateRequest.targetPublicId,
      sourceFilePublicIds: [candidateRequest.targetPublicId],
      sourceLogicalPaths: ["Candidate.md"],
      previousSourceLogicalPaths: ["Current.md"],
      directoryLogicalPaths: [],
      graphSourceFilePublicIds: [candidateRequest.targetPublicId],
      graphEdgePublicIds: [],
      maximumChangedFacts: 20,
      maximumDependencies: 100
    });
    const idempotency = await mutationIdempotency(candidateRequest.operationPublicId);
    const release = await handoff.apply({
      ...plan,
      idempotency,
      createdAt: "2026-08-01T02:00:00.000Z"
    });
    await terminal.cancelMutation({
      knowledgeBaseId: "kb-mutation-cancel-candidate",
      operationPublicId: candidateRequest.operationPublicId,
      completedAt: "2026-08-01T03:00:00.000Z",
      resultExpiresAt: "2026-09-01T03:00:00.000Z"
    });
    await expect(releases.getLiveCandidate("kb-mutation-cancel-candidate"))
      .resolves.toBeNull();
    await expect(currentSource(
      "kb-mutation-cancel-candidate",
      "file-mutation-cancel-candidate"
    )).resolves.toMatchObject({ logical_path: "Current.md", revision: "2" });
    const releaseEvents = await releases.listReleaseEvents({
      knowledgeBaseId: "kb-mutation-cancel-candidate",
      limit: 10,
      cursor: null
    });
    expect(releaseEvents.items).toEqual([
      expect.objectContaining({
        candidatePublicId: release.candidatePublicId,
        outcome: "cancelled",
        resultCode: "MUTATION_CANCELLED"
      })
    ]);
  });

  async function prepareReadyCandidate(input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    plan: ReturnType<typeof planStorageVnextMutationCandidate>;
  }): Promise<string> {
    const idempotency = await mutationIdempotency(input.operationPublicId);
    const result = await handoff.apply({
      ...input.plan,
      idempotency,
      createdAt: "2026-08-01T02:00:00.000Z"
    });
    const candidate = await releases.getLiveCandidate(input.knowledgeBaseId);
    expect(candidate?.publicId).toBe(result.candidatePublicId);
    await releases.replaceCandidateSummaries({
      candidatePublicId: result.candidatePublicId,
      directories: [],
      knowledgeBase: {
        sourceFileCount: input.plan.affectedSourceFilePublicIds.length,
        directoryCount: 0,
        generatedEntryCount: 0,
        graphNodeCount: 0,
        graphEdgeCount: 0,
        generatedByteCount: 0
      }
    });
    await sql`
      INSERT INTO focowiki.search_projections (
        public_id, knowledge_base_id, projection_role, provider_kind,
        provider_index_uid,
        schema_checksum_sha256, settings_checksum_sha256,
        document_checksum_sha256, revision, document_count,
        next_batch_ordinal, state, created_at, updated_at
      ) VALUES (
        ${result.candidatePublicId}, ${input.knowledgeBaseId}, 'candidate',
        'meilisearch',
        ${`svnext_mutation_${result.candidatePublicId}`}, ${"d".repeat(64)},
        ${"e".repeat(64)}, ${"f".repeat(64)}, 1, 0, 0, 'ready',
        '2026-08-01T02:00:00.000Z', '2026-08-01T02:00:00.000Z'
      )
    `;
    expect(await releases.markCandidateValidating({
      candidatePublicId: result.candidatePublicId
    })).toBe(true);
    const linkCount = input.plan.dependencies.filter((item) => item.kind === "link").length;
    expect(await releases.recordCandidateValidation({
      candidatePublicId: result.candidatePublicId,
      manifestChecksum: "1".repeat(64),
      searchProjectionPublicId: result.candidatePublicId,
      objectOwnerCount: 0,
      searchDocumentCount: 0,
      graphNodeCount: 0,
      graphEdgeCount: 0,
      linkCount,
      generatedEntryCount: 0,
      navigationProfileVersion: 1,
      objectValidationPassed: true,
      searchValidationPassed: true,
      graphValidationPassed: true,
      linkValidationPassed: true,
      countValidationPassed: true,
      pathValidationPassed: true,
      validatedAt: "2026-08-01T02:01:00.000Z"
    })).toBe(true);
    expect(await releases.markCandidateReady({
      candidatePublicId: result.candidatePublicId,
      manifestChecksum: "1".repeat(64)
    })).toBe(true);
    return result.candidatePublicId;
  }

  async function seedKnowledgeBase(knowledgeBaseId: string) {
    await sql`
      INSERT INTO focowiki.knowledge_bases
        (public_id, name, description, revision)
      VALUES (${knowledgeBaseId}, ${knowledgeBaseId}, NULL, 1)
    `;
  }

  async function mutationIdempotency(operationPublicId: string) {
    const rows = await sql<Array<{
      idempotency_key: string;
      request_hash: string;
    }>>`
      SELECT idempotency_key, request_hash
      FROM focowiki.operation_idempotency
      WHERE operation_public_id = ${operationPublicId}
    `;
    return {
      key: rows[0]!.idempotency_key,
      requestHash: rows[0]!.request_hash
    };
  }

  async function seedSourceFile(input: {
    knowledgeBaseId: string;
    sourceFilePublicId: string;
    logicalPath: string;
    revision: number;
    sourceRevision?: {
      publicId: string;
      objectId: string;
      checksum: string;
      byteCount: number;
    };
  }) {
    await sql`
      INSERT INTO focowiki.source_files (
        public_id, knowledge_base_id, directory_public_id, logical_path,
        normalized_path, title, metadata, status, revision
      ) VALUES (
        ${input.sourceFilePublicId}, ${input.knowledgeBaseId}, NULL,
        ${input.logicalPath}, ${input.logicalPath.toLowerCase()},
        ${input.logicalPath.replace(/\.md$/u, "")}, '{}'::jsonb, 'ready',
        ${input.revision}
      )
    `;
    if (!input.sourceRevision) return;
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type, revision_role,
        expires_at, created_at
      ) VALUES (
        ${input.sourceRevision.publicId}, ${input.knowledgeBaseId},
        ${input.sourceFilePublicId}, ${input.sourceRevision.objectId},
        ${input.sourceRevision.checksum}, ${input.sourceRevision.byteCount},
        'text/markdown; charset=utf-8', 'current', NULL,
        '2026-08-01T00:00:00.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.source_file_current_revisions (
        knowledge_base_id, source_file_public_id,
        source_revision_public_id, revision
      ) VALUES (
        ${input.knowledgeBaseId}, ${input.sourceFilePublicId},
        ${input.sourceRevision.publicId}, 1
      )
    `;
    await sql`
      INSERT INTO focowiki.object_owners (
        public_id, knowledge_base_id, object_id, owner_kind,
        source_revision_public_id
      ) VALUES (
        ${`owner-${input.sourceRevision.publicId}`}, ${input.knowledgeBaseId},
        ${input.sourceRevision.objectId}, 'source_revision',
        ${input.sourceRevision.publicId}
      )
    `;
  }

  async function seedDirectorySourceFile(input: {
    publicId: string;
    directoryPublicId: string;
    logicalPath: string;
  }) {
    await sql`
      INSERT INTO focowiki.source_files (
        public_id, knowledge_base_id, directory_public_id, logical_path,
        normalized_path, title, metadata, status, revision
      ) VALUES (
        ${input.publicId}, 'kb-mutation-directory', ${input.directoryPublicId},
        ${input.logicalPath}, ${input.logicalPath.toLowerCase()},
        ${input.logicalPath.split("/").at(-1)!.replace(/\.md$/u, "")},
        '{}'::jsonb, 'ready', 1
      )
    `;
  }

  async function seedVerifiedObject(
    objectId: string,
    checksum: string,
    byteCount: number
  ) {
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        ${objectId}, ${`run-owned/${objectId}`}, ${checksum}, ${byteCount},
        'text/markdown; charset=utf-8', 'source-markdown-v1', 'verified',
        ${`write-${objectId}`}, '2026-08-01T00:00:00.000Z'
      )
    `;
  }

  async function attachCurrentRevision(input: {
    knowledgeBaseId: string;
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
    objectId: string;
    checksum: string;
    byteCount: number;
  }) {
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type, revision_role,
        expires_at, created_at
      ) VALUES (
        ${input.sourceRevisionPublicId}, ${input.knowledgeBaseId},
        ${input.sourceFilePublicId}, ${input.objectId}, ${input.checksum},
        ${input.byteCount}, 'text/markdown; charset=utf-8', 'current', NULL,
        '2026-08-01T00:00:00.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.source_file_current_revisions (
        knowledge_base_id, source_file_public_id,
        source_revision_public_id, revision
      ) VALUES (
        ${input.knowledgeBaseId}, ${input.sourceFilePublicId},
        ${input.sourceRevisionPublicId}, 1
      )
    `;
    await sql`
      INSERT INTO focowiki.object_owners (
        public_id, knowledge_base_id, object_id, owner_kind,
        source_revision_public_id
      ) VALUES (
        ${`owner-${input.sourceRevisionPublicId}`}, ${input.knowledgeBaseId},
        ${input.objectId}, 'source_revision', ${input.sourceRevisionPublicId}
      )
    `;
  }

  async function currentSource(knowledgeBaseId: string, sourceFilePublicId: string) {
    const rows = await sql<Array<{ logical_path: string; revision: string }>>`
      SELECT logical_path, revision::text AS revision
      FROM focowiki.source_files
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND public_id = ${sourceFilePublicId}
    `;
    return rows[0];
  }

  async function currentRevision(knowledgeBaseId: string, sourceFilePublicId: string) {
    const rows = await sql<Array<{ source_revision_public_id: string }>>`
      SELECT source_revision_public_id
      FROM focowiki.source_file_current_revisions
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND source_file_public_id = ${sourceFilePublicId}
    `;
    return rows[0]?.source_revision_public_id;
  }

  async function revisionRoles(knowledgeBaseId: string) {
    return sql<Array<{ public_id: string; revision_role: string }>>`
      SELECT public_id, revision_role
      FROM focowiki.source_revisions
      WHERE knowledge_base_id = ${knowledgeBaseId}
      ORDER BY public_id
    `;
  }

  async function directoryPaths(knowledgeBaseId: string) {
    return sql<Array<{ kind: string; logical_path: string }>>`
      SELECT 'directory' AS kind, logical_path
      FROM focowiki.source_directories
      WHERE knowledge_base_id = ${knowledgeBaseId}
      UNION ALL
      SELECT 'file' AS kind, logical_path
      FROM focowiki.source_files
      WHERE knowledge_base_id = ${knowledgeBaseId}
      ORDER BY kind, logical_path
    `;
  }

  async function knowledgeBaseMetadata(knowledgeBaseId: string) {
    const rows = await sql<Array<{
      name: string;
      description: string | null;
      revision: string;
    }>>`
      SELECT name, description, revision::text AS revision
      FROM focowiki.knowledge_bases
      WHERE public_id = ${knowledgeBaseId}
    `;
    return rows[0];
  }

  async function sourceMetadata(
    knowledgeBaseId: string,
    sourceFilePublicId: string
  ) {
    const rows = await sql<Array<{
      title: string;
      metadata: Record<string, boolean | number | string | null>;
      revision: string;
    }>>`
      SELECT title, metadata, revision::text AS revision
      FROM focowiki.source_files
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND public_id = ${sourceFilePublicId}
    `;
    return rows[0];
  }

  async function scopedCount(
    table: string,
    knowledgeBaseId: string
  ): Promise<number> {
    const rows = await sql.unsafe<Array<{ count: string }>>(
      `SELECT count(*)::text AS count FROM focowiki.${quoteIdentifier(table)} WHERE knowledge_base_id = $1`,
      [knowledgeBaseId]
    );
    return Number(rows[0]?.count ?? 0);
  }
});

function moveRequest(suffix: string, knowledgeBaseId: string, destinationLogicalPath: string) {
  return {
    kind: "source_file_move" as const,
    knowledgeBaseId,
    operationPublicId: `operation-mutation-${suffix}`,
    targetPublicId: "file-mutation-conflict" === `file-mutation-${suffix}`
      ? "file-mutation-conflict"
      : suffix === "move"
        ? "file-mutation-move"
        : "file-mutation-conflict",
    expectedResourceRevision: 7,
    idempotencyKey: `mutation-${suffix}`,
    destinationDirectoryPublicId: null,
    destinationLogicalPath,
    settingsRevisionPublicId: "settings-mutation-integration",
    createdAt: "2026-08-01T01:00:00.000Z",
    expiresAt: "2026-08-02T01:00:00.000Z"
  };
}

function replaceRequest(suffix: string, knowledgeBaseId: string) {
  return {
    kind: "source_replace" as const,
    knowledgeBaseId,
    operationPublicId: `operation-mutation-${suffix}`,
    targetPublicId: "file-mutation-replace",
    expectedResourceRevision: 7,
    idempotencyKey: `mutation-${suffix}`,
    candidateRevisionPublicId: "revision-replace-next",
    objectId: "object-replace-next",
    checksumSha256: "c".repeat(64),
    byteCount: 14,
    contentType: "text/markdown; charset=utf-8" as const,
    settingsRevisionPublicId: "settings-mutation-integration",
    createdAt: "2026-08-01T01:00:00.000Z",
    expiresAt: "2026-08-02T01:00:00.000Z"
  };
}

function activationRequest(input: {
  knowledgeBaseId: string;
  candidatePublicId: string;
  operationPublicId: string;
}) {
  return {
    knowledgeBaseId: input.knowledgeBaseId,
    candidatePublicId: input.candidatePublicId,
    expectedActiveRootPublicId: null,
    expectedActiveRevision: 0,
    searchProjectionPublicId: input.candidatePublicId,
    rollbackExpiresAt: null,
    eventPublicId: `event-${input.operationPublicId}`,
    eventExpiresAt: "2026-09-01T02:00:00.000Z",
    activatedAt: "2026-08-01T02:02:00.000Z"
  };
}

function databaseConnectionUrl(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
