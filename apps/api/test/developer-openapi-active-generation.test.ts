import { describe, expect, it } from "vitest";
import { parseRuntimeConfig } from "../src/config.js";
import type { AdminRepositories } from "../src/db/admin-repositories.js";
import type {
  ActiveGenerationFile,
  ActiveGenerationProjection,
  ActiveGenerationReadRepository,
  ActiveGenerationReadScope
} from "../src/application/ports/active-generation-read-repository.js";
import { hashPublicOpenApiKey } from "../src/public-openapi/keys.js";
import { createPublicOpenApiApp } from "../src/server.js";
import { createStorageKeyspace } from "../src/storage/keys.js";
import type { StorageAdapter } from "../src/storage/s3.js";
import { createTestRedisCoordinator } from "./support/session.js";

const rawKey = "fwok_active-generation-http-test-key";
const knowledgeBaseId = "kb-active-http";

describe("Developer OpenAPI active generation reads", () => {
  it("keeps the file-first read chain inside one active generation contract", async () => {
    const fixture = createFixture();

    const tree = await getJson(fixture.app, `/openapi/v2/knowledge-bases/${knowledgeBaseId}/tree`);
    expect(tree.status).toBe(200);
    expect(tree.body).toMatchObject({ generationId: "generation-a" });
    expect(readItems(tree.body)[0]).toMatchObject({
      fileId: "source-a",
      path: "pages/a.md"
    });
    expect(fixture.treeParentPaths).toEqual(["pages"]);

    const search = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/search?query=shared&mode=hybrid`
    );
    expect(search.status).toBe(200);
    expect(search.body).toMatchObject({
      generationId: "generation-a",
      searchStatus: "ok",
      items: [{
        fileId: "source-a",
        path: "pages/a.md",
        matchType: "hybrid",
        graphContext: {
          graphRef: "_graph/by-file/source-a.json",
          depth: 1,
          seedSourceFileId: "source-a",
          relationships: [{ fileId: "source-b", path: "pages/b.md" }],
          graphPaths: [
            "_graph/by-file/source-a.json",
            "_graph/by-file/source-b.json"
          ]
        }
      }]
    });

    const file = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/source-a`
    );
    expect(file.status).toBe(200);
    expect(file.body).toMatchObject({
      file: {
        generationId: "generation-a",
        fileId: "source-a",
        path: "pages/a.md",
        readActions: {
          fileContentById: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/source-a/content`
        }
      }
    });

    const content = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/source-a/content`
    );
    expect(content.status).toBe(200);
    expect(content.body).toMatchObject({ content: "# A\n\nShared subject." });

    const related = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/source-a/related`
    );
    expect(related.status).toBe(200);
    expect(related.body).toMatchObject({
      generationId: "generation-a",
      items: [{ fileId: "source-b", path: "pages/b.md" }]
    });

    const graph = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/graph/expand?fileId=source-a&depth=2`
    );
    expect(graph.status).toBe(200);
    expect(graph.body).toMatchObject({
      generationId: "generation-a",
      seedFile: { fileId: "source-a", path: "pages/a.md" },
      relationships: [{ fileId: "source-b", path: "pages/b.md" }]
    });
  });

  it("rejects a cursor after active generation changes", async () => {
    const fixture = createFixture();
    const first = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/tree?parentPath=pages&limit=1`
    );
    expect(first.status).toBe(200);
    const cursor = readString(first.body, "nextCursor");
    expect(cursor).toBeTruthy();

    fixture.setGeneration("generation-b");
    const stale = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/tree?parentPath=pages&limit=1&cursor=${encodeURIComponent(cursor!)}`
    );
    expect(stale.status).toBe(422);
    expect(stale.body).toMatchObject({
      error: { code: "VALIDATION_ERROR" }
    });
  });

  it("returns optional graph insight absence without hiding the active graph", async () => {
    const fixture = createFixture();
    const response = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/graph/insights`
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      generationId: "generation-a",
      file: null,
      insights: [],
      resultSummary: { insightCount: 0 }
    });
  });
});

function createFixture() {
  let generationId = "generation-a";
  const treeParentPaths: string[] = [];
  const files = new Map([
    ["source-a", file("source-a", "pages/a.md", "generated/a")],
    ["source-b", file("source-b", "pages/b.md", "generated/b")]
  ]);
  const storage: StorageAdapter = {
    keyspace: createStorageKeyspace("test"),
    async putObject() {},
    async getObjectText(key) {
      if (key === "generated/a") return "# A\n\nShared subject.";
      if (key === "generated/b") return "# B\n\nShared subject.";
      return null;
    }
  };
  const activeGenerationReads: ActiveGenerationReadRepository = {
    async withActiveGeneration(_knowledgeBaseId, reader) {
      return reader(createScope(generationId, files, (parentPath) => treeParentPaths.push(parentPath)));
    }
  };
  const repositories = {
    publicApiKeys: {
      async countActivePublicOpenApiKeys() { return 1; },
      async listPublicOpenApiKeys() { return { items: [], nextCursor: null }; },
      async createPublicOpenApiKey() { throw new Error("Unexpected key creation"); },
      async findActivePublicOpenApiKeyByHash(keyHash: string) {
        return keyHash === hashPublicOpenApiKey(rawKey)
          ? {
              id: "key-active",
              name: "Active key",
              keyHash,
              keyPrefix: "fwok_activ",
              keySuffix: "st-key",
              status: "active" as const,
              createdAt: "2026-07-17T00:00:00.000Z",
              lastUsedAt: null,
              revokedAt: null
            }
          : null;
      },
      async revokePublicOpenApiKey() { return null; },
      async updatePublicOpenApiKeyLastUsed() {}
    }
  } as unknown as AdminRepositories;
  const app = createPublicOpenApiApp({
    config: testConfig(),
    storage,
    repositories,
    redis: createTestRedisCoordinator(),
    activeGenerationReads
  });
  return {
    app,
    treeParentPaths,
    setGeneration(value: string) {
      generationId = value;
    }
  };
}

function createScope(
  generationId: string,
  files: Map<string, ActiveGenerationFile>,
  recordTreeParentPath: (parentPath: string) => void = () => undefined
): ActiveGenerationReadScope {
  const tree = [
    projection(generationId, "source-a", "pages/a.md", "A"),
    projection(generationId, "source-b", "pages/b.md", "B")
  ];
  const relation = relationship(generationId);
  return {
    knowledgeBaseId,
    generationId,
    async findFileById(fileId) {
      const value = files.get(fileId);
      return value ? { ...value, generationId } : null;
    },
    async findFileByPath(path) {
      const value = [...files.values()].find((item) => item.path === path);
      return value ? { ...value, generationId } : null;
    },
    async findFilesBySourceIds(sourceFileIds) {
      return [...files.values()]
        .filter((file) => file.sourceFileId && sourceFileIds.includes(file.sourceFileId))
        .map((file) => ({ ...file, generationId }));
    },
    async findProjection(input) {
      return input.projectionKind === "graph_edge" && input.recordId === "edge-a-b"
        ? relation
        : null;
    },
    async listTree(input) {
      recordTreeParentPath(input.parentPath);
      const start = input.cursor ? 1 : 0;
      const items = tree.slice(start, start + input.limit);
      return {
        items,
        nextCursor: start + input.limit < tree.length
          ? { sortKey: items.at(-1)!.sortKey, recordId: items.at(-1)!.recordId }
          : null
      };
    },
    async listTreeAncestors(paths) {
      return new Map(paths.map((path) => [path, []]));
    },
    async search() {
      return { items: [tree[0]!], nextCursor: null };
    },
    async listRelated(input) {
      if (input.sourceFileId === "source-a") return { items: [relation], nextCursor: null };
      return { items: [], nextCursor: null };
    },
    async listRelatedForSources(input) {
      return new Map(input.sourceFileIds.map((sourceFileId) => [
        sourceFileId,
        sourceFileId === "source-a" ? [relation] : []
      ]));
    }
  };
}

function file(fileId: string, path: string, objectKey: string): ActiveGenerationFile {
  return {
    generationId: "generation-a",
    fileId,
    refKind: "page",
    refKey: fileId,
    lastChangedGenerationId: "generation-a",
    path,
    sourceFileId: fileId,
    objectKey,
    contentType: "text/markdown",
    sizeBytes: 21,
    checksumSha256: fileId,
    title: fileId === "source-a" ? "A" : "B",
    summary: "Shared subject",
    payload: { type: "page" }
  };
}

function projection(
  generationId: string,
  sourceFileId: string,
  path: string,
  title: string
): ActiveGenerationProjection {
  return {
    generationId,
    projectionKind: "search",
    recordId: sourceFileId,
    sourceFileId,
    relatedSourceFileId: null,
    path,
    parentPath: "pages",
    sortKey: path,
    title,
    summary: "Shared subject",
    score: 1,
    payload: { fileId: sourceFileId, path, kind: "file", name: `${title}.md` }
  };
}

function relationship(generationId: string): ActiveGenerationProjection {
  return {
    generationId,
    projectionKind: "graph_edge",
    recordId: "edge-a-b",
    sourceFileId: "source-a",
    relatedSourceFileId: "source-b",
    path: "pages/b.md",
    parentPath: null,
    sortKey: "edge-a-b",
    title: "B",
    summary: "Shared subject",
    score: 0.9,
    payload: {
      fromFileId: "source-a",
      fromPath: "pages/a.md",
      toFileId: "source-b",
      toPath: "pages/b.md",
      relationType: "related",
      weight: 0.9,
      reason: "Shared subject"
    }
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

async function getJson(app: ReturnType<typeof createPublicOpenApiApp>, path: string) {
  const response = await app.request(`http://localhost${path}`, {
    headers: { authorization: `Bearer ${rawKey}` }
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function readString(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function readItems(value: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(value.items)
    ? value.items.filter((item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item)
      )
    : [];
}
