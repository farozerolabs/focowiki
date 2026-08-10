import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createStorageVnextDeletionWorker } from
  "../src/storage-vnext/deletion/deletion-worker.js";
import { createPostgresStorageVnextDeletionReleaseScope } from
  "../src/storage-vnext/deletion/postgres-release-scope.js";
import {
  createStorageVnextDeletionReleaseHandoff,
  planStorageVnextDeletionCandidate
} from "../src/storage-vnext/deletion/deletion-release.js";
import { createPostgresStorageVnextReleaseRepository } from
  "../src/storage-vnext/release/postgres-repository.js";
import { createPostgresStorageVnextWorkflowRepository } from
  "../src/storage-vnext/workflow/postgres-repository.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

type Scope = {
  knowledgeBaseId: string;
  operationPublicId: string;
  targetKind: "source_file" | "source_directory" | "knowledge_base";
  targetPublicId: string;
  normalizedPath: string | null;
  cursor: string | null;
};

type PurgeRepository = {
  readScopePage(input: Scope & { limit: number }): Promise<{
    sourceFilePublicIds: readonly string[];
    objectIds: readonly string[];
    nextCursor: string | null;
  }>;
  purgeSourceGraph(input: Scope & { sourceFilePublicIds: readonly string[] }): Promise<void>;
  purgeKnowledgeBaseGraph(input: Scope): Promise<void>;
  purgeSourceRelease(input: Scope & { sourceFilePublicIds: readonly string[] }): Promise<void>;
  purgeKnowledgeBaseRelease(input: Scope): Promise<void>;
  releaseSourceOwners(input: Scope & {
    sourceFilePublicIds: readonly string[];
    objectIds: readonly string[];
  }): Promise<void>;
  releaseKnowledgeBaseOwners(input: Scope & { objectIds: readonly string[] }): Promise<void>;
  purgeSourceCatalog(input: Scope & {
    sourceFilePublicIds: readonly string[];
    finalPage: boolean;
  }): Promise<void>;
  purgeKnowledgeBaseCatalog(input: Scope): Promise<void>;
  verifyDeletionClosure(input: Scope): Promise<void>;
};

type PurgeRepositoryFactory = (sql: DatabaseClient) => PurgeRepository;

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(
  databaseUrl && runOwner && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedDatabase = hasOwnedTarget ? describe : describe.skip;
let factory: PurgeRepositoryFactory | undefined;

beforeAll(async () => {
  const modulePath = resolve(
    import.meta.dirname,
    "../src/storage-vnext/deletion/postgres-purge.ts"
  );
  const loaded = await import(/* @vite-ignore */ pathToFileURL(modulePath).href)
    .catch(() => ({})) as {
      createPostgresStorageVnextDeletionPurgeRepository?: PurgeRepositoryFactory;
    };
  factory = loaded.createPostgresStorageVnextDeletionPurgeRepository;
});

describeOwnedDatabase("storage vNext deletion purge PostgreSQL repository", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const ownerToken = (runOwner ?? "invalid").replaceAll("-", "_");
  const databaseName = `focowiki_vnext_delete_purge_${ownerToken}_${randomUUID()
    .replaceAll("-", "").slice(0, 10)}`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 4 });
  let databaseCreated = false;
  let repository: PurgeRepository;

  beforeAll(async () => {
    expect(factory).toBeTypeOf("function");
    if (!factory) throw new Error("Deletion purge PostgreSQL repository is unavailable");
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
    repository = factory(sql as unknown as DatabaseClient);
    await sql`
      INSERT INTO focowiki.runtime_setting_revisions
        (public_id, checksum_sha256, settings_values)
      VALUES ('settings-delete-purge', ${"a".repeat(64)}, '{}'::jsonb)
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

  it("purges one deleted file while preserving a shared object and sibling scope", async () => {
    await seedKnowledgeBase("kb-purge-file");
    await seedKnowledgeBase("kb-purge-sibling");
    await seedObject("object-purge-shared");
    await seedSource("kb-purge-file", "source-purge-file", "Deleted.md", "object-purge-shared", true);
    await seedSource("kb-purge-sibling", "source-purge-sibling", "Current.md", "object-purge-shared", false);
    await seedGraph("kb-purge-file", "source-purge-file");
    await seedReleaseEntry("kb-purge-file", "source-purge-file", "object-purge-shared");
    await activateDeletionRoot("kb-purge-file");
    await seedDeletionOperation("kb-purge-file", "operation-purge-file", "source_file", "source-purge-file");
    const current = scope({
      knowledgeBaseId: "kb-purge-file",
      operationPublicId: "operation-purge-file",
      targetPublicId: "source-purge-file"
    });
    const page = await repository.readScopePage({ ...current, limit: 10 });

    expect(page).toEqual({
      sourceFilePublicIds: ["source-purge-file"],
      objectIds: ["object-purge-shared"],
      nextCursor: null
    });
    await repository.purgeSourceGraph({
      ...current,
      sourceFilePublicIds: page.sourceFilePublicIds
    });
    await repository.purgeSourceRelease({
      ...current,
      sourceFilePublicIds: page.sourceFilePublicIds
    });
    await repository.releaseSourceOwners({
      ...current,
      sourceFilePublicIds: page.sourceFilePublicIds,
      objectIds: page.objectIds
    });
    await repository.purgeSourceCatalog({
      ...current,
      sourceFilePublicIds: page.sourceFilePublicIds,
      finalPage: true
    });
    await repository.verifyDeletionClosure(current);

    expect(await count("source_files", "kb-purge-file")).toBe(0);
    expect(await count("graph_nodes", "kb-purge-file")).toBe(0);
    expect(await count("release_catalog_entries", "kb-purge-file")).toBe(0);
    expect(await count("source_files", "kb-purge-sibling")).toBe(1);
    expect(await objectOwnerCount("object-purge-shared")).toBe(1);
    const registration = await sql<Array<{ state: string; zero_owner_since: Date | null }>>`
      SELECT state, zero_owner_since FROM focowiki.object_registrations
      WHERE object_id = 'object-purge-shared'
    `;
    expect(registration).toEqual([{ state: "verified", zero_owner_since: null }]);
    expect(await count("operation_work_items", "kb-purge-file")).toBe(1);
    await sql`
      DELETE FROM focowiki.operations
      WHERE public_id = 'operation-purge-file'
    `;
  });

  it("coalesces every pending soft-deleted source into one release scope", async () => {
    await seedKnowledgeBase("kb-purge-coalesced-release");
    await seedObject("object-purge-coalesced-a");
    await seedObject("object-purge-coalesced-b");
    await seedSource(
      "kb-purge-coalesced-release",
      "source-purge-coalesced-a",
      "Guides/A.md",
      "object-purge-coalesced-a",
      true
    );
    await seedSource(
      "kb-purge-coalesced-release",
      "source-purge-coalesced-b",
      "Archive/B.md",
      "object-purge-coalesced-b",
      true
    );
    const releaseScope = createPostgresStorageVnextDeletionReleaseScope(
      sql as unknown as DatabaseClient
    );

    await expect(releaseScope.read({
      knowledgeBaseId: "kb-purge-coalesced-release",
      targetKind: "source_file",
      targetPublicId: "source-purge-coalesced-a",
      normalizedPath: "guides/a.md",
      maximumSources: 10,
      maximumGraphEdges: 10
    })).resolves.toMatchObject({
      sourceFilePublicIds: [
        "source-purge-coalesced-a",
        "source-purge-coalesced-b"
      ],
      sourceLogicalPaths: ["Guides/A.md", "Archive/B.md"]
    });
  });

  it("purges a whole knowledge base directly and removes scoped audit and roots", async () => {
    await seedKnowledgeBase("kb-purge-whole", true);
    await seedKnowledgeBase("kb-purge-control");
    await seedObject("object-purge-whole");
    await seedObject("object-purge-control");
    await seedSource("kb-purge-whole", "source-purge-whole", "Whole.md", "object-purge-whole", true);
    await seedSource("kb-purge-control", "source-purge-control", "Control.md", "object-purge-control", false);
    await seedGraph("kb-purge-whole", "source-purge-whole");
    await seedReleaseEntry("kb-purge-whole", "source-purge-whole", "object-purge-whole");
    await seedDeletionOperation(
      "kb-purge-whole",
      "operation-purge-whole",
      "knowledge_base",
      "kb-purge-whole"
    );
    await sql`
      INSERT INTO focowiki.security_audit_events (
        public_id, knowledge_base_id, event_type, result, metadata,
        created_at, expires_at
      ) VALUES (
        'audit-purge-whole', 'kb-purge-whole', 'deletion', 'success', '{}'::jsonb,
        now(), now() + interval '1 day'
      )
    `;
    const current = scope({
      knowledgeBaseId: "kb-purge-whole",
      operationPublicId: "operation-purge-whole",
      targetKind: "knowledge_base",
      targetPublicId: "kb-purge-whole"
    });
    const page = await repository.readScopePage({ ...current, limit: 10 });

    expect(page.objectIds).toContain("object-purge-whole");
    await repository.purgeKnowledgeBaseGraph(current);
    await repository.purgeKnowledgeBaseRelease(current);
    await repository.releaseKnowledgeBaseOwners({ ...current, objectIds: page.objectIds });
    await repository.purgeKnowledgeBaseCatalog(current);
    await repository.verifyDeletionClosure(current);

    expect(await count("knowledge_bases", "kb-purge-whole", "public_id")).toBe(0);
    expect(await count("source_files", "kb-purge-whole")).toBe(0);
    expect(await count("release_roots", "kb-purge-whole")).toBe(0);
    expect(await count("security_audit_events", "kb-purge-whole")).toBe(0);
    expect(await count("knowledge_bases", "kb-purge-control", "public_id")).toBe(1);
    expect(await count("source_files", "kb-purge-control")).toBe(1);
  });

  it("refuses to mutate an active generated catalog before deletion activation", async () => {
    await seedKnowledgeBase("kb-purge-release-pending");
    await seedObject("object-purge-release-pending");
    await seedSource(
      "kb-purge-release-pending",
      "source-purge-release-pending",
      "Pending.md",
      "object-purge-release-pending",
      true
    );
    await seedReleaseEntry(
      "kb-purge-release-pending",
      "source-purge-release-pending",
      "object-purge-release-pending"
    );
    const current = scope({
      knowledgeBaseId: "kb-purge-release-pending",
      operationPublicId: "operation-purge-release-pending",
      targetPublicId: "source-purge-release-pending"
    });

    await expect(repository.purgeSourceRelease({
      ...current,
      sourceFilePublicIds: ["source-purge-release-pending"]
    })).rejects.toMatchObject({ code: "release_pending" });
    expect(await count("release_catalog_entries", "kb-purge-release-pending"))
      .toBe(1);
  });

  it("does not globally purge a deleted registration retained by another release", async () => {
    await seedKnowledgeBase("kb-purge-local-catalog");
    await seedObject("object-purge-local-catalog");
    await seedSource(
      "kb-purge-local-catalog",
      "source-purge-local-catalog",
      "Local.md",
      "object-purge-local-catalog",
      true
    );
    await seedKnowledgeBase("kb-purge-retained-registration");
    await seedObject("object-purge-retained-registration");
    await sql`
      INSERT INTO focowiki.release_roots (
        public_id, knowledge_base_id, root_role,
        manifest_checksum_sha256, revision
      ) VALUES (
        'root-purge-retained-registration',
        'kb-purge-retained-registration', 'base', ${"7".repeat(64)}, 1
      )
    `;
    await sql`
      INSERT INTO focowiki.release_catalog_entries (
        knowledge_base_id, release_root_public_id, logical_path, entry_kind,
        checksum_sha256, object_id, byte_count, ordinal
      ) VALUES (
        'kb-purge-retained-registration', 'root-purge-retained-registration',
        'retained.md', 'index', ${checksum("object-purge-retained-registration")},
        'object-purge-retained-registration', 10, 0
      )
    `;
    await sql`
      UPDATE focowiki.object_registrations
      SET state = 'deleted'
      WHERE object_id = 'object-purge-retained-registration'
    `;
    const current = scope({
      knowledgeBaseId: "kb-purge-local-catalog",
      operationPublicId: "operation-purge-local-catalog",
      targetPublicId: "source-purge-local-catalog"
    });

    await expect(repository.purgeSourceCatalog({
      ...current,
      sourceFilePublicIds: ["source-purge-local-catalog"],
      finalPage: true
    })).resolves.toBeUndefined();
    await expect(repository.verifyDeletionClosure(current)).resolves.toBeUndefined();
    const retained = await sql<Array<{ state: string }>>`
      SELECT state FROM focowiki.object_registrations
      WHERE object_id = 'object-purge-retained-registration'
    `;
    expect(retained).toEqual([{ state: "deleted" }]);
  });

  it("purges a deleted directory in bounded pages while preserving its sibling", async () => {
    await seedKnowledgeBase("kb-purge-directory");
    await seedDirectory(
      "kb-purge-directory",
      "directory-purge-root",
      "Guides",
      null,
      true
    );
    await seedDirectory(
      "kb-purge-directory",
      "directory-purge-child",
      "Guides/Child",
      "directory-purge-root",
      true
    );
    await seedDirectory(
      "kb-purge-directory",
      "directory-purge-sibling",
      "Other",
      null,
      false
    );
    await seedObject("object-purge-directory-a");
    await seedObject("object-purge-directory-b");
    await seedObject("object-purge-directory-sibling");
    await seedSource(
      "kb-purge-directory",
      "source-purge-directory-a",
      "Guides/A.md",
      "object-purge-directory-a",
      true,
      "directory-purge-root"
    );
    await seedSource(
      "kb-purge-directory",
      "source-purge-directory-b",
      "Guides/Child/B.md",
      "object-purge-directory-b",
      true,
      "directory-purge-child"
    );
    await seedSource(
      "kb-purge-directory",
      "source-purge-directory-sibling",
      "Other/C.md",
      "object-purge-directory-sibling",
      false,
      "directory-purge-sibling"
    );
    const base = scope({
      knowledgeBaseId: "kb-purge-directory",
      operationPublicId: "operation-purge-directory",
      targetKind: "source_directory",
      targetPublicId: "directory-purge-root",
      normalizedPath: "guides"
    });
    let cursor: string | null = null;
    const pages: string[][] = [];

    do {
      const current = { ...base, cursor };
      const page = await repository.readScopePage({ ...current, limit: 1 });
      pages.push([...page.sourceFilePublicIds]);
      await repository.purgeSourceGraph({
        ...current,
        sourceFilePublicIds: page.sourceFilePublicIds
      });
      await repository.purgeSourceRelease({
        ...current,
        sourceFilePublicIds: page.sourceFilePublicIds
      });
      await repository.releaseSourceOwners({
        ...current,
        sourceFilePublicIds: page.sourceFilePublicIds,
        objectIds: page.objectIds
      });
      await repository.purgeSourceCatalog({
        ...current,
        sourceFilePublicIds: page.sourceFilePublicIds,
        finalPage: page.nextCursor === null
      });
      cursor = page.nextCursor;
    } while (cursor !== null);

    await repository.verifyDeletionClosure({ ...base, cursor: null });
    expect(pages).toEqual([
      ["source-purge-directory-a"],
      ["source-purge-directory-b"]
    ]);
    expect(await count("source_files", "kb-purge-directory")).toBe(1);
    expect(await count("source_directories", "kb-purge-directory")).toBe(1);
    expect(await objectOwnerCount("object-purge-directory-a")).toBe(0);
    expect(await objectOwnerCount("object-purge-directory-b")).toBe(0);
    expect(await objectOwnerCount("object-purge-directory-sibling")).toBe(1);
  });

  it("persists a continuation checkpoint then completes the same deletion work once", async () => {
    await seedKnowledgeBase("kb-purge-worker");
    await seedDeletionOperation(
      "kb-purge-worker",
      "operation-purge-worker",
      "source_file",
      "source-purge-worker"
    );
    const workflow = createPostgresStorageVnextWorkflowRepository(
      sql as unknown as DatabaseClient
    );
    const runAttempt = vi.fn()
      .mockResolvedValueOnce({
        status: "retry",
        receipts: [{
          target: { resourceKind: "catalog_scope" },
          status: "retry",
          reasonCode: "DELETION_SCOPE_PAGE_REMAINING",
          checkpoint: { cursor: "source-purge-worker" }
        }]
      })
      .mockResolvedValueOnce({ status: "completed", receipts: [] });
    const worker = createStorageVnextDeletionWorker({
      workflow,
      purge: { runAttempt },
      owner: "deletion-purge-integration-worker",
      claimLimit: 1,
      maximumAttempts: 3,
      retryDelayMilliseconds: () => 1,
      clock: () => new Date(Date.now() - 1_000).toISOString()
    });

    await expect(worker.runBatch({
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    })).resolves.toMatchObject([{
      workPublicId: "operation-purge-worker",
      outcome: "retry"
    }]);
    const continuation = await sql<Array<{
      state: string;
      attempt_count: number;
      checkpoint: { cursor?: string };
    }>>`
      SELECT state, attempt_count, checkpoint FROM focowiki.operation_work_items
      WHERE operation_public_id = 'operation-purge-worker'
    `;
    expect(continuation).toEqual([{
      state: "queued",
      attempt_count: 0,
      checkpoint: expect.objectContaining({
        targetKind: "source_file",
        targetPublicId: "source-purge-worker",
        cursor: "source-purge-worker"
      })
    }]);

    await expect(worker.runBatch({
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    })).resolves.toMatchObject([{
      workPublicId: "operation-purge-worker",
      outcome: "completed"
    }]);
    expect(await count("operation_work_items", "kb-purge-worker")).toBe(0);
    expect(await count("operation_results", "kb-purge-worker")).toBe(1);
    await expect(worker.runBatch({
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    })).resolves.toEqual([]);
    expect(runAttempt).toHaveBeenCalledTimes(2);
  });

  it("persists one deletion candidate with the released path dependency closure", async () => {
    await seedKnowledgeBase("kb-purge-release-plan");
    await seedDeletionOperation(
      "kb-purge-release-plan",
      "operation-purge-release-plan",
      "source_file",
      "source-purge-release-plan"
    );
    const releases = createPostgresStorageVnextReleaseRepository(
      sql as unknown as DatabaseClient
    );
    const handoff = createStorageVnextDeletionReleaseHandoff(releases);
    const plan = planStorageVnextDeletionCandidate({
      knowledgeBaseId: "kb-purge-release-plan",
      operationPublicId: "operation-purge-release-plan",
      targetKind: "source_file",
      targetPublicId: "source-purge-release-plan",
      sourceFilePublicIds: ["source-purge-release-plan"],
      sourceLogicalPaths: ["Guides/Delete.md"],
      directoryLogicalPaths: [],
      graphSourceFilePublicIds: ["source-purge-release-plan"],
      graphEdgePublicIds: [],
      maximumChangedFacts: 100,
      maximumDependencies: 100
    });
    const request = {
      ...plan,
      createdAt: "2026-08-01T00:00:00.000Z",
      idempotency: {
        key: "key-operation-purge-release-plan",
        requestHash: "c".repeat(64)
      }
    };

    const first = await handoff.apply(request);
    await expect(handoff.apply(request)).resolves.toEqual(first);
    expect(await count("release_candidates", "kb-purge-release-plan")).toBe(1);
    const facts = await sql<Array<{
      fact_kind: string;
      fact_public_id: string;
      change_kind: string;
    }>>`
      SELECT fact_kind, fact_public_id, change_kind
      FROM focowiki.release_candidate_changed_facts
      WHERE knowledge_base_id = 'kb-purge-release-plan'
    `;
    expect(facts).toEqual([{
      fact_kind: "source_file",
      fact_public_id: "source-purge-release-plan",
      change_kind: "deleted"
    }]);
    const paths = await sql<Array<{ dependency_public_id: string }>>`
      SELECT dependency_public_id
      FROM focowiki.release_candidate_dependencies
      WHERE knowledge_base_id = 'kb-purge-release-plan'
        AND dependency_kind = 'path'
    `;
    expect(paths).toEqual([{ dependency_public_id: "pages/Guides/Delete.md" }]);
  });

  async function seedKnowledgeBase(knowledgeBaseId: string, deleted = false) {
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision, deleted_at)
      VALUES (${knowledgeBaseId}, ${knowledgeBaseId}, 1, ${deleted ? new Date() : null})
    `;
  }

  async function seedObject(objectId: string) {
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        ${objectId}, ${`owned/${objectId}`}, ${checksum(objectId)}, 10,
        'text/markdown; charset=utf-8', 'source-markdown-v1', 'verified',
        ${`attempt-${objectId}`}, now()
      )
    `;
  }

  async function seedDirectory(
    knowledgeBaseId: string,
    directoryPublicId: string,
    logicalPath: string,
    parentPublicId: string | null,
    deleted: boolean
  ) {
    await sql`
      INSERT INTO focowiki.source_directories (
        public_id, knowledge_base_id, parent_public_id, logical_path,
        normalized_path, title, revision, deleted_at
      ) VALUES (
        ${directoryPublicId}, ${knowledgeBaseId}, ${parentPublicId}, ${logicalPath},
        ${logicalPath.toLowerCase()}, ${logicalPath}, 1,
        ${deleted ? new Date() : null}
      )
    `;
  }

  async function seedSource(
    knowledgeBaseId: string,
    sourceFilePublicId: string,
    logicalPath: string,
    objectId: string,
    deleted: boolean,
    directoryPublicId: string | null = null
  ) {
    const revisionPublicId = `revision-${sourceFilePublicId}`;
    await sql`
      INSERT INTO focowiki.source_files (
        public_id, knowledge_base_id, directory_public_id,
        logical_path, normalized_path,
        title, status, revision, deleted_at
      ) VALUES (
        ${sourceFilePublicId}, ${knowledgeBaseId}, ${directoryPublicId}, ${logicalPath},
        ${logicalPath.toLowerCase()}, ${logicalPath}, 'ready', 1,
        ${deleted ? new Date() : null}
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type, revision_role, expires_at
      ) VALUES (
        ${revisionPublicId}, ${knowledgeBaseId}, ${sourceFilePublicId}, ${objectId},
        ${checksum(objectId)}, 10, 'text/markdown; charset=utf-8', 'current', NULL
      )
    `;
    await sql`
      INSERT INTO focowiki.source_file_current_revisions (
        knowledge_base_id, source_file_public_id, source_revision_public_id, revision
      ) VALUES (${knowledgeBaseId}, ${sourceFilePublicId}, ${revisionPublicId}, 1)
    `;
    await sql`
      INSERT INTO focowiki.object_owners (
        public_id, knowledge_base_id, object_id, owner_kind, source_revision_public_id
      ) VALUES (
        ${`owner-${sourceFilePublicId}`}, ${knowledgeBaseId}, ${objectId},
        'source_revision', ${revisionPublicId}
      )
    `;
  }

  async function seedGraph(knowledgeBaseId: string, sourceFilePublicId: string) {
    await sql`
      INSERT INTO focowiki.graph_nodes (
        public_id, knowledge_base_id, source_file_public_id,
        source_revision_public_id, logical_path, label, node_kind, revision
      ) VALUES (
        ${`node-${sourceFilePublicId}`}, ${knowledgeBaseId}, ${sourceFilePublicId},
        ${`revision-${sourceFilePublicId}`}, ${`pages/${sourceFilePublicId}.md`},
        ${sourceFilePublicId}, 'page', 1
      )
    `;
  }

  async function seedReleaseEntry(
    knowledgeBaseId: string,
    sourceFilePublicId: string,
    objectId: string
  ) {
    const rootPublicId = `root-${knowledgeBaseId}`;
    await sql`
      INSERT INTO focowiki.release_roots (
        public_id, knowledge_base_id, root_role, manifest_checksum_sha256, revision
      ) VALUES (${rootPublicId}, ${knowledgeBaseId}, 'active', ${"b".repeat(64)}, 1)
    `;
    await sql`
      INSERT INTO focowiki.release_catalog_entries (
        knowledge_base_id, release_root_public_id, logical_path, entry_kind,
        source_file_public_id, checksum_sha256, object_id, byte_count, ordinal
      ) VALUES (
        ${knowledgeBaseId}, ${rootPublicId}, ${`pages/${sourceFilePublicId}.md`},
        'source', ${sourceFilePublicId}, ${checksum(objectId)}, ${objectId}, 10, 0
      )
    `;
    await sql`
      INSERT INTO focowiki.object_owners (
        public_id, knowledge_base_id, object_id, owner_kind, release_root_public_id
      ) VALUES (
        ${`owner-root-${knowledgeBaseId}`}, ${knowledgeBaseId}, ${objectId},
        'active_root', ${rootPublicId}
      )
    `;
  }

  async function activateDeletionRoot(knowledgeBaseId: string) {
    await sql.begin(async (transaction) => {
      await transaction`
        UPDATE focowiki.release_roots
        SET root_role = 'rollback', expires_at = now() + interval '1 hour'
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND root_role = 'active'
      `;
      await transaction`
        INSERT INTO focowiki.release_roots (
          public_id, knowledge_base_id, root_role,
          manifest_checksum_sha256, revision
        ) VALUES (
          ${`root-deletion-${knowledgeBaseId}`}, ${knowledgeBaseId}, 'active',
          ${"d".repeat(64)}, 2
        )
      `;
    });
  }

  async function seedDeletionOperation(
    knowledgeBaseId: string,
    operationPublicId: string,
    targetKind: Scope["targetKind"],
    targetPublicId: string
  ) {
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        target_kind, target_public_id
      ) VALUES (
        ${operationPublicId}, ${knowledgeBaseId}, 'deletion', 'accepted',
        ${targetKind}, ${targetPublicId}
      )
    `;
    await sql`
      INSERT INTO focowiki.operation_idempotency (
        public_id, knowledge_base_id, idempotency_key, request_hash,
        operation_public_id, expires_at
      ) VALUES (
        ${`idempotency-${operationPublicId}`}, ${knowledgeBaseId},
        ${`key-${operationPublicId}`}, ${"c".repeat(64)}, ${operationPublicId},
        now() + interval '1 day'
      )
    `;
    await sql`
      INSERT INTO focowiki.operation_work_items (
        operation_public_id, knowledge_base_id, work_kind, state,
        operation_revision, settings_revision_public_id, attempt_count,
        next_attempt_at, checkpoint
      ) VALUES (
        ${operationPublicId}, ${knowledgeBaseId}, 'deletion', 'queued', 1,
        'settings-delete-purge', 0, now(), ${sql.json({
          targetKind,
          targetPublicId,
          normalizedPath: null,
          activeSearchProviderIndexUid: null,
          candidateSearchProviderIndexUid: null,
          cursor: null
        })}
      )
    `;
  }

  async function count(table: string, knowledgeBaseId: string, column = "knowledge_base_id") {
    const rows = await sql.unsafe<Array<{ count: string }>>(
      `SELECT count(*)::text AS count FROM focowiki.${table} WHERE ${column} = $1`,
      [knowledgeBaseId]
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function objectOwnerCount(objectId: string) {
    const rows = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM focowiki.object_owners
      WHERE object_id = ${objectId}
    `;
    return Number(rows[0]?.count ?? 0);
  }
});

function scope(overrides: Partial<Scope> = {}): Scope {
  return {
    knowledgeBaseId: "kb-purge-file",
    operationPublicId: "operation-purge-file",
    targetKind: "source_file",
    targetPublicId: "source-purge-file",
    normalizedPath: null,
    cursor: null,
    ...overrides
  };
}

function checksum(value: string): string {
  return Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64);
}

function databaseConnectionUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
