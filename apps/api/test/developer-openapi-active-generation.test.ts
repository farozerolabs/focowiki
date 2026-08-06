import { describe, expect, it } from "vitest";
import { parseRuntimeConfig } from "../src/config.js";
import {
  notFound,
  repositoryUnavailable,
  validationError
} from "../src/developer-openapi/errors.js";
import { createDeveloperOpenApiDocument } from
  "../src/developer-openapi/openapi-document.js";
import {
  hashPublicOpenApiKey,
  type PublicOpenApiKeyRepository
} from "../src/public-openapi/keys.js";
import { createPublicOpenApiApp } from "../src/server.js";
import type { DeveloperOpenApiApplication } from
  "../src/storage-vnext/api/openapi-application.js";
import { createTestRedisCoordinator } from "./support/session.js";

const rawKey = "fwok_vnext-http-test-key";
const knowledgeBaseId = "kb-vnext-http";

describe("Developer OpenAPI released reads", () => {
  it("registers every documented operation and documents every runtime operation", () => {
    const fixture = createFixture();
    const supportedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
    const runtimeOperations = new Set(
      fixture.app.routes
        .filter((route) =>
          supportedMethods.has(route.method)
          && route.path.startsWith("/openapi/v2/")
          && !route.path.includes("*")
        )
        .map((route) => `${route.method} ${route.path}`)
    );
    const documentedOperations = new Set(
      Object.entries(createDeveloperOpenApiDocument().paths).flatMap(([path, pathItem]) =>
        Object.entries(pathItem)
          .filter(([method]) => supportedMethods.has(method.toUpperCase()))
          .map(([method]) =>
            `${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/gu, ":$1")}`
          )
      )
    );

    expect([...runtimeOperations].sort()).toEqual([...documentedOperations].sort());
  });

  it("keeps the file-first read chain on one released root", async () => {
    const fixture = createFixture();
    const tree = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/tree`
    );
    expect(tree).toMatchObject({
      status: 200,
      body: {
        generationId: "root-a",
        items: [{ fileId: "source-a", path: "pages/a.md" }]
      }
    });
    expect(fixture.treeParentPaths).toEqual(["pages"]);

    const search = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/search?query=shared&mode=hybrid`
    );
    expect(search).toMatchObject({
      status: 200,
      body: {
        generationId: "root-a",
        searchStatus: "ok",
        graphSummary: {
          available: true,
          indexedDocumentCount: 1,
          indexedRelationshipCount: 1
        },
        items: [{
          fileId: "source-a",
          path: "pages/a.md",
          matchType: "hybrid",
          graphContext: {
            graphRef: "_graph/by-file/source-a.json",
            depth: 1,
            seedSourceFileId: "source-a",
            relationships: [{
              edgeId: "edge-a-b",
              fileId: "source-b",
              path: "pages/b.md"
            }]
          }
        }]
      }
    });
    expect(fixture.lastSearchInput).toMatchObject({
      scope: "all",
      fileKind: "page",
      graphDepth: 1
    });

    const file = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/source-a`
    );
    expect(file).toMatchObject({
      status: 200,
      body: {
        file: {
          generationId: "root-a",
          fileId: "source-a",
          path: "pages/a.md",
          readActions: {
            fileContentById:
              `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/source-a/content`
          }
        }
      }
    });
    expect((file.body as { file: Record<string, unknown> }).file)
      .not.toHaveProperty("checksumSha256");

    const content = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/source-a/content`
    );
    expect(content).toMatchObject({
      status: 200,
      body: { content: "# A\n\nShared subject." }
    });

    const related = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/source-a/related`
    );
    expect(related).toMatchObject({
      status: 200,
      body: {
        generationId: "root-a",
        items: [{
          edgeId: "edge-a-b",
          fileId: "source-b",
          path: "pages/b.md"
        }]
      }
    });

    const graph = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/graph/expand?fileId=source-a&depth=2`
    );
    expect(graph).toMatchObject({
      status: 200,
      body: {
        generationId: "root-a",
        seedFile: { fileId: "source-a", path: "pages/a.md" },
        relationships: [{
          edgeId: "edge-a-b",
          fileId: "source-b",
          path: "pages/b.md"
        }]
      }
    });
  });

  it("returns ancestor chains for tree searches", async () => {
    const fixture = createFixture();
    const tree = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/tree?query=shared`
    );

    expect(tree).toMatchObject({
      status: 200,
      body: {
        items: [{
          path: "pages/a.md",
          ancestors: [{ path: "pages", entryType: "directory" }]
        }]
      }
    });
  });

  it("returns not found outside an existing knowledge base", async () => {
    const fixture = createFixture({ knowledgeBaseExists: false });
    const tree = await getJson(
      fixture.app,
      "/openapi/v2/knowledge-bases/missing/tree"
    );
    const search = await getJson(
      fixture.app,
      "/openapi/v2/knowledge-bases/missing/files/search?query=shared"
    );

    expect(tree.status).toBe(404);
    expect(search.status).toBe(404);
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

    const byEdge = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/graph/expand?edgeId=edge-a-b`
    );
    expect(byEdge).toMatchObject({
      status: 200,
      body: {
        query: { edgeId: "edge-a-b" },
        relationships: [{ edgeId: "edge-a-b", fileId: "source-b" }]
      }
    });
  });

  it("rejects tree cursors after the released root changes", async () => {
    const fixture = createFixture();
    const first = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/tree?parentPath=pages&limit=1`
    );
    const cursor = readString(first.body, "nextCursor");
    expect(cursor).toBeTruthy();
    fixture.setRoot("root-b");

    const stale = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/tree?parentPath=pages&limit=1&cursor=${encodeURIComponent(cursor!)}`
    );
    expect(stale).toMatchObject({
      status: 422,
      body: { error: { code: "VALIDATION_ERROR" } }
    });
  });

  it("rejects search cursors after the active search revision changes", async () => {
    const fixture = createFixture();
    const path =
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/search?query=shared&mode=hybrid&limit=1`;
    const first = await getJson(fixture.app, path);
    const cursor = readString(first.body, "nextCursor");
    expect(cursor).toBeTruthy();
    fixture.setSearchRevision(2);

    const stale = await getJson(
      fixture.app,
      `${path}&cursor=${encodeURIComponent(cursor!)}`
    );
    expect(stale).toMatchObject({
      status: 422,
      body: {
        error: {
          code: "VALIDATION_ERROR",
          message: expect.stringContaining("Restart the search")
        }
      }
    });
  });

  it("returns a request-correlated availability response", async () => {
    const fixture = createFixture({ treeUnavailable: true });
    const response = await getJson(
      fixture.app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/tree`,
      { "x-request-id": "request-tree-availability-1" }
    );

    expect(response).toEqual({
      status: 503,
      body: {
        error: {
          code: "DATABASE_REPOSITORY_UNAVAILABLE",
          message:
            "The requested data is temporarily unavailable. Retry later and keep the request ID if support assistance is needed.",
          httpStatus: 503
        },
        requestId: "request-tree-availability-1"
      }
    });
  });

  it("returns graph overview states without internal storage data", async () => {
    for (const state of ["available", "empty", "unavailable"] as const) {
      const fixture = createFixture({ graphState: state });
      const response = await getJson(
        fixture.app,
        `/openapi/v2/knowledge-bases/${knowledgeBaseId}/graph/overview`
      );
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        generationId: "root-a",
        availability: state,
        summary: state === "available"
          ? { nodeCount: 2, edgeCount: 1 }
          : { nodeCount: 0, edgeCount: 0 }
      });
      expect(response.body).not.toHaveProperty("contentPath");
      expect(response.body).not.toHaveProperty("graphManifest");
      expect(response.body).not.toHaveProperty("graphInsightsFile");
      expect(response.body).not.toHaveProperty("graphInsightsContent");
      if (state === "unavailable") {
        expect(response.body).toMatchObject({
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
        });
      }
    }
  });

  it("does not expose the retired graph insights route", async () => {
    const response = await getJson(
      createFixture().app,
      `/openapi/v2/knowledge-bases/${knowledgeBaseId}/graph/insights`
    );
    expect(response.status).toBe(404);
  });
});

function createFixture(options: {
  graphState?: "available" | "empty" | "unavailable";
  treeUnavailable?: boolean;
  knowledgeBaseExists?: boolean;
} = {}) {
  let rootId = "root-a";
  let searchRevision = 1;
  const treeParentPaths: string[] = [];
  let lastSearchInput: Record<string, unknown> | null = null;
  const exists = (id: string) =>
    options.knowledgeBaseExists !== false && id !== "missing";
  const application: DeveloperOpenApiApplication = {
    async createKnowledgeBase() {
      throw repositoryUnavailable();
    },
    async listKnowledgeBases() {
      return { items: [], nextCursor: null };
    },
    async getKnowledgeBase(id) {
      if (!exists(id)) throw notFound();
      return { id, name: "Knowledge base" };
    },
    async getSourceFile() {
      return null;
    },
    async readSourceContent() {
      throw repositoryUnavailable();
    },
    async listSourceFileEvents() {
      return { items: [], nextCursor: null };
    },
    async retrySourceFile() {
      throw repositoryUnavailable();
    },
    async listTree(request) {
      if (!exists(request.knowledgeBaseId)) throw notFound();
      if (options.treeUnavailable) throw repositoryUnavailable();
      if (request.cursor && request.cursor !== `tree:${rootId}`) {
        throw validationError("The released tree changed. Restart pagination.");
      }
      treeParentPaths.push(request.parentPath);
      const item = {
        generationId: rootId,
        fileId: "source-a",
        path: "pages/a.md",
        entryType: "file",
        ...(request.query
          ? {
              ancestors: [{
                path: "pages",
                entryType: "directory"
              }]
            }
          : {})
      };
      return {
        generationId: rootId,
        items: [item],
        nextCursor: request.limit === 1 ? `tree:${rootId}` : null
      };
    },
    async searchFiles(request) {
      if (!exists(request.knowledgeBaseId)) throw notFound();
      if (request.cursor && request.cursor !== `search:${searchRevision}`) {
        throw validationError(
          "The active search revision changed. Restart the search."
        );
      }
      lastSearchInput = request;
      return {
        generationId: rootId,
        searchStatus: "ok",
        graphSummary: {
          available: true,
          indexedDocumentCount: 1,
          indexedRelationshipCount: 1
        },
        items: [{
          nodeId: "source-a",
          fileId: "source-a",
          path: "pages/a.md",
          matchType: request.mode,
          graphContext: {
            graphRef: "_graph/by-file/source-a.json",
            depth: request.graphDepth,
            seedSourceFileId: "source-a",
            relationships: [relationship()],
            graphPaths: [
              "_graph/by-file/source-a.json",
              "_graph/by-file/source-b.json"
            ]
          }
        }],
        nextCursor: request.limit === 1 ? `search:${searchRevision}` : null
      };
    },
    async getFileById(request) {
      if (!exists(request.knowledgeBaseId)) throw notFound();
      return {
        file: {
          generationId: rootId,
          fileId: request.fileId,
          path: `pages/${request.fileId === "source-a" ? "a" : "b"}.md`,
          readActions: {
            fileContentById:
              `/openapi/v2/knowledge-bases/${request.knowledgeBaseId}/files/${request.fileId}/content`
          }
        }
      };
    },
    async listRelatedFiles(request) {
      if (!exists(request.knowledgeBaseId)) throw notFound();
      return {
        generationId: rootId,
        items: request.fileId === "source-a" ? [relationship()] : [],
        nextCursor: null
      };
    },
    async expandGraph(request) {
      if (!exists(request.knowledgeBaseId)) throw notFound();
      return {
        generationId: rootId,
        query: {
          ...(request.fileId ? { fileId: request.fileId } : {}),
          ...(request.nodeId ? { nodeId: request.nodeId } : {}),
          ...(request.edgeId ? { edgeId: request.edgeId } : {})
        },
        seedFile: { fileId: "source-a", path: "pages/a.md" },
        relationships: [relationship()]
      };
    },
    async getGraphOverview(request) {
      if (!exists(request.knowledgeBaseId)) throw notFound();
      return graphOverview(rootId, options.graphState ?? "available");
    },
    async getFileContentById(request) {
      if (!exists(request.knowledgeBaseId)) throw notFound();
      return {
        generationId: rootId,
        fileId: request.fileId,
        content: request.fileId === "source-a"
          ? "# A\n\nShared subject."
          : "# B\n\nShared subject."
      };
    },
    async getFileContentByPath(request) {
      if (!exists(request.knowledgeBaseId)) throw notFound();
      const content = request.path === "_graph/index.md"
        ? "# Relationship graph\n\nFollow real files."
        : "# Knowledge base\n\nBrowse documents.";
      return { generationId: rootId, path: request.path, content };
    },
    async createWebhook() {
      throw repositoryUnavailable();
    },
    async listWebhooks() {
      return { items: [], nextCursor: null };
    },
    async deleteWebhook() {
      throw notFound();
    },
    async listWebhookDeliveries() {
      return { items: [], nextCursor: null };
    },
    async redeliverWebhook() {
      throw notFound();
    }
  };
  const app = createPublicOpenApiApp({
    config: testConfig(),
    redis: createTestRedisCoordinator(),
    storageVnextApiKeys: createApiKeys(),
    storageVnextOpenApi: application
  });
  return {
    app,
    treeParentPaths,
    get lastSearchInput() {
      return lastSearchInput;
    },
    setRoot(value: string) {
      rootId = value;
    },
    setSearchRevision(value: number) {
      searchRevision = value;
    }
  };
}

function relationship() {
  return {
    edgeId: "edge-a-b",
    fileId: "source-b",
    path: "pages/b.md",
    relationType: "related",
    weight: 0.9,
    reason: "Shared subject"
  };
}

function graphOverview(
  rootId: string,
  state: "available" | "empty" | "unavailable"
) {
  const available = state !== "unavailable";
  return {
    generationId: rootId,
    availability: state,
    summary: state === "available"
      ? { nodeCount: 2, edgeCount: 1 }
      : { nodeCount: 0, edgeCount: 0 },
    resources: {
      graphIndexPath: available ? "_graph/index.md" : null,
      nodeDirectoryPath: available ? "_graph/graph_node/v1" : null,
      edgeDirectoryPath: available ? "_graph/graph_edge/v1" : null,
      byFileDirectoryPath: available ? "_graph/by-file" : null
    },
    readActions: {
      readIndexContent:
        `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/content?path=index.md`,
      graphIndexContent: available
        ? `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/content?path=_graph%2Findex.md`
        : null,
      listGraphRoot:
        `/openapi/v2/knowledge-bases/${knowledgeBaseId}/tree?parentPath=_graph`,
      listGraphNodes: available
        ? `/openapi/v2/knowledge-bases/${knowledgeBaseId}/tree?parentPath=_graph%2Fgraph_node%2Fv1`
        : null,
      listGraphEdges: available
        ? `/openapi/v2/knowledge-bases/${knowledgeBaseId}/tree?parentPath=_graph%2Fgraph_edge%2Fv1`
        : null,
      listByFileGraph: available
        ? `/openapi/v2/knowledge-bases/${knowledgeBaseId}/tree?parentPath=_graph%2Fby-file`
        : null,
      searchGraph:
        `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/search?query={query}&mode=graph`,
      expandGraphByFileId:
        `/openapi/v2/knowledge-bases/${knowledgeBaseId}/graph/expand?fileId={fileId}`,
      fileDetailById:
        `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/{fileId}`,
      fileContentById:
        `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/{fileId}/content`,
      fileContentByPath:
        `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/content?path={path}`,
      relatedFilesById:
        `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/{fileId}/related`
    }
  };
}

function createApiKeys(): PublicOpenApiKeyRepository {
  return {
    async countActivePublicOpenApiKeys() {
      return 1;
    },
    async listPublicOpenApiKeys() {
      return { items: [], nextCursor: null };
    },
    async createPublicOpenApiKey() {
      throw new Error("Unexpected key creation");
    },
    async findActivePublicOpenApiKeyByHash(keyHash) {
      return keyHash === hashPublicOpenApiKey(rawKey)
        ? {
            id: "key-vnext",
            name: "vNext key",
            keyHash,
            keyPrefix: "fwok_vnex",
            keySuffix: "est-key",
            status: "active",
            createdAt: "2026-07-17T00:00:00.000Z",
            lastUsedAt: null,
            revokedAt: null
          }
        : null;
    },
    async revokePublicOpenApiKey() {
      return null;
    },
    async updatePublicOpenApiKeyLastUsed() {}
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

async function getJson(
  app: ReturnType<typeof createPublicOpenApiApp>,
  path: string,
  headers: Record<string, string> = {}
) {
  const response = await app.request(`http://localhost${path}`, {
    headers: { authorization: `Bearer ${rawKey}`, ...headers }
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>
  };
}

function readString(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}
