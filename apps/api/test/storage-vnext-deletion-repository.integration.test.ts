import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createPostgresStorageVnextCatalogRepository } from
  "../src/storage-vnext/catalog/postgres-repository.js";
import { createStorageVnextDeletionCoordinator } from
  "../src/storage-vnext/deletion/deletion-coordinator.js";
import { createPostgresStorageVnextDeletionRepository } from
  "../src/storage-vnext/deletion/postgres-repository.js";
import { createPostgresStorageVnextGraphRepository } from
  "../src/storage-vnext/graph/postgres-repository.js";
import { createPostgresStorageVnextReleaseRepository } from
  "../src/storage-vnext/release/postgres-repository.js";
import { createPostgresStorageVnextSearchHydration } from
  "../src/storage-vnext/search/postgres-hydration.js";
import { createPostgresStorageVnextAdminResourceRead } from
  "../src/storage-vnext/api/postgres-admin-resources.js";
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
describeOwnedDatabase("storage vNext deletion PostgreSQL repository", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const ownerToken = (runOwner ?? "invalid").replaceAll("-", "_");
  const databaseName = `focowiki_vnext_deletion_${ownerToken}_${randomUUID()
    .replaceAll("-", "").slice(0, 10)}`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 8 });
  const database = sql as unknown as DatabaseClient;
  const repository = createPostgresStorageVnextDeletionRepository(database);
  const coordinator = createStorageVnextDeletionCoordinator({
    repository,
    visibilityCache: {
      invalidateKnowledgeBase: async () => undefined
    }
  });
  const catalog = createPostgresStorageVnextCatalogRepository(database);
  const graph = createPostgresStorageVnextGraphRepository(database);
  const hydration = createPostgresStorageVnextSearchHydration(database);
  const releases = createPostgresStorageVnextReleaseRepository(database);
  const adminResources = createPostgresStorageVnextAdminResourceRead(database);
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
    await sql`
      INSERT INTO focowiki.runtime_setting_revisions
        (public_id, checksum_sha256, settings_values)
      VALUES ('settings-deletion-integration', ${"a".repeat(64)}, '{}'::jsonb)
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

  it("commits file invisibility atomically while retaining one unified active index", async () => {
    await seedKnowledgeBase("kb-deletion-file", 3);
    await seedSource({
      knowledgeBaseId: "kb-deletion-file",
      sourceFilePublicId: "file-deletion-file",
      logicalPath: "Guides/File.md",
      revision: 7
    });
    await seedGraph("kb-deletion-file", "file-deletion-file");
    await seedActiveRelease("kb-deletion-file", "file-deletion-file");
    const request = deletionRequest({
      knowledgeBaseId: "kb-deletion-file",
      targetPublicId: "file-deletion-file",
      expectedResourceRevision: 7
    });

    await expect(coordinator.acceptDeletion(request)).resolves.toMatchObject({
      outcome: "queued",
      visibilityCommitted: true
    });
    await expect(coordinator.acceptDeletion(request)).resolves.toMatchObject({
      outcome: "replayed"
    });
    await expect(catalog.getSourceFile({
      knowledgeBaseId: "kb-deletion-file",
      publicId: "file-deletion-file"
    })).resolves.toBeNull();
    await expect(catalog.getCurrentSourceRevision({
      knowledgeBaseId: "kb-deletion-file",
      sourceFilePublicId: "file-deletion-file"
    })).resolves.toBeNull();
    await expect(graph.getNode({
      knowledgeBaseId: "kb-deletion-file",
      publicId: "node-file-deletion-file"
    })).resolves.toBeNull();
    await expect(hydration.hydrateCurrentSources({
      knowledgeBaseId: "kb-deletion-file",
      sourceFilePublicIds: ["file-deletion-file"]
    })).resolves.toEqual([]);
    const activeRoot = await releases.getActiveRoot("kb-deletion-file");
    expect(activeRoot).not.toBeNull();
    await expect(releases.listRootCatalogEntries({
      knowledgeBaseId: "kb-deletion-file",
      releaseRootPublicId: activeRoot!.publicId,
      limit: 10,
      cursor: null
    })).resolves.toMatchObject({ items: [] });
    expect(await scopedCount("operation_work_items", "kb-deletion-file")).toBe(1);
    expect(await scopedCount("search_projections", "kb-deletion-file")).toBe(1);
    const indexes = await sql<Array<{ projection_role: string }>>`
      SELECT projection_role FROM focowiki.search_projections
      WHERE knowledge_base_id = 'kb-deletion-file'
    `;
    expect(indexes).toEqual([{ projection_role: "active" }]);
  });

  it("soft-deletes a directory subtree with one operation and leaves siblings current", async () => {
    await seedKnowledgeBase("kb-deletion-directory", 2);
    await sql`
      INSERT INTO focowiki.source_directories (
        public_id, knowledge_base_id, parent_public_id, logical_path,
        normalized_path, title, revision
      ) VALUES
        ('dir-deletion-root', 'kb-deletion-directory', NULL,
         'Guides', 'guides', 'Guides', 4),
        ('dir-deletion-child', 'kb-deletion-directory', 'dir-deletion-root',
         'Guides/Child', 'guides/child', 'Child', 1),
        ('dir-deletion-sibling', 'kb-deletion-directory', NULL,
         'Other', 'other', 'Other', 1)
    `;
    await seedSource({
      knowledgeBaseId: "kb-deletion-directory",
      sourceFilePublicId: "file-deletion-directory-root",
      logicalPath: "Guides/A.md",
      directoryPublicId: "dir-deletion-root"
    });
    await seedSource({
      knowledgeBaseId: "kb-deletion-directory",
      sourceFilePublicId: "file-deletion-directory-child",
      logicalPath: "Guides/Child/B.md",
      directoryPublicId: "dir-deletion-child"
    });
    await seedSource({
      knowledgeBaseId: "kb-deletion-directory",
      sourceFilePublicId: "file-deletion-directory-sibling",
      logicalPath: "Other/C.md",
      directoryPublicId: "dir-deletion-sibling"
    });

    await coordinator.acceptDeletion(deletionRequest({
      kind: "source_directory",
      knowledgeBaseId: "kb-deletion-directory",
      targetPublicId: "dir-deletion-root",
      expectedResourceRevision: 4
    }));

    const currentFiles = await catalog.listSourceFiles({
      knowledgeBaseId: "kb-deletion-directory",
      directoryPublicId: undefined,
      limit: 10,
      cursor: null
    });
    expect(currentFiles.items.map((item) => item.publicId)).toEqual([
      "file-deletion-directory-sibling"
    ]);
    const currentDirectories = await catalog.listDirectories({
      knowledgeBaseId: "kb-deletion-directory",
      parentPublicId: undefined,
      limit: 10,
      cursor: null
    });
    expect(currentDirectories.items.map((item) => item.publicId)).toEqual([
      "dir-deletion-sibling"
    ]);
    expect(await deletionOperationCount("kb-deletion-directory")).toBe(1);
  });

  it("directly hides a knowledge base, supersedes live work, and terminates one candidate", async () => {
    await seedKnowledgeBase("kb-deletion-scope", 9);
    await seedSource({
      knowledgeBaseId: "kb-deletion-scope",
      sourceFilePublicId: "file-deletion-scope",
      logicalPath: "Scope.md"
    });
    await seedGraph("kb-deletion-scope", "file-deletion-scope");
    await seedActiveRelease("kb-deletion-scope", "file-deletion-scope");
    await seedLiveCandidate("kb-deletion-scope");
    await seedLiveOperation({
      knowledgeBaseId: "kb-deletion-scope",
      operationPublicId: "operation-deletion-maintenance",
      workKind: "maintenance",
      targetKind: "knowledge_base",
      targetPublicId: "kb-deletion-scope"
    });
    await seedSemanticWork({
      knowledgeBaseId: "kb-deletion-scope",
      operationPublicId: "operation-deletion-maintenance",
      sourceFilePublicId: "file-deletion-scope",
      sourceRevisionPublicId: "revision-file-deletion-scope"
    });
    await seedTerminalOperation("kb-deletion-scope", "failed");
    await seedTerminalOperation("kb-deletion-scope", "completed");

    await coordinator.acceptDeletion(deletionRequest({
      kind: "knowledge_base",
      knowledgeBaseId: "kb-deletion-scope",
      targetPublicId: "kb-deletion-scope",
      expectedResourceRevision: 9
    }));

    await expect(catalog.getKnowledgeBase({
      knowledgeBaseId: "kb-deletion-scope"
    })).resolves.toBeNull();
    await expect(catalog.getSourceFile({
      knowledgeBaseId: "kb-deletion-scope",
      publicId: "file-deletion-scope"
    })).resolves.toBeNull();
    await expect(graph.getNode({
      knowledgeBaseId: "kb-deletion-scope",
      publicId: "node-file-deletion-scope"
    })).resolves.toBeNull();
    await expect(releases.getActiveRoot("kb-deletion-scope")).resolves.toBeNull();
    await expect(releases.getLiveCandidate("kb-deletion-scope")).resolves.toBeNull();
    expect(await deletionOperationCount("kb-deletion-scope")).toBe(1);
    const work = await sql<Array<{ state: string }>>`
      SELECT state FROM focowiki.operations
      WHERE public_id = 'operation-deletion-maintenance'
    `;
    expect(work).toEqual([{ state: "superseded" }]);
    const semanticStages = await sql<Array<{
      stage_kind: string;
      state: string;
      cancellation_requested_at: Date | null;
      completed_at: Date | null;
    }>>`
      SELECT stage_kind, state, cancellation_requested_at, completed_at
      FROM focowiki.semantic_stage_work_items
      WHERE knowledge_base_id = 'kb-deletion-scope'
      ORDER BY stage_kind
    `;
    expect(semanticStages).toEqual([
      expect.objectContaining({
        stage_kind: "embedding",
        state: "running",
        cancellation_requested_at: new Date("2026-08-01T06:00:00.000Z"),
        completed_at: null
      }),
      expect.objectContaining({
        stage_kind: "extraction",
        state: "running",
        cancellation_requested_at: new Date("2026-08-01T06:00:00.000Z"),
        completed_at: null
      }),
      expect.objectContaining({
        stage_kind: "reconciliation",
        state: "cancelled",
        cancellation_requested_at: new Date("2026-08-01T06:00:00.000Z"),
        completed_at: new Date("2026-08-01T06:00:00.000Z")
      })
    ]);
    const historical = await sql<Array<{ state: string }>>`
      SELECT state FROM focowiki.operations
      WHERE knowledge_base_id = 'kb-deletion-scope'
        AND operation_kind = 'history'
      ORDER BY state
    `;
    expect(historical).toEqual([{ state: "completed" }, { state: "failed" }]);
    const providerIndexes = await sql<Array<{ projection_role: string }>>`
      SELECT projection_role FROM focowiki.search_projections
      WHERE knowledge_base_id = 'kb-deletion-scope'
      ORDER BY projection_role
    `;
    expect(providerIndexes).toEqual([{ projection_role: "active" }]);
  });

  it("retains failed candidate provider ownership in the deletion checkpoint", async () => {
    await seedKnowledgeBase("kb-deletion-failed-search", 5);
    await sql`
      INSERT INTO focowiki.search_projections (
        public_id, knowledge_base_id, projection_role, provider_kind,
        provider_index_uid, schema_checksum_sha256, settings_checksum_sha256,
        revision, document_count, state, safe_error_code
      ) VALUES (
        'search-candidate-kb-deletion-failed-search',
        'kb-deletion-failed-search', 'candidate', 'opensearch',
        'unified_failed_search_candidate', ${"b".repeat(64)}, ${"c".repeat(64)},
        2, 4, 'failed', 'PUBLICATION_FAILED'
      )
    `;

    await coordinator.acceptDeletion(deletionRequest({
      kind: "knowledge_base",
      knowledgeBaseId: "kb-deletion-failed-search",
      targetPublicId: "kb-deletion-failed-search",
      expectedResourceRevision: 5
    }));

    const works = await sql<Array<{
      checkpoint: Record<string, string | number | boolean | null>;
    }>>`
      SELECT work.checkpoint
      FROM focowiki.operation_work_items work
      WHERE work.knowledge_base_id = 'kb-deletion-failed-search'
        AND work.work_kind = 'deletion'
    `;
    expect(works[0]?.checkpoint).toMatchObject({
      activeSearchProviderKind: null,
      activeSearchProviderIndexUid: null,
      candidateSearchProviderKind: "opensearch",
      candidateSearchProviderIndexUid: "unified_failed_search_candidate"
    });
    expect(await scopedCount("search_projections", "kb-deletion-failed-search"))
      .toBe(0);
  });

  it("hides only a published source task and preserves active knowledge", async () => {
    await seedKnowledgeBase("kb-deletion-task-published", 1);
    await seedSource({
      knowledgeBaseId: "kb-deletion-task-published",
      sourceFilePublicId: "file-deletion-task-published",
      logicalPath: "Published.md"
    });
    await seedSourceOperation({
      knowledgeBaseId: "kb-deletion-task-published",
      sourceFilePublicId: "file-deletion-task-published",
      state: "completed"
    });
    await seedActiveRelease(
      "kb-deletion-task-published",
      "file-deletion-task-published"
    );

    await expect(coordinator.deleteSourceTasks(taskDeletionRequest(
      "kb-deletion-task-published",
      ["file-deletion-task-published"]
    ))).resolves.toEqual([{
      sourceFilePublicId: "file-deletion-task-published",
      outcome: "hidden",
      generatedFilePublicId: "file-deletion-task-published",
      generatedFilePath: "pages/Published.md"
    }]);
    await expect(catalog.getSourceFile({
      knowledgeBaseId: "kb-deletion-task-published",
      publicId: "file-deletion-task-published"
    })).resolves.toMatchObject({ visibility: "current" });
    expect(await deletionOperationCount("kb-deletion-task-published")).toBe(0);
    const sourceTask = await sql<Array<{ state: string }>>`
      SELECT state FROM focowiki.operations
      WHERE knowledge_base_id = 'kb-deletion-task-published'
        AND operation_kind = 'source_processing'
    `;
    expect(sourceTask).toEqual([{ state: "deleted" }]);
    await expect(adminResources.listSourceFiles({
      knowledgeBaseId: "kb-deletion-task-published",
      directoryId: undefined,
      filters: {
        pathQuery: null,
        sourceFileIdPrefix: null,
        state: null,
        currentStage: null,
        generatedOutputStatus: null
      },
      limit: 10,
      cursor: null
    })).resolves.toMatchObject({ items: [] });
  });

  it("deletes an unpublished task but skips running and claimed tasks", async () => {
    await seedKnowledgeBase("kb-deletion-task-state", 1);
    await seedSource({
      knowledgeBaseId: "kb-deletion-task-state",
      sourceFilePublicId: "file-deletion-task-unpublished",
      logicalPath: "Unpublished.md"
    });
    await seedSourceOperation({
      knowledgeBaseId: "kb-deletion-task-state",
      sourceFilePublicId: "file-deletion-task-unpublished",
      state: "accepted",
      workState: "queued"
    });
    await seedSource({
      knowledgeBaseId: "kb-deletion-task-state",
      sourceFilePublicId: "file-deletion-task-running",
      logicalPath: "Running.md",
      status: "processing"
    });
    await seedSourceOperation({
      knowledgeBaseId: "kb-deletion-task-state",
      sourceFilePublicId: "file-deletion-task-running",
      state: "processing",
      workState: "running"
    });
    await seedSource({
      knowledgeBaseId: "kb-deletion-task-state",
      sourceFilePublicId: "file-deletion-task-claimed",
      logicalPath: "Claimed.md"
    });
    await seedSourceOperation({
      knowledgeBaseId: "kb-deletion-task-state",
      sourceFilePublicId: "file-deletion-task-claimed",
      state: "processing",
      workState: "running"
    });

    await expect(coordinator.deleteSourceTasks(taskDeletionRequest(
      "kb-deletion-task-state",
      [
        "file-deletion-task-unpublished",
        "file-deletion-task-running",
        "file-deletion-task-claimed"
      ]
    ))).resolves.toEqual([
      { sourceFilePublicId: "file-deletion-task-unpublished", outcome: "deleted" },
      {
        sourceFilePublicId: "file-deletion-task-running",
        outcome: "skipped",
        reason: "running"
      },
      {
        sourceFilePublicId: "file-deletion-task-claimed",
        outcome: "skipped",
        reason: "job_already_claimed"
      }
    ]);
    await expect(catalog.getSourceFile({
      knowledgeBaseId: "kb-deletion-task-state",
      publicId: "file-deletion-task-unpublished"
    })).resolves.toBeNull();
    expect(await deletionOperationCount("kb-deletion-task-state")).toBe(1);
  });

  async function seedKnowledgeBase(knowledgeBaseId: string, revision: number) {
    await sql`
      INSERT INTO focowiki.knowledge_bases
        (public_id, name, description, revision)
      VALUES (${knowledgeBaseId}, ${knowledgeBaseId}, NULL, ${revision})
    `;
  }

  async function seedSource(input: {
    knowledgeBaseId: string;
    sourceFilePublicId: string;
    logicalPath: string;
    directoryPublicId?: string | null;
    revision?: number;
    status?: "pending" | "processing" | "ready" | "failed";
  }) {
    const checksum = checksumFor(input.sourceFilePublicId);
    const objectId = `object-${input.sourceFilePublicId}`;
    const sourceRevisionPublicId = `revision-${input.sourceFilePublicId}`;
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count,
        content_type, object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        ${objectId}, ${`owned/${objectId}`}, ${checksum}, 10,
        'text/markdown; charset=utf-8', 'source-markdown-v1', 'verified',
        ${`attempt-${input.sourceFilePublicId}`}, now()
      )
    `;
    await sql`
      INSERT INTO focowiki.source_files (
        public_id, knowledge_base_id, directory_public_id, logical_path,
        normalized_path, title, metadata, status, revision
      ) VALUES (
        ${input.sourceFilePublicId}, ${input.knowledgeBaseId},
        ${input.directoryPublicId ?? null}, ${input.logicalPath},
        ${input.logicalPath.toLowerCase()},
        ${input.logicalPath.split("/").at(-1)!.replace(/\.md$/u, "")},
        '{}'::jsonb, ${input.status ?? "ready"}, ${input.revision ?? 1}
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type, revision_role,
        expires_at, created_at
      ) VALUES (
        ${sourceRevisionPublicId}, ${input.knowledgeBaseId},
        ${input.sourceFilePublicId}, ${objectId}, ${checksum}, 10,
        'text/markdown; charset=utf-8', 'current', NULL, now()
      )
    `;
    await sql`
      INSERT INTO focowiki.source_file_current_revisions (
        knowledge_base_id, source_file_public_id, source_revision_public_id, revision
      ) VALUES (
        ${input.knowledgeBaseId}, ${input.sourceFilePublicId},
        ${sourceRevisionPublicId}, 1
      )
    `;
    await sql`
      INSERT INTO focowiki.object_owners (
        public_id, knowledge_base_id, object_id, owner_kind,
        source_revision_public_id
      ) VALUES (
        ${`owner-${input.sourceFilePublicId}`}, ${input.knowledgeBaseId},
        ${objectId}, 'source_revision', ${sourceRevisionPublicId}
      )
    `;
  }

  async function seedGraph(knowledgeBaseId: string, sourceFilePublicId: string) {
    await sql`
      INSERT INTO focowiki.graph_nodes (
        public_id, knowledge_base_id, source_file_public_id,
        source_revision_public_id, logical_path, label, node_kind,
        metadata, revision
      )
      SELECT ${`node-${sourceFilePublicId}`}, ${knowledgeBaseId},
             source.public_id, current.source_revision_public_id,
             ${`pages/${sourceFilePublicId}.md`}, source.title, 'page', '{}'::jsonb, 1
      FROM focowiki.source_files source
      JOIN focowiki.source_file_current_revisions current
        ON current.knowledge_base_id = source.knowledge_base_id
       AND current.source_file_public_id = source.public_id
      WHERE source.public_id = ${sourceFilePublicId}
    `;
  }

  async function seedActiveSearch(knowledgeBaseId: string) {
    await sql`
      INSERT INTO focowiki.search_projections (
        public_id, knowledge_base_id, projection_role, provider_kind,
        provider_index_uid,
        schema_checksum_sha256, settings_checksum_sha256,
        document_checksum_sha256, revision, document_count, state
      ) VALUES (
        ${`search-active-${knowledgeBaseId}`}, ${knowledgeBaseId}, 'active', 'meilisearch',
        ${`unified_${knowledgeBaseId}_active`}, ${"b".repeat(64)}, ${"c".repeat(64)},
        ${"d".repeat(64)}, 1, 2, 'ready'
      )
    `;
  }

  async function seedActiveRelease(knowledgeBaseId: string, sourceFilePublicId: string) {
    const rootPublicId = `root-active-${knowledgeBaseId}`;
    const operationPublicId = `operation-active-${knowledgeBaseId}`;
    await seedActiveSearch(knowledgeBaseId);
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        target_kind, target_public_id, completed_at
      ) VALUES (
        ${operationPublicId}, ${knowledgeBaseId}, 'publication', 'completed',
        'knowledge_base', ${knowledgeBaseId}, now()
      )
    `;
    await sql`
      INSERT INTO focowiki.release_roots (
        public_id, knowledge_base_id, root_role,
        manifest_checksum_sha256, revision, expires_at
      ) VALUES (
        ${rootPublicId}, ${knowledgeBaseId}, 'active', ${"e".repeat(64)}, 1, NULL
      )
    `;
    await sql`
      INSERT INTO focowiki.release_catalog_entries (
        knowledge_base_id, release_root_public_id, logical_path, entry_kind,
        source_file_public_id, checksum_sha256, object_id, byte_count, ordinal
      )
      SELECT ${knowledgeBaseId}, ${rootPublicId},
             'pages/' || source.logical_path, 'source', source.public_id,
             revision.checksum_sha256, revision.object_id, revision.byte_count, 0
      FROM focowiki.source_files source
      JOIN focowiki.source_file_current_revisions current
        ON current.knowledge_base_id = source.knowledge_base_id
       AND current.source_file_public_id = source.public_id
      JOIN focowiki.source_revisions revision
        ON revision.public_id = current.source_revision_public_id
      WHERE source.public_id = ${sourceFilePublicId}
    `;
    await sql`
      INSERT INTO focowiki.active_snapshots (
        knowledge_base_id, release_root_public_id, search_projection_public_id,
        manifest_checksum_sha256, revision, activated_by_operation_public_id,
        publicly_visible_at
      ) VALUES (
        ${knowledgeBaseId}, ${rootPublicId}, ${`search-active-${knowledgeBaseId}`},
        ${"e".repeat(64)}, 1, ${operationPublicId}, now()
      )
    `;
  }

  async function seedLiveCandidate(knowledgeBaseId: string) {
    const operationPublicId = `operation-candidate-${knowledgeBaseId}`;
    const rootPublicId = `root-candidate-${knowledgeBaseId}`;
    await seedLiveOperation({
      knowledgeBaseId,
      operationPublicId,
      workKind: "mutation",
      targetKind: "knowledge_base",
      targetPublicId: knowledgeBaseId
    });
    await sql`
      INSERT INTO focowiki.release_roots (
        public_id, knowledge_base_id, root_role,
        manifest_checksum_sha256, revision, expires_at
      ) VALUES (${rootPublicId}, ${knowledgeBaseId}, 'candidate', NULL, 2, NULL)
    `;
    await sql`
      INSERT INTO focowiki.release_candidates (
        public_id, knowledge_base_id, operation_public_id,
        candidate_root_public_id, expected_active_root_public_id,
        expected_active_revision, state, changed_fact_count,
        affected_dependency_count
      ) VALUES (
        ${`candidate-${knowledgeBaseId}`}, ${knowledgeBaseId}, ${operationPublicId},
        ${rootPublicId}, ${`root-active-${knowledgeBaseId}`}, 1, 'building', 1, 1
      )
    `;
    await sql`
      INSERT INTO focowiki.search_projections (
        public_id, knowledge_base_id, projection_role, provider_kind,
        provider_index_uid,
        schema_checksum_sha256, settings_checksum_sha256,
        revision, document_count, state
      ) VALUES (
        ${`search-candidate-${knowledgeBaseId}`}, ${knowledgeBaseId}, 'candidate', 'meilisearch',
        ${`unified_${knowledgeBaseId}_candidate`}, ${"b".repeat(64)}, ${"c".repeat(64)},
        1, 0, 'preparing'
      )
    `;
  }

  async function seedLiveOperation(input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    workKind: "mutation" | "maintenance";
    targetKind: "source_file" | "source_directory" | "knowledge_base";
    targetPublicId: string;
  }) {
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        target_kind, target_public_id
      ) VALUES (
        ${input.operationPublicId}, ${input.knowledgeBaseId}, ${input.workKind},
        'processing', ${input.targetKind}, ${input.targetPublicId}
      )
    `;
    await sql`
      INSERT INTO focowiki.operation_work_items (
        operation_public_id, knowledge_base_id, work_kind, state,
        operation_revision, settings_revision_public_id, attempt_count,
        lease_owner, lease_expires_at, checkpoint
      ) VALUES (
        ${input.operationPublicId}, ${input.knowledgeBaseId}, ${input.workKind},
        'running', 1, 'settings-deletion-integration', 1,
        ${`owner-${input.operationPublicId}`}, '2099-01-01T00:00:00.000Z', '{}'::jsonb
      )
    `;
  }

  async function seedSemanticWork(input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
  }) {
    const configurationPublicId = `embedding-${input.knowledgeBaseId}`;
    const revisionPublicId = `embedding-revision-${input.knowledgeBaseId}`;
    const generationPublicId = `semantic-${input.knowledgeBaseId}`;
    await sql`
      INSERT INTO focowiki.embedding_configurations (
        public_id, display_name, lifecycle_status, revision
      ) VALUES (
        ${configurationPublicId}, 'Deletion integration embedding', 'draft', 1
      )
    `;
    await sql`
      INSERT INTO focowiki.embedding_configuration_revisions (
        public_id, configuration_public_id, revision_number,
        authentication_mode, base_url, model_name, requested_dimension,
        resolved_dimension, normalization, maximum_input_tokens, batch_size,
        timeout_ms, retry_count, minimum_interval_ms, concurrency,
        maximum_response_bytes, minimum_vector_relevance,
        vector_producing_revision_public_id, validation_status,
        validation_fingerprint_sha256, validated_at
      ) VALUES (
        ${revisionPublicId}, ${configurationPublicId}, 1, 'none',
        'http://embedding.test/v1', 'embedding-test', 3, 3, 'l2',
        8192, 16, 5000, 1, 0, 2, 1048576, 0.7, ${revisionPublicId}, 'valid',
        ${"9".repeat(64)}, '2026-08-01T00:00:00.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.semantic_generations (
        public_id, knowledge_base_id, operation_public_id, generation_role,
        state, generation_model_configuration_public_id,
        generation_model_configuration_revision, extraction_contract_version,
        graph_schema_version, prompt_contract_version,
        contract_fingerprint_sha256, revision
      ) VALUES (
        ${generationPublicId}, ${input.knowledgeBaseId},
        ${input.operationPublicId}, 'candidate', 'building', 'model-delete', 1,
        'extract-v1', 'graph-v1', 'prompt-v1', ${"8".repeat(64)}, 1
      )
    `;
    const completedOperationPublicId = `operation-completed-${input.knowledgeBaseId}`;
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state, completed_at
      ) VALUES (
        ${completedOperationPublicId}, ${input.knowledgeBaseId},
        'source_processing', 'completed', '2026-08-01T00:00:00.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.semantic_stage_work_items (
        public_id, knowledge_base_id, operation_public_id,
        semantic_generation_public_id, source_file_public_id,
        source_revision_public_id, stage_kind, partition_key,
        extraction_contract_version,
        embedding_configuration_revision_public_id, settings_snapshot,
        state, attempt_count, maximum_attempts, lease_owner,
        lease_expires_at
      ) VALUES
        (
          ${`semantic-stage-running-${input.knowledgeBaseId}`},
          ${input.knowledgeBaseId}, ${input.operationPublicId},
          ${generationPublicId}, ${input.sourceFilePublicId},
          ${input.sourceRevisionPublicId}, 'extraction', 'source',
          'extract-v1', ${revisionPublicId}, '{}'::jsonb,
          'running', 1, 3, 'semantic-worker-delete',
          '2099-01-01T00:00:00.000Z'
        ),
        (
          ${`semantic-stage-queued-${input.knowledgeBaseId}`},
          ${input.knowledgeBaseId}, ${input.operationPublicId},
          ${generationPublicId}, ${input.sourceFilePublicId},
          ${input.sourceRevisionPublicId}, 'reconciliation', 'source',
          'extract-v1', ${revisionPublicId}, '{}'::jsonb,
          'queued', 0, 3, NULL, NULL
        ),
        (
          ${`semantic-stage-completed-operation-${input.knowledgeBaseId}`},
          ${input.knowledgeBaseId}, ${completedOperationPublicId},
          ${generationPublicId}, ${input.sourceFilePublicId},
          ${input.sourceRevisionPublicId}, 'embedding', 'completed-operation',
          'extract-v1', ${revisionPublicId}, '{}'::jsonb,
          'running', 1, 3, 'semantic-worker-completed-operation',
          '2099-01-01T00:00:00.000Z'
        )
    `;
  }

  async function seedTerminalOperation(
    knowledgeBaseId: string,
    state: "failed" | "completed"
  ) {
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        target_kind, target_public_id, completed_at
      ) VALUES (
        ${`operation-history-${state}-${knowledgeBaseId}`}, ${knowledgeBaseId},
        'history', ${state}, 'knowledge_base', ${knowledgeBaseId}, now()
      )
    `;
  }

  async function seedSourceOperation(input: {
    knowledgeBaseId: string;
    sourceFilePublicId: string;
    state: "accepted" | "processing" | "completed";
    workState?: "queued" | "running";
  }) {
    const operationPublicId = `operation-source-${input.sourceFilePublicId}`;
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        target_kind, target_public_id, completed_at
      ) VALUES (
        ${operationPublicId}, ${input.knowledgeBaseId}, 'source_processing',
        ${input.state}, 'source_file', ${input.sourceFilePublicId},
        ${input.state === "completed" ? new Date() : null}
      )
    `;
    if (input.workState) {
      await sql`
        INSERT INTO focowiki.operation_work_items (
          operation_public_id, knowledge_base_id, work_kind, state,
          operation_revision, settings_revision_public_id, attempt_count,
          lease_owner, lease_expires_at, checkpoint
        ) VALUES (
          ${operationPublicId}, ${input.knowledgeBaseId}, 'source', ${input.workState},
          1, 'settings-deletion-integration', ${input.workState === "running" ? 1 : 0},
          ${input.workState === "running" ? `owner-${operationPublicId}` : null},
          ${input.workState === "running" ? "2099-01-01T00:00:00.000Z" : null},
          '{}'::jsonb
        )
      `;
    }
  }

  async function scopedCount(table: string, knowledgeBaseId: string) {
    const rows = await sql.unsafe<Array<{ count: string }>>(
      `SELECT count(*)::text AS count FROM focowiki.${table} WHERE knowledge_base_id = $1`,
      [knowledgeBaseId]
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function deletionOperationCount(knowledgeBaseId: string) {
    const rows = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM focowiki.operations
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND operation_kind = 'deletion'
    `;
    return Number(rows[0]?.count ?? 0);
  }
});

function deletionRequest(input: {
  kind?: "source_file" | "source_directory" | "knowledge_base";
  knowledgeBaseId: string;
  targetPublicId: string;
  expectedResourceRevision: number;
}) {
  return {
    kind: input.kind ?? "source_file" as const,
    knowledgeBaseId: input.knowledgeBaseId,
    operationPublicId: `operation-delete-${input.targetPublicId}`,
    targetPublicId: input.targetPublicId,
    expectedResourceRevision: input.expectedResourceRevision,
    idempotencyKey: `delete-${input.targetPublicId}`,
    settingsRevisionPublicId: "settings-deletion-integration",
    requestedAt: "2026-08-01T06:00:00.000Z",
    expiresAt: "2026-09-01T06:00:00.000Z"
  };
}

function taskDeletionRequest(knowledgeBaseId: string, sourceFilePublicIds: string[]) {
  return {
    knowledgeBaseId,
    sourceFilePublicIds,
    deletedAt: "2026-08-01T06:00:00.000Z",
    settingsRevisionPublicId: "settings-deletion-integration",
    resultExpiresAt: "2026-09-01T06:00:00.000Z"
  };
}

function checksumFor(value: string): string {
  return Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64);
}

function databaseConnectionUrl(baseUrl: string, database: string): string {
  const value = new URL(baseUrl);
  value.pathname = `/${database}`;
  return value.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
