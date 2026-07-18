import { describe, expect, it } from "vitest";
import { parseRuntimeConfig } from "../src/config.js";
import type { AdminRepositories } from "../src/db/admin-repositories.js";
import type {
  ActiveGenerationFile,
  ActiveGenerationProjection,
  ActiveGenerationReadRepository,
  ActiveGenerationReadScope
} from "../src/application/ports/active-generation-read-repository.js";
import { createApiApp } from "../src/server.js";
import { createStorageKeyspace } from "../src/storage/keys.js";
import type { StorageAdapter } from "../src/storage/s3.js";
import { createTestRedisCoordinator, loginAndReadSessionCookie } from "./support/session.js";

describe("Admin active generation file reads", () => {
  it("reads tree, search ancestors, content, and relationships from one generation", async () => {
    const fixture = createFixture();
    const cookie = await loginAndReadSessionCookie(fixture.app);

    const tree = await fixture.app.request(
      "/admin/api/knowledge-bases/kb-admin-active/files/tree?parentPath=pages",
      { headers: { cookie } }
    );
    expect(tree.status).toBe(200);
    const treeBody = await tree.json();
    expect(treeBody).toMatchObject({
      items: [
        {
          id: "directory:docs",
          entryType: "directory",
          logicalPath: "pages/docs",
          generatedFileId: null
        },
        {
          id: "source-a",
          entryType: "file",
          logicalPath: "pages/a.md",
          generatedFileId: "source-a"
        }
      ]
    });
    expect(JSON.stringify(treeBody)).not.toContain("bundleFileId");

    const search = await fixture.app.request(
      "/admin/api/knowledge-bases/kb-admin-active/files/tree/search?query=guide",
      { headers: { cookie } }
    );
    expect(search.status).toBe(200);
    await expect(search.json()).resolves.toMatchObject({
      items: [{
        entry: { id: "source-guide", logicalPath: "pages/docs/guide.md" },
        ancestors: [{ id: "directory:docs", logicalPath: "pages/docs" }]
      }]
    });

    const detail = await fixture.app.request(
      "/admin/api/knowledge-bases/kb-admin-active/files/detail?path=pages%2Fa.md&includeRelationships=1",
      { headers: { cookie } }
    );
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody).toMatchObject({
      file: { id: "source-a", logicalPath: "pages/a.md", deletable: true },
      relationships: [{
        fileId: "source-guide",
        generatedFileId: "source-guide",
        path: "pages/docs/guide.md"
      }],
      content: "# A\n\nShared subject."
    });
    expect((detailBody as { file: Record<string, unknown> }).file).not.toHaveProperty(
      "checksumSha256"
    );
    expect(JSON.stringify(detailBody)).not.toContain("bundleFileId");
  });

  it("rejects a tree cursor after the active generation changes", async () => {
    const fixture = createFixture();
    const cookie = await loginAndReadSessionCookie(fixture.app);
    const first = await fixture.app.request(
      "/admin/api/knowledge-bases/kb-admin-active/files/tree?parentPath=pages&limit=1",
      { headers: { cookie } }
    );
    const cursor = (await first.json() as { nextCursor: string }).nextCursor;
    fixture.setGeneration("generation-b");
    const stale = await fixture.app.request(
      `/admin/api/knowledge-bases/kb-admin-active/files/tree?parentPath=pages&limit=1&cursor=${encodeURIComponent(cursor)}`,
      { headers: { cookie } }
    );
    expect(stale.status).toBe(400);
    await expect(stale.json()).resolves.toMatchObject({ error: { code: "INVALID_PAGINATION" } });
  });
});

function createFixture() {
  let generationId = "generation-a";
  const storage: StorageAdapter = {
    keyspace: createStorageKeyspace("test"),
    async putObject() {},
    async headObjectMetadata() { return null; },
    async getObjectText(key) {
      return key === "generated/a" ? "# A\n\nShared subject." : null;
    }
  };
  const activeGenerationReads: ActiveGenerationReadRepository = {
    async withActiveGeneration(_knowledgeBaseId, reader) {
      return reader(createScope(generationId));
    }
  };
  const repositories = {
    knowledgeBases: {
      async getKnowledgeBase(id: string) {
        return id === "kb-admin-active"
          ? {
              id,
              name: "Active knowledge base",
              description: null,
              activeGenerationId: generationId,
              resourceRevision: 1,
              catalogGeneration: 1,
              createdAt: "2026-07-17T00:00:00.000Z",
              updatedAt: "2026-07-17T00:00:00.000Z"
            }
          : null;
      }
    }
  } as unknown as AdminRepositories;
  const app = createApiApp({
    config: testConfig(),
    storage,
    repositories,
    redis: createTestRedisCoordinator(),
    activeGenerationReads
  });
  return {
    app,
    setGeneration(value: string) {
      generationId = value;
    }
  };
}

function createScope(generationId: string): ActiveGenerationReadScope {
  const directory = projection(generationId, {
    recordId: "directory:docs",
    sourceFileId: null,
    path: "pages/docs",
    parentPath: "pages",
    title: "docs",
    payload: {
      kind: "directory",
      name: "docs",
      sourceDirectoryId: "source-directory-docs",
      resourceRevision: 1
    }
  });
  const fileA = projection(generationId, {
    recordId: "source-a",
    sourceFileId: "source-a",
    path: "pages/a.md",
    parentPath: "pages",
    title: "A",
    payload: { kind: "file", name: "a.md", fileId: "source-a" }
  });
  const guide = projection(generationId, {
    recordId: "source-guide",
    sourceFileId: "source-guide",
    path: "pages/docs/guide.md",
    parentPath: "pages/docs",
    title: "Guide",
    payload: { kind: "file", name: "guide.md", fileId: "source-guide" }
  });
  const files = new Map([
    ["pages/a.md", activeFile(generationId, "source-a", "pages/a.md", "generated/a")],
    ["pages/docs/guide.md", activeFile(generationId, "source-guide", "pages/docs/guide.md", "generated/guide")]
  ]);
  return {
    knowledgeBaseId: "kb-admin-active",
    generationId,
    async findFileById(fileId) {
      return [...files.values()].find((file) => file.fileId === fileId) ?? null;
    },
    async findFileByPath(path) {
      return files.get(path) ?? null;
    },
    async findFilesBySourceIds(sourceFileIds) {
      return [...files.values()].filter(
        (file) => file.sourceFileId && sourceFileIds.includes(file.sourceFileId)
      );
    },
    async findProjection() {
      return null;
    },
    async getGraphSummary() {
      return { nodeCount: 0, edgeCount: 0, graphIndexAvailable: false, persisted: true };
    },
    async listTree(input) {
      const all = input.query ? [guide] : [directory, fileA];
      const start = input.cursor ? 1 : 0;
      const items = all.slice(start, start + input.limit);
      return {
        items,
        nextCursor: start + input.limit < all.length
          ? { sortKey: items.at(-1)!.sortKey, recordId: items.at(-1)!.recordId }
          : null
      };
    },
    async listTreeAncestors(paths) {
      return new Map(paths.map((path) => [path, path === guide.path ? [directory] : []]));
    },
    async search() {
      return { items: [], nextCursor: null };
    },
    async listRelated() {
      return {
        items: [projection(generationId, {
          recordId: "edge-a-guide",
          sourceFileId: "source-a",
          relatedSourceFileId: "source-guide",
          path: "pages/docs/guide.md",
          parentPath: null,
          title: "Guide",
          score: 0.9,
          payload: {
            fromFileId: "source-a",
            toFileId: "source-guide",
            relationType: "related",
            weight: 0.9,
            reason: "Shared subject"
          }
        })],
        nextCursor: null
      };
    },
    async listRelatedForSources(input) {
      return new Map(input.sourceFileIds.map((sourceFileId) => [sourceFileId, []]));
    }
  };
}

function activeFile(
  generationId: string,
  fileId: string,
  path: string,
  objectKey: string
): ActiveGenerationFile {
  return {
    generationId,
    fileId,
    refKind: "page",
    refKey: fileId,
    lastChangedGenerationId: generationId,
    path,
    sourceFileId: fileId,
    objectKey,
    contentType: "text/markdown; charset=utf-8",
    sizeBytes: 20,
    checksumSha256: fileId,
    title: fileId,
    summary: "Shared subject",
    payload: { metadata: { type: "page" } }
  };
}

function projection(
  generationId: string,
  input: Partial<ActiveGenerationProjection> & Pick<ActiveGenerationProjection, "recordId">
): ActiveGenerationProjection {
  return {
    generationId,
    projectionKind: "tree",
    recordId: input.recordId,
    sourceFileId: input.sourceFileId ?? null,
    relatedSourceFileId: input.relatedSourceFileId ?? null,
    path: input.path ?? null,
    parentPath: input.parentPath ?? null,
    sortKey: input.path ?? input.recordId,
    title: input.title ?? null,
    summary: input.summary ?? null,
    score: input.score ?? null,
    payload: input.payload ?? {}
  };
}

function testConfig() {
  return parseRuntimeConfig({
    APP_ENV: "development",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "admin-secret",
    DATABASE_URL: "postgres://focowiki:focowiki@127.0.0.1:55432/focowiki",
    REDIS_URL: "redis://127.0.0.1:56379/0",
    PUBLIC_BASE_URL: "https://openapi.example.com",
    S3_ENDPOINT: "https://s3.example.com",
    S3_REGION: "us-east-1",
    S3_BUCKET: "test",
    S3_ACCESS_KEY_ID: "test-access",
    S3_SECRET_ACCESS_KEY: "test-secret",
    S3_PREFIX: "test"
  });
}
