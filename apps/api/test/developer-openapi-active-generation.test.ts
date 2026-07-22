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
import {
  toDeveloperActiveFile,
  toDeveloperActiveTreeEntry
} from "../src/developer-openapi/active-generation-serializers.js";
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
          relationships: [{ edgeId: "edge-a-b", fileId: "source-b", path: "pages/b.md" }],
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
    expect((file.body as { file: Record<string, unknown> }).file).not.toHaveProperty(
      "checksumSha256"
    );

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
      items: [{ edgeId: "edge-a-b", fileId: "source-b", path: "pages/b.md" }]
    });

    const graph = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/graph/expand?fileId=source-a&depth=2`
    );
    expect(graph.status).toBe(200);
    expect(graph.body).toMatchObject({
      generationId: "generation-a",
      seedFile: { fileId: "source-a", path: "pages/a.md" },
      relationships: [{ edgeId: "edge-a-b", fileId: "source-b", path: "pages/b.md" }]
    });
  });

  it("returns reusable graph node and edge identifiers", async () => {
    const fixture = createFixture();
    const search = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/search?query=shared&mode=graph`
    );
    expect(search).toMatchObject({
      status: 200,
      body: {
        items: [{ nodeId: "source-a", fileId: "source-a", path: "pages/a.md" }]
      }
    });

    const byNode = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/graph/expand?nodeId=source-a`
    );
    expect(byNode).toMatchObject({
      status: 200,
      body: {
        query: { nodeId: "source-a" },
        relationships: [{ edgeId: "edge-a-b", fileId: "source-b" }]
      }
    });

    const related = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/source-a/related`
    );
    const edgeId = readItems(related.body)[0]?.edgeId;
    expect(edgeId).toBe("edge-a-b");

    const byEdge = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/graph/expand?edgeId=${edgeId}`
    );
    expect(byEdge).toMatchObject({
      status: 200,
      body: {
        query: { edgeId: "edge-a-b" },
        relationships: [{ edgeId: "edge-a-b", fileId: "source-b" }]
      }
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

  it("returns the active graph overview with real continuation actions", async () => {
    const fixture = createFixture();
    const response = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/graph/overview`
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      generationId: "generation-a",
      availability: "available",
      summary: { nodeCount: 2, edgeCount: 1 },
      resources: {
        graphIndexPath: "_graph/index.md",
        nodeDirectoryPath: "_graph/graph_node/v1",
        edgeDirectoryPath: "_graph/graph_edge/v1"
      },
      readActions: {
        graphIndexContent: expect.stringContaining("path=_graph%2Findex.md"),
        listGraphNodes: expect.stringContaining("parentPath=_graph%2Fgraph_node%2Fv1"),
        listGraphEdges: expect.stringContaining("parentPath=_graph%2Fgraph_edge%2Fv1")
      }
    });

    expect(response.body).not.toHaveProperty("contentPath");
    expect(response.body).not.toHaveProperty("graphManifest");
    expect(response.body).not.toHaveProperty("graphInsightsFile");
    expect(response.body).not.toHaveProperty("graphInsightsContent");

    const overview = response.body as {
      readActions: {
        readIndexContent: string;
        graphIndexContent: string;
        listGraphRoot: string;
        searchGraph: string;
        expandGraphByFileId: string;
        fileDetailById: string;
        fileContentById: string;
        fileContentByPath: string;
        relatedFilesById: string;
      };
    };
    const graphIndex = await getJson(fixture.app, overview.readActions.graphIndexContent);
    expect(graphIndex).toMatchObject({
      status: 200,
      body: { content: "# Relationship graph\n\nFollow real files." }
    });
    const graphRoot = await getJson(fixture.app, overview.readActions.listGraphRoot);
    expect(graphRoot.status).toBe(200);

    const concreteActions = [
      overview.readActions.readIndexContent,
      overview.readActions.searchGraph.replace("{query}", "shared"),
      overview.readActions.expandGraphByFileId.replace("{fileId}", "source-a"),
      overview.readActions.fileDetailById.replace("{fileId}", "source-a"),
      overview.readActions.fileContentById.replace("{fileId}", "source-a"),
      overview.readActions.fileContentByPath.replace("{path}", "pages%2Fa.md"),
      overview.readActions.relatedFilesById.replace("{fileId}", "source-a")
    ];
    for (const action of concreteActions) {
      expect((await getJson(fixture.app, action)).status, action).toBe(200);
    }
  });

  it("reports an empty graph without ending file exploration", async () => {
    const fixture = createFixture({ graphState: "empty" });
    const response = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/graph/overview`
    );
    expect(response).toMatchObject({
      status: 200,
      body: {
        availability: "empty",
        summary: { nodeCount: 0, edgeCount: 0 },
        resources: { graphIndexPath: "_graph/index.md" },
        readActions: {
          readIndexContent: expect.stringContaining("path=index.md"),
          graphIndexContent: expect.stringContaining("path=_graph%2Findex.md"),
          searchGraph: expect.stringContaining("mode=graph")
        }
      }
    });
  });

  it("does not expose the retired graph insights route", async () => {
    const fixture = createFixture();
    const response = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/graph/insights`
    );
    expect(response.status).toBe(404);
  });

  it("does not advertise source-only actions for generated navigation files", () => {
    const file = toDeveloperActiveFile(
      knowledgeBaseId,
      generatedFile("directory-leaf", "pages/index-directory-leaf-a.md", "generated/leaf")
    );
    expect(file.readActions).toMatchObject({
      fileDetailById: expect.any(String),
      fileContentById: expect.any(String),
      fileContentByPath: expect.any(String),
      relatedFilesById: null,
      graphExpansionByFileId: null
    });

    const tree = toDeveloperActiveTreeEntry(knowledgeBaseId, {
      ...projection(
        "generation-a",
        "generated-file-directory-leaf",
        "pages/index-directory-leaf-a.md",
        "Directory entries"
      ),
      sourceFileId: null,
      payload: {
        fileId: "generated-file-directory-leaf",
        fileKind: "directory_index_page",
        kind: "file",
        name: "index-directory-leaf-a.md"
      }
    });
    expect(tree).toMatchObject({
      fileKind: "directory_index_page",
      readActions: {
        relatedFilesById: null,
        graphExpansionByFileId: null
      }
    });
  });

  it("returns safe graph guidance when projections are unavailable", async () => {
    const fixture = createFixture({ graphState: "unavailable" });
    const response = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/graph/overview`
    );
    expect(response).toMatchObject({
      status: 200,
      body: {
        availability: "unavailable",
        summary: { nodeCount: 0, edgeCount: 0 },
        resources: {
          graphIndexPath: null,
          nodeDirectoryPath: null,
          edgeDirectoryPath: null,
          byFileDirectoryPath: null
        },
        readActions: {
          graphIndexContent: null,
          listGraphNodes: null,
          listGraphEdges: null,
          listByFileGraph: null
        }
      }
    });
  });
});

function createFixture(options: { graphState?: "available" | "empty" | "unavailable" } = {}) {
  const graphState = options.graphState ?? "available";
  let generationId = "generation-a";
  const treeParentPaths: string[] = [];
  const files = new Map([
    ["source-a", file("source-a", "pages/a.md", "generated/a")],
    ["source-b", file("source-b", "pages/b.md", "generated/b")],
    ["root-index", generatedFile("root-index", "index.md", "generated/root-index")],
    ["graph-index", generatedFile("graph-index", "_graph/index.md", "generated/graph-index")]
  ]);
  const storage: StorageAdapter = {
    keyspace: createStorageKeyspace("test"),
    async putObject() {},
    async headObjectMetadata() { return null; },
    async getObjectText(key) {
      if (key === "generated/a") return "# A\n\nShared subject.";
      if (key === "generated/b") return "# B\n\nShared subject.";
      if (key === "generated/root-index") return "# Knowledge base\n\nBrowse documents.";
      if (key === "generated/graph-index") return "# Relationship graph\n\nFollow real files.";
      return null;
    }
  };
  const activeGenerationReads: ActiveGenerationReadRepository = {
    async withActiveGeneration(_knowledgeBaseId, reader) {
      return reader(createScope(
        generationId,
        files,
        (parentPath) => treeParentPaths.push(parentPath),
        graphState
      ));
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
  recordTreeParentPath: (parentPath: string) => void = () => undefined,
  graphState: "available" | "empty" | "unavailable" = "available"
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
    async getGraphSummary() {
      if (graphState === "available") {
        return { nodeCount: 2, edgeCount: 1, graphIndexAvailable: true, persisted: true };
      }
      return {
        nodeCount: 0,
        edgeCount: 0,
        graphIndexAvailable: graphState === "empty",
        persisted: true
      };
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
    async search(input) {
      return {
        items: [input.mode === "graph"
          ? { ...tree[0]!, projectionKind: "graph_node" }
          : tree[0]!],
        nextCursor: null
      };
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

function generatedFile(fileId: string, path: string, objectKey: string): ActiveGenerationFile {
  return {
    generationId: "generation-a",
    fileId,
    refKind: "root",
    refKey: path,
    lastChangedGenerationId: "generation-a",
    path,
    sourceFileId: null,
    objectKey,
    contentType: "text/markdown",
    sizeBytes: 41,
    checksumSha256: fileId,
    title: "Relationship graph",
    summary: null,
    payload: { type: "index" }
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
