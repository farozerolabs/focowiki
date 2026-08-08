import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPostgresStorageVnextCatalogRepository,
  StorageVnextCatalogRepositoryError
} from "../src/storage-vnext/catalog/postgres-repository.js";
import type { StorageVnextCurrentSourceFact } from
  "../src/storage-vnext/catalog/ports.js";
import { acceptStorageVnextSourceRevision } from "../src/storage-vnext/catalog/source-revision-service.js";
import { createPostgresStorageVnextOwnershipRepository } from
  "../src/storage-vnext/ownership/postgres-repository.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(
  databaseUrl
  && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedDatabase = hasOwnedTarget ? describe : describe.skip;
const bootstrap = readFileSync(
  resolve(import.meta.dirname, "../migrations/001_storage_vnext.sql"),
  "utf8"
);

describeOwnedDatabase("storage vNext current catalog repository", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const ownerToken = (runOwner ?? "invalid").replaceAll("-", "_");
  const databaseName = `focowiki_vnext_catalog_${ownerToken}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 8 });
  const repository = createPostgresStorageVnextCatalogRepository(sql);
  const ownership = createPostgresStorageVnextOwnershipRepository(sql);
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await sql.unsafe(bootstrap);
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

  it("stores normalized current knowledge-base, directory, file, metadata, and status facts", async () => {
    await createKnowledgeBase(repository, "kb-current");
    const directory = await repository.createDirectory({
      publicId: "dir-current",
      knowledgeBaseId: "kb-current",
      parentPublicId: null,
      logicalPath: "Guides",
      title: "Guides"
    });
    const source = await repository.createSourceFile({
      publicId: "file-current",
      knowledgeBaseId: "kb-current",
      directoryPublicId: directory.publicId,
      logicalPath: "Guides/Start.md",
      title: "Start",
      metadata: { language: "en", priority: 1 },
      status: "pending"
    });

    expect(directory.normalizedPath).toBe("guides");
    expect(source.normalizedPath).toBe("guides/start.md");
    expect(source.currentRevisionPublicId).toBeNull();
    expect(source.metadata).toEqual({ language: "en", priority: 1 });

    const updated = await repository.updateSourceFileState({
      knowledgeBaseId: "kb-current",
      publicId: "file-current",
      metadata: { language: "en", priority: 2 },
      status: "ready",
      safeErrorCode: null,
      safeErrorMessage: null,
      modelInvocation: {
        sourceRevisionPublicId: "revision-current",
        status: "completed",
        modelName: "deepseek-v4-flash",
        startedAt: "2026-08-01T00:00:00.000Z",
        endedAt: "2026-08-01T00:00:02.000Z",
        warningCount: 1,
        errorCode: null
      },
      revisionCheck: { expectedRevision: source.revision }
    });
    expect(updated.revision).toBe(source.revision + 1);
    expect(updated.status).toBe("ready");
    expect(updated.metadata).toEqual({ language: "en", priority: 2 });
    expect(updated.modelInvocation).toEqual({
      sourceRevisionPublicId: "revision-current",
      status: "completed",
      modelName: "deepseek-v4-flash",
      startedAt: "2026-08-01T00:00:00.000Z",
      endedAt: "2026-08-01T00:00:02.000Z",
      warningCount: 1,
      errorCode: null
    });
    await expect(repository.getKnowledgeBase({ knowledgeBaseId: "kb-current" }))
      .resolves.toMatchObject({ publicId: "kb-current", visibility: "current" });
  });

  it("round-trips native, legacy, malformed, and incomplete OKF metadata through JSONB", async () => {
    await createKnowledgeBase(repository, "kb-okf-v02");
    const metadataCases = [
      {
        type: "Guide",
        sources: [{
          id: "source-a",
          resource: "https://example.com/source",
          last_modified: "2026-08-07"
        }],
        generated: { by: "process:publisher", at: "2026-08-07T10:00:00.000Z" },
        verified: [{ by: "human:reviewer", at: "2026-08-07T11:00:00.000Z" }],
        status: "stable",
        stale_after: "2026-09-23"
      },
      {
        type: "Guide",
        timestamp: "2026-06-20T22:53:05Z",
        future: { release_date: "2026-08-07" }
      },
      {
        type: ["Guide"],
        sources: "invalid",
        generated: 42,
        verified: "invalid",
        status: "archived",
        stale_after: "tomorrow"
      },
      {
        type: "Attested Computation",
        runtime: ["python"],
        parameters: "invalid",
        executor: 42,
        attester: false
      }
    ];

    for (const [index, metadata] of metadataCases.entries()) {
      const source = await repository.createSourceFile({
        publicId: `file-okf-v02-${index}`,
        knowledgeBaseId: "kb-okf-v02",
        directoryPublicId: null,
        logicalPath: `case-${index}.md`,
        title: `Case ${index}`,
        metadata,
        status: "ready"
      });
      await expect(repository.getSourceFile({
        knowledgeBaseId: "kb-okf-v02",
        publicId: source.publicId
      })).resolves.toMatchObject({ metadata });
    }
  });

  it("creates immutable revisions only for verified objects and selects one current pointer", async () => {
    await createKnowledgeBase(repository, "kb-revision");
    const source = await repository.createSourceFile({
      publicId: "file-revision",
      knowledgeBaseId: "kb-revision",
      directoryPublicId: null,
      logicalPath: "Revision.md",
      title: "Revision",
      metadata: {},
      status: "pending"
    });
    await insertObject(sql, {
      objectId: "object-revision-a",
      checksum: "a".repeat(64),
      byteCount: 12
    });
    const revision = revisionFact({
      publicId: "revision-a",
      knowledgeBaseId: "kb-revision",
      sourceFilePublicId: source.publicId,
      objectId: "object-revision-a",
      checksum: "a".repeat(64),
      byteCount: 12
    });

    await expect(repository.createImmutableRevision(revision)).resolves.toEqual(revision);
    await expect(repository.createImmutableRevision(revision)).resolves.toEqual(revision);
    await expect(repository.createImmutableRevision({
      ...revision,
      checksum: "b".repeat(64)
    })).rejects.toMatchObject({ code: "immutable_revision_conflict" });

    const selected = await repository.compareAndSetCurrentRevision({
      knowledgeBaseId: "kb-revision",
      sourceFilePublicId: source.publicId,
      revisionPublicId: revision.publicId,
      revisionCheck: { expectedRevision: source.revision }
    });
    expect(selected.currentRevisionPublicId).toBe(revision.publicId);
    await expect(repository.getCurrentSourceRevision({
      knowledgeBaseId: "kb-revision",
      sourceFilePublicId: source.publicId
    })).resolves.toEqual(revision);

    await sql`
      INSERT INTO focowiki.object_registrations
        (object_id, storage_key, checksum_sha256, byte_count, content_type,
         object_format, state, write_attempt_public_id)
      VALUES ('object-unverified', 'owned/source/object-unverified', ${"c".repeat(64)}, 1,
        'text/markdown; charset=utf-8', 'source-markdown-v1', 'reserved', 'write-unverified')
    `;
    await expect(repository.createImmutableRevision(revisionFact({
      publicId: "revision-unverified",
      knowledgeBaseId: "kb-revision",
      sourceFilePublicId: source.publicId,
      objectId: "object-unverified",
      checksum: "c".repeat(64),
      byteCount: 1
    }))).rejects.toMatchObject({ code: "object_unverified" });
  });

  it("hides soft-deleted rows while retaining explicit cleanup visibility", async () => {
    await createKnowledgeBase(repository, "kb-delete");
    const source = await repository.createSourceFile({
      publicId: "file-delete",
      knowledgeBaseId: "kb-delete",
      directoryPublicId: null,
      logicalPath: "Delete.md",
      title: "Delete",
      metadata: {},
      status: "failed",
      safeErrorCode: "SOURCE_FAILED",
      safeErrorMessage: "Source processing failed."
    });
    await repository.markSourceFileDeleted({
      knowledgeBaseId: "kb-delete",
      publicId: source.publicId,
      revisionCheck: { expectedRevision: source.revision },
      deletedAt: "2026-08-01T00:00:00.000Z"
    });

    await expect(repository.getSourceFile({
      knowledgeBaseId: "kb-delete",
      publicId: source.publicId
    })).resolves.toBeNull();
    const deleted = await repository.listSourceFiles({
      knowledgeBaseId: "kb-delete",
      directoryPublicId: undefined,
      visibility: "deleted",
      limit: 10,
      cursor: null
    });
    expect(deleted.items.map((item) => item.publicId)).toEqual([source.publicId]);
    expect(deleted.items[0]?.visibility).toBe("deleted");
  });

  it("normalizes nested Unicode paths and rejects an equivalent duplicate path", async () => {
    await createKnowledgeBase(repository, "kb-unicode");
    const parent = await repository.createDirectory({
      publicId: "dir-guides",
      knowledgeBaseId: "kb-unicode",
      parentPublicId: null,
      logicalPath: "Guides",
      title: "Guides"
    });
    const child = await repository.createDirectory({
      publicId: "dir-cafe",
      knowledgeBaseId: "kb-unicode",
      parentPublicId: parent.publicId,
      logicalPath: "Guides/Cafe\u0301",
      title: "Café"
    });
    expect(child.logicalPath).toBe("Guides/Café");
    expect(child.normalizedPath).toBe("guides/café");

    await expect(repository.createDirectory({
      publicId: "dir-cafe-duplicate",
      knowledgeBaseId: "kb-unicode",
      parentPublicId: parent.publicId,
      logicalPath: "Guides/Café",
      title: "Duplicate"
    })).rejects.toMatchObject({ code: "normalized_path_conflict" });

    const source = await repository.createSourceFile({
      publicId: "file-cafe",
      knowledgeBaseId: "kb-unicode",
      directoryPublicId: child.publicId,
      logicalPath: "Guides/Cafe\u0301/Resume\u0301.md",
      title: "Résumé",
      metadata: {},
      status: "ready"
    });
    expect(source.logicalPath).toBe("Guides/Café/Resumé.md");
    expect(source.normalizedPath).toBe("guides/café/resumé.md");
    await expect(repository.createSourceFile({
      publicId: "file-cafe-duplicate",
      knowledgeBaseId: "kb-unicode",
      directoryPublicId: child.publicId,
      logicalPath: "Guides/Café/Resumé.md",
      title: "Duplicate",
      metadata: {},
      status: "ready"
    })).rejects.toMatchObject({ code: "normalized_path_conflict" });

    await expect(repository.updateLogicalPath({
      knowledgeBaseId: "kb-unicode",
      publicId: source.publicId,
      logicalPath: "Elsewhere/Resumé.md",
      revisionCheck: { expectedRevision: source.revision }
    })).rejects.toMatchObject({ code: "scope_conflict" });
    await expect(repository.getSourceFile({
      knowledgeBaseId: "kb-unicode",
      publicId: source.publicId
    })).resolves.toMatchObject({
      logicalPath: source.logicalPath,
      normalizedPath: source.normalizedPath,
      revision: source.revision
    });
  });

  it("allows exactly one concurrent current-revision compare-and-set", async () => {
    await createKnowledgeBase(repository, "kb-cas");
    const source = await repository.createSourceFile({
      publicId: "file-cas",
      knowledgeBaseId: "kb-cas",
      directoryPublicId: null,
      logicalPath: "Concurrent.md",
      title: "Concurrent",
      metadata: {},
      status: "ready"
    });
    for (const suffix of ["a", "b"] as const) {
      await insertObject(sql, {
        objectId: `object-cas-${suffix}`,
        checksum: suffix.repeat(64),
        byteCount: 1
      });
      await repository.createImmutableRevision(revisionFact({
        publicId: `revision-cas-${suffix}`,
        knowledgeBaseId: "kb-cas",
        sourceFilePublicId: source.publicId,
        objectId: `object-cas-${suffix}`,
        checksum: suffix.repeat(64),
        byteCount: 1
      }));
    }

    const results = await Promise.allSettled(["a", "b"].map((suffix) =>
      repository.compareAndSetCurrentRevision({
        knowledgeBaseId: "kb-cas",
        sourceFilePublicId: source.publicId,
        revisionPublicId: `revision-cas-${suffix}`,
        revisionCheck: { expectedRevision: source.revision }
      })
    ));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) =>
      result.status === "rejected"
      && result.reason instanceof StorageVnextCatalogRepositoryError
      && result.reason.code === "revision_conflict"
    )).toHaveLength(1);
  });

  it("converges concurrent identical source acceptance on one object, revision, owner, and pointer", async () => {
    await createKnowledgeBase(repository, "kb-dedup");
    const source = await repository.createSourceFile({
      publicId: "file-dedup",
      knowledgeBaseId: "kb-dedup",
      directoryPublicId: null,
      logicalPath: "Dedup.md",
      title: "Dedup",
      metadata: {},
      status: "ready"
    });
    const bytes = new TextEncoder().encode("# Identical\n");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const storedObjects = new Set<string>();
    const objectWriter = {
      async putVerified(input: {
        writeAttemptPublicId: string;
        createdAt: string;
      }) {
        const outcome = storedObjects.has(checksum) ? "reused" as const : "stored" as const;
        storedObjects.add(checksum);
        const object = {
          outcome,
          objectId: `source-sha256:${checksum}`,
          storageKey: `owned/source/${checksum}.md`,
          checksum,
          byteCount: bytes.byteLength,
          contentType: "text/markdown; charset=utf-8" as const,
          objectFormat: "source-markdown-v1" as const
        };
        await ownership.reserve({
          objectId: object.objectId,
          storageKey: object.storageKey,
          checksum: object.checksum,
          byteCount: object.byteCount,
          contentType: object.contentType,
          format: object.objectFormat,
          writeAttemptPublicId: input.writeAttemptPublicId,
          createdAt: input.createdAt
        });
        await ownership.markVerified({
          objectId: object.objectId,
          writeAttemptPublicId: input.writeAttemptPublicId,
          checksum: object.checksum,
          byteCount: object.byteCount,
          contentType: object.contentType,
          format: object.objectFormat,
          verifiedAt: input.createdAt
        });
        return object;
      }
    };
    const request = {
      knowledgeBaseId: "kb-dedup",
      sourceFilePublicId: source.publicId,
      expectedRevision: source.revision,
      bytes,
      contentType: "text/markdown; charset=utf-8",
      createdAt: "2026-08-01T00:00:00.000Z"
    };

    const results = await Promise.all([
      acceptStorageVnextSourceRevision({ objectWriter, catalog: repository, request }),
      acceptStorageVnextSourceRevision({ objectWriter, catalog: repository, request })
    ]);
    const counts = await sql<Array<{
      objects: number | string;
      revisions: number | string;
      owners: number | string;
      pointers: number | string;
    }>>`
      SELECT
        (SELECT count(*) FROM focowiki.object_registrations
          WHERE object_id = ${`source-sha256:${checksum}`}) AS objects,
        (SELECT count(*) FROM focowiki.source_revisions
          WHERE knowledge_base_id = 'kb-dedup' AND source_file_public_id = ${source.publicId}) AS revisions,
        (SELECT count(*) FROM focowiki.object_owners
          WHERE knowledge_base_id = 'kb-dedup' AND owner_kind = 'source_revision') AS owners,
        (SELECT count(*) FROM focowiki.source_file_current_revisions
          WHERE knowledge_base_id = 'kb-dedup' AND source_file_public_id = ${source.publicId}) AS pointers
    `;

    expect(storedObjects).toHaveLength(1);
    expect(new Set(results.map((result) => result.revision.publicId))).toHaveLength(1);
    expect(results.map((result) => result.outcome).sort()).toEqual(["activated", "reused"]);
    expect(counts[0]).toEqual({ objects: "1", revisions: "1", owners: "1", pointers: "1" });
  });

  it("isolates all reads and parent/revision relationships by knowledge base", async () => {
    await createKnowledgeBase(repository, "kb-scope-a");
    await createKnowledgeBase(repository, "kb-scope-b");
    await repository.createDirectory({
      publicId: "dir-scope-a",
      knowledgeBaseId: "kb-scope-a",
      parentPublicId: null,
      logicalPath: "Scoped",
      title: "Scoped"
    });
    const source = await repository.createSourceFile({
      publicId: "file-scope-a",
      knowledgeBaseId: "kb-scope-a",
      directoryPublicId: "dir-scope-a",
      logicalPath: "Scoped/A.md",
      title: "A",
      metadata: {},
      status: "ready"
    });

    await expect(repository.getSourceFile({
      knowledgeBaseId: "kb-scope-b",
      publicId: source.publicId
    })).resolves.toBeNull();
    await expect(repository.createDirectory({
      publicId: "dir-scope-b-child",
      knowledgeBaseId: "kb-scope-b",
      parentPublicId: "dir-scope-a",
      logicalPath: "Scoped/Child",
      title: "Child"
    })).rejects.toMatchObject({ code: "scope_conflict" });

    const directoryB = await repository.createDirectory({
      publicId: "dir-scope-b",
      knowledgeBaseId: "kb-scope-b",
      parentPublicId: null,
      logicalPath: "Scoped",
      title: "Scoped"
    });
    const sourceB = await repository.createSourceFile({
      publicId: "file-scope-b",
      knowledgeBaseId: "kb-scope-b",
      directoryPublicId: directoryB.publicId,
      logicalPath: "Scoped/A.md",
      title: "Same path in another knowledge base",
      metadata: {},
      status: "ready"
    });
    expect(sourceB.normalizedPath).toBe(source.normalizedPath);
    await insertObject(sql, {
      objectId: "object-cross-scope",
      checksum: "f".repeat(64),
      byteCount: 1
    });
    await expect(repository.createImmutableRevision(revisionFact({
      publicId: "revision-cross-scope",
      knowledgeBaseId: "kb-scope-b",
      sourceFilePublicId: source.publicId,
      objectId: "object-cross-scope",
      checksum: "f".repeat(64),
      byteCount: 1
    }))).rejects.toMatchObject({ code: "scope_conflict" });
    await expect(repository.getCurrentSourceRevision({
      knowledgeBaseId: "kb-scope-b",
      sourceFilePublicId: source.publicId
    })).resolves.toBeNull();
  });

  it("uses deterministic keyset pages for tree, hydration, backup, and delete discovery", async () => {
    await createKnowledgeBase(repository, "kb-page");
    for (const [index, name] of ["Docs", "Guides", "Notes"].entries()) {
      await repository.createDirectory({
        publicId: `dir-page-${index}`,
        knowledgeBaseId: "kb-page",
        parentPublicId: null,
        logicalPath: name,
        title: name
      });
    }
    for (const [index, name] of ["Alpha", "Beta", "Gamma", "Omega"].entries()) {
      await repository.createSourceFile({
        publicId: `file-page-${index}`,
        knowledgeBaseId: "kb-page",
        directoryPublicId: null,
        logicalPath: `${name}.md`,
        title: name,
        metadata: { order: index },
        status: "ready"
      });
    }

    const collected: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await repository.listSourceFiles({
        knowledgeBaseId: "kb-page",
        directoryPublicId: undefined,
        visibility: "current",
        limit: 2,
        cursor
      });
      collected.push(...page.items.map((item) => item.logicalPath));
      cursor = page.nextCursor;
    } while (cursor);
    expect(collected).toEqual(["Alpha.md", "Beta.md", "Gamma.md", "Omega.md"]);

    const hydrated = await repository.listSourceFilesByPublicIds({
      knowledgeBaseId: "kb-page",
      publicIds: ["file-page-3", "file-page-0", "file-page-missing"],
      limit: 10
    });
    expect(hydrated.map((item) => item.publicId)).toEqual(["file-page-3", "file-page-0"]);

    const directoryPage = await repository.listDirectories({
      knowledgeBaseId: "kb-page",
      parentPublicId: null,
      visibility: "current",
      limit: 2,
      cursor: null
    });
    expect(directoryPage.items.map((item) => item.logicalPath)).toEqual(["Docs", "Guides"]);
    expect(directoryPage.nextCursor).not.toBeNull();
    await expect(repository.listDirectories({
      knowledgeBaseId: "kb-other",
      parentPublicId: null,
      visibility: "current",
      limit: 2,
      cursor: directoryPage.nextCursor
    })).rejects.toMatchObject({ code: "invalid_cursor" });

    const hydratedDirectories = await repository.listDirectoriesByPublicIds({
      knowledgeBaseId: "kb-page",
      publicIds: ["dir-page-2", "dir-page-0", "dir-page-missing"],
      limit: 10
    });
    expect(hydratedDirectories.map((item) => item.publicId)).toEqual([
      "dir-page-2",
      "dir-page-0"
    ]);

    for (const suffix of ["d", "e"] as const) {
      await insertObject(sql, {
        objectId: `object-page-${suffix}`,
        checksum: suffix.repeat(64),
        byteCount: 1
      });
      await repository.createImmutableRevision(revisionFact({
        publicId: `revision-page-${suffix}`,
        knowledgeBaseId: "kb-page",
        sourceFilePublicId: "file-page-0",
        objectId: `object-page-${suffix}`,
        checksum: suffix.repeat(64),
        byteCount: 1
      }));
    }
    const firstRevisionPage = await repository.listSourceRevisions({
      knowledgeBaseId: "kb-page",
      limit: 1,
      cursor: null
    });
    const secondRevisionPage = await repository.listSourceRevisions({
      knowledgeBaseId: "kb-page",
      limit: 1,
      cursor: firstRevisionPage.nextCursor
    });
    expect([
      ...firstRevisionPage.items,
      ...secondRevisionPage.items
    ].map((item) => item.publicId)).toEqual(["revision-page-d", "revision-page-e"]);
  });

  it("pages current source and immutable revision facts in one bounded read", async () => {
    await createKnowledgeBase(repository, "kb-search-source");
    for (const [index, name] of ["Alpha", "Beta", "Gamma"].entries()) {
      const source = await repository.createSourceFile({
        publicId: `file-search-${index}`,
        knowledgeBaseId: "kb-search-source",
        directoryPublicId: null,
        logicalPath: `${name}.md`,
        title: name,
        metadata: { order: index },
        status: "ready"
      });
      const checksum = String(index + 1).repeat(64);
      await insertObject(sql, {
        objectId: `object-search-${index}`,
        checksum,
        byteCount: index + 1
      });
      const revision = revisionFact({
        publicId: `revision-search-${index}`,
        knowledgeBaseId: "kb-search-source",
        sourceFilePublicId: source.publicId,
        objectId: `object-search-${index}`,
        checksum,
        byteCount: index + 1
      });
      await repository.createImmutableRevision(revision);
      await repository.compareAndSetCurrentRevision({
        knowledgeBaseId: "kb-search-source",
        sourceFilePublicId: source.publicId,
        revisionPublicId: revision.publicId,
        revisionCheck: { expectedRevision: source.revision }
      });
    }

    const collected: StorageVnextCurrentSourceFact[] = [];
    let cursor: string | null = null;
    do {
      const page = await repository.listCurrentSources({
        knowledgeBaseId: "kb-search-source",
        limit: 1,
        cursor
      });
      collected.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);

    expect(collected.map((item) => ({
      path: item.sourceFile.logicalPath,
      file: item.sourceFile.publicId,
      revision: item.sourceRevision.publicId,
      object: item.sourceRevision.objectId
    }))).toEqual([
      {
        path: "Alpha.md",
        file: "file-search-0",
        revision: "revision-search-0",
        object: "object-search-0"
      },
      {
        path: "Beta.md",
        file: "file-search-1",
        revision: "revision-search-1",
        object: "object-search-1"
      },
      {
        path: "Gamma.md",
        file: "file-search-2",
        revision: "revision-search-2",
        object: "object-search-2"
      }
    ]);
  });
});

type CatalogRepository = ReturnType<typeof createPostgresStorageVnextCatalogRepository>;

async function createKnowledgeBase(
  repository: CatalogRepository,
  publicId: string
): Promise<void> {
  await repository.createKnowledgeBase({
    publicId,
    name: publicId,
    description: null
  });
}

function revisionFact(input: {
  publicId: string;
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  objectId: string;
  checksum: string;
  byteCount: number;
}) {
  return {
    ...input,
    contentType: "text/markdown; charset=utf-8",
    createdAt: "2026-08-01T00:00:00.000Z"
  };
}

async function insertObject(
  sql: ReturnType<typeof postgres>,
  input: { objectId: string; checksum: string; byteCount: number }
): Promise<void> {
  await sql`
    INSERT INTO focowiki.object_registrations
      (object_id, storage_key, checksum_sha256, byte_count, content_type,
       object_format, state, write_attempt_public_id, verified_at)
    VALUES (${input.objectId}, ${`owned/source/${input.objectId}`}, ${input.checksum},
      ${input.byteCount}, 'text/markdown; charset=utf-8', 'source-markdown-v1',
      'verified', ${`write-${input.objectId}`}, now())
  `;
}

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
