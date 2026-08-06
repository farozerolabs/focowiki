import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "../src/config.js";
import { createApiApp } from "../src/server.js";
import type { StorageVnextAdminReadApplication } from
  "../src/storage-vnext/api/admin-read-application.js";
import type { StorageVnextAdminCoreApplication } from
  "../src/storage-vnext/api/admin-core-application.js";
import type { StorageVnextAdminProcessingApplication } from
  "../src/storage-vnext/api/admin-processing-application.js";
import {
  createTestRedisCoordinator,
  loginAndReadSessionCookie
} from "./support/session.js";

describe("Knowledge base file Admin API", () => {
  it("returns the released generated file tree shape", async () => {
    const { app, cookie } = await createAuthenticatedFileApp();
    const response = await app.request(
      "/admin/api/knowledge-bases/kb-001/files/tree",
      { headers: { cookie } }
    );

    await expect(response.json()).resolves.toEqual({
      items: [pagesEntry(), indexEntry()],
      nextCursor: null
    });
    expect(response.status).toBe(200);
  });

  it("returns generated file detail without storage internals", async () => {
    const { app, cookie } = await createAuthenticatedFileApp();
    const response = await app.request(
      "/admin/api/knowledge-bases/kb-001/files/detail?path=pages/intro.md",
      { headers: { cookie } }
    );
    const body = await response.json() as {
      file: Record<string, unknown>;
      content: string;
      readOnly: boolean;
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      file: {
        id: "bundle-file-001",
        logicalPath: "pages/intro.md",
        contentType: "text/markdown; charset=utf-8",
        okfType: "page",
        title: "Intro",
        tags: ["docs"]
      },
      content: "---\ntype: page\ntitle: Intro\n---\n# Intro",
      readOnly: true
    });
    expect(body.file).not.toHaveProperty("objectKey");
    expect(body.file).not.toHaveProperty("checksumSha256");
  });

  it("returns not found outside the released knowledge base and catalog", async () => {
    const { app, cookie } = await createAuthenticatedFileApp();
    const missingKnowledgeBase = await app.request(
      "/admin/api/knowledge-bases/kb-missing/files/tree",
      { headers: { cookie } }
    );
    const missingFile = await app.request(
      "/admin/api/knowledge-bases/kb-001/files/detail?path=pages/missing.md",
      { headers: { cookie } }
    );

    expect(missingKnowledgeBase.status).toBe(404);
    expect(missingFile.status).toBe(404);
  });

  it("paginates tree entries with an opaque backend cursor", async () => {
    const fixture = await createAuthenticatedFileApp();
    const first = await fixture.app.request(
      "/admin/api/knowledge-bases/kb-001/files/tree?limit=1",
      { headers: { cookie: fixture.cookie } }
    );
    const firstBody = await first.json() as { nextCursor: string | null };
    const second = await fixture.app.request(
      `/admin/api/knowledge-bases/kb-001/files/tree?limit=1&cursor=${firstBody.nextCursor}`,
      { headers: { cookie: fixture.cookie } }
    );

    expect(first.status).toBe(200);
    expect(firstBody.nextCursor).toBe("cursor-tree-1");
    expect(second.status).toBe(200);
    expect(fixture.records.treeCalls).toEqual([
      expect.objectContaining({ limit: 1, cursor: null, parentPath: "" }),
      expect.objectContaining({
        limit: 1,
        cursor: "cursor-tree-1",
        parentPath: ""
      })
    ]);
  });

  it("passes file tree entry filters to the vNext read application", async () => {
    const fixture = await createAuthenticatedFileApp();
    const response = await fixture.app.request(
      "/admin/api/knowledge-bases/kb-001/files/tree?entryType=directory&limit=1",
      { headers: { cookie: fixture.cookie } }
    );

    expect(response.status).toBe(200);
    expect(fixture.records.treeCalls).toEqual([
      expect.objectContaining({
        limit: 1,
        cursor: null,
        parentPath: "",
        entryType: "directory"
      })
    ]);
  });

  it("returns file tree search matches with ancestors", async () => {
    const fixture = await createAuthenticatedFileApp();
    const response = await fixture.app.request(
      "/admin/api/knowledge-bases/kb-001/files/tree/search?query=intro",
      { headers: { cookie: fixture.cookie } }
    );

    await expect(response.json()).resolves.toEqual({
      items: [{
        entry: introEntry(),
        ancestors: [pagesEntry()]
      }],
      nextCursor: null
    });
    expect(response.status).toBe(200);
    expect(fixture.records.treeSearchCalls).toEqual([
      expect.objectContaining({ limit: 100, cursor: null, query: "intro" })
    ]);
  });

  it("rejects invalid file tree search before reading the backend", async () => {
    const fixture = await createAuthenticatedFileApp();
    const response = await fixture.app.request(
      "/admin/api/knowledge-bases/kb-001/files/tree/search?query=a",
      { headers: { cookie: fixture.cookie } }
    );

    await expect(response.json()).resolves.toEqual({
      error: { code: "FILE_TREE_SEARCH_QUERY_TOO_SHORT" }
    });
    expect(response.status).toBe(400);
    expect(fixture.records.treeSearchCalls).toEqual([]);
  });

  it("returns source file cards without internal storage identities", async () => {
    const fixture = await createAuthenticatedFileApp();
    const response = await fixture.app.request(
      "/admin/api/knowledge-bases/kb-001/source-files?limit=1",
      { headers: { cookie: fixture.cookie } }
    );
    const body = await response.json() as {
      items: Array<Record<string, unknown>>;
      refreshAfterMs: number;
    };

    expect(response.status).toBe(200);
    expect(body.items[0]).toMatchObject({
      generatedFileAvailable: true,
      generatedFileId: "bundle-file-001",
      generatedFilePath: "pages/intro.md",
      graphSummary: null
    });
    expect(body.items[0]).not.toHaveProperty("objectKey");
    expect(body.items[0]).not.toHaveProperty("checksumSha256");
    expect(body.items[0]).not.toHaveProperty("releaseId");
    expect(body.items[0]).not.toHaveProperty("bundleRootKey");
    expect(body.refreshAfterMs).toBe(30_000);
  });

  it("returns terminal failure and authorized actions unchanged", async () => {
    const fixture = createFixture();
    fixture.sourceList.items = [failedSourceFile()];
    const { app, cookie } = await authenticate(fixture);
    const response = await app.request(
      "/admin/api/knowledge-bases/kb-001/source-files?limit=1&state=failed",
      { headers: { cookie } }
    );
    const body = await response.json() as { items: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.items[0]).toMatchObject({
      state: "failed",
      currentStage: "projection_generation",
      generatedFileAvailable: false,
      failure: {
        code: "GENERATION_VALIDATION_FAILED",
        retryKind: "publication",
        correlationId: "publication-job-1"
      },
      actions: expect.arrayContaining([
        expect.objectContaining({ kind: "view_failure_details" }),
        expect.objectContaining({
          kind: "retry_publication",
          scope: "knowledge_base_publication"
        })
      ])
    });
    expect(body.items[0]).not.toHaveProperty("processingErrorCode");
    expect(body.items[0]).not.toHaveProperty("publicationErrorCode");
  });

  it("passes lifecycle and column filters to the vNext core application", async () => {
    const fixture = await createAuthenticatedFileApp();
    const response = await fixture.app.request(
      "/admin/api/knowledge-bases/kb-001/source-files?limit=1&fileNameQuery=intro&fileIdQuery=source-file-001&state=visible&currentStage=generation_activation&modelInvocationStatus=not_recorded&generatedOutputStatus=visible&startedFrom=2026-06-14T00%3A00%3A00.000Z&startedTo=2026-06-15T00%3A00%3A00.000Z&endedFrom=2026-06-14T00%3A00%3A00.000Z&endedTo=2026-06-15T00%3A00%3A00.000Z&errorState=without_error&errorCodeQuery=TIMEOUT&actionState=openable",
      { headers: { cookie: fixture.cookie } }
    );

    expect(response.status).toBe(200);
    expect(fixture.records.sourceCalls).toEqual([
      expect.objectContaining({
        knowledgeBaseId: "kb-001",
        limit: 1,
        cursor: null,
        filters: {
          fileNameQuery: "intro",
          fileIdQuery: "source-file-001",
          state: "visible",
          currentStage: "generation_activation",
          modelInvocationStatus: "not_recorded",
          generatedOutputStatus: "visible",
          startedFrom: "2026-06-14T00:00:00.000Z",
          startedTo: "2026-06-15T00:00:00.000Z",
          endedFrom: "2026-06-14T00:00:00.000Z",
          endedTo: "2026-06-15T00:00:00.000Z",
          errorState: "without_error",
          errorCodeQuery: "TIMEOUT",
          actionState: "openable"
        }
      })
    ]);
  });

  it("rejects invalid source file filters before reading the backend", async () => {
    const fixture = await createAuthenticatedFileApp();
    const invalidState = await fixture.app.request(
      "/admin/api/knowledge-bases/kb-001/source-files?state=archived",
      { headers: { cookie: fixture.cookie } }
    );
    const shortText = await fixture.app.request(
      "/admin/api/knowledge-bases/kb-001/source-files?errorCodeQuery=a",
      { headers: { cookie: fixture.cookie } }
    );
    const invertedTime = await fixture.app.request(
      "/admin/api/knowledge-bases/kb-001/source-files?startedFrom=2026-06-15T00%3A00%3A00.000Z&startedTo=2026-06-14T00%3A00%3A00.000Z",
      { headers: { cookie: fixture.cookie } }
    );

    await expect(invalidState.json()).resolves.toEqual({
      error: { code: "INVALID_SOURCE_FILE_FILTER" }
    });
    await expect(shortText.json()).resolves.toEqual({
      error: { code: "SOURCE_FILE_FILTER_TEXT_TOO_SHORT" }
    });
    await expect(invertedTime.json()).resolves.toEqual({
      error: { code: "SOURCE_FILE_FILTER_TIME_RANGE_INVALID" }
    });
    expect(invalidState.status).toBe(400);
    expect(shortText.status).toBe(400);
    expect(invertedTime.status).toBe(400);
    expect(fixture.records.sourceCalls).toEqual([]);
  });

  it("returns the bounded processing summary through the vNext application", async () => {
    const fixture = await createAuthenticatedFileApp();
    const response = await fixture.app.request(
      "/admin/api/knowledge-bases/kb-001/processing-summary",
      { headers: { cookie: fixture.cookie } }
    );

    await expect(response.json()).resolves.toMatchObject({
      sourceFileJobs: {
        queuedCount: 3,
        runningCount: 2,
        failedCount: 1,
        oldestQueuedAgeSeconds: 45
      },
      publicationJobs: {
        queuedCount: 1,
        runningCount: 0,
        oldestQueuedAgeSeconds: 30
      },
      pendingDispatch: {
        pendingCount: 2,
        paused: false,
        pausedReason: null
      },
      publicationProgress: {
        generationId: "generation-001",
        stage: "building",
        processedImpactCount: 3,
        totalImpactCount: 5
      },
      indexMaintenance: {
        requestId: null,
        state: "idle",
        active: false,
        maintenanceRequired: false
      },
      dirtySourceFiles: {
        count: 2,
        oldestDirtyAt: "2026-06-14T00:00:00.000Z"
      }
    });
    expect(response.status).toBe(200);
    expect(fixture.records.processingCalls).toEqual([
      { knowledgeBaseId: "kb-001" }
    ]);
  });

  it("keeps high Admin read traffic free of mutation calls", async () => {
    const fixture = await createAuthenticatedFileApp();
    const requests = Array.from({ length: 3 }, () => [
      fixture.app.request(
        "/admin/api/knowledge-bases/kb-001/source-files?limit=1",
        { headers: { cookie: fixture.cookie } }
      ),
      fixture.app.request(
        "/admin/api/knowledge-bases/kb-001/files/tree?limit=1",
        { headers: { cookie: fixture.cookie } }
      ),
      fixture.app.request(
        "/admin/api/knowledge-bases/kb-001/files/detail?path=pages/intro.md",
        { headers: { cookie: fixture.cookie } }
      )
    ]).flat();

    const responses = await Promise.all(requests);

    expect(responses.map((response) => response.status))
      .toEqual(Array(requests.length).fill(200));
    expect(fixture.records.mutationCalls).toEqual([]);
  });

  it("returns public URLs without storage details", async () => {
    const { app, cookie } = await createAuthenticatedFileApp();
    const response = await app.request(
      "/admin/api/knowledge-bases/kb-001/public-urls",
      { headers: { cookie } }
    );

    await expect(response.json()).resolves.toEqual({
      publicUrls: {
        index:
          "https://kb.example.com/openapi/v2/knowledge-bases/kb-001/files/content?path=index.md",
        search:
          "https://kb.example.com/openapi/v2/knowledge-bases/kb-001/files/content?path=_index%2Fsearch.json",
        links:
          "https://kb.example.com/openapi/v2/knowledge-bases/kb-001/files/content?path=_index%2Flinks.json"
      }
    });
    expect(response.status).toBe(200);
  });
});

async function createAuthenticatedFileApp() {
  return authenticate(createFixture());
}

async function authenticate(fixture: ReturnType<typeof createFixture>) {
  const app = createApiApp({
    config: createConfig(),
    redis: createTestRedisCoordinator(),
    storageVnextAdminRead: fixture.adminRead,
    storageVnextAdminCore: fixture.adminCore,
    storageVnextAdminProcessing: fixture.adminProcessing
  });
  const cookie = await loginAndReadSessionCookie(app);
  return { ...fixture, app, cookie };
}

function createFixture() {
  const records = {
    treeCalls: [] as Array<Record<string, unknown>>,
    treeSearchCalls: [] as Array<Record<string, unknown>>,
    sourceCalls: [] as Array<Record<string, unknown>>,
    processingCalls: [] as Array<Record<string, unknown>>,
    mutationCalls: [] as Array<Record<string, unknown>>
  };
  const sourceList = {
    items: [visibleSourceFile()] as Array<Record<string, unknown>>,
    nextCursor: null,
    refreshAfterMs: 30_000
  };
  const adminRead: StorageVnextAdminReadApplication = {
    async listKnowledgeBases() {
      return { ok: true, value: { items: [], nextCursor: null } };
    },
    async getKnowledgeBase(request) {
      return request.knowledgeBaseId === "kb-001"
        ? {
            ok: true,
            value: {
              id: "kb-001",
              name: "Developer docs",
              description: null,
              activeVersionId: "generation-001",
              catalogVersion: 0,
              createdAt: "2026-06-14T00:00:00.000Z",
              updatedAt: "2026-06-14T00:00:00.000Z"
            }
          }
        : { ok: false, code: "NOT_FOUND" };
    },
    async listTree(request) {
      records.treeCalls.push(request);
      if (request.knowledgeBaseId !== "kb-001") {
        return { ok: false, code: "NOT_FOUND" };
      }
      const entries = [pagesEntry(), indexEntry()].filter((entry) =>
        !request.entryType || entry.entryType === request.entryType
      );
      const start = request.cursor === "cursor-tree-1" ? 1 : 0;
      const items = entries.slice(start, start + request.limit);
      return {
        ok: true,
        value: {
          items,
          nextCursor: start + request.limit < entries.length
            ? "cursor-tree-1"
            : null
        }
      };
    },
    async searchFiles(request) {
      records.treeSearchCalls.push(request);
      if (request.knowledgeBaseId !== "kb-001") {
        return { ok: false, code: "NOT_FOUND" };
      }
      return {
        ok: true,
        value: {
          items: request.query.includes("intro")
            ? [{ entry: introEntry(), ancestors: [pagesEntry()] }]
            : [],
          nextCursor: null
        }
      };
    }
  };
  const unavailable = async () => ({
    ok: false as const,
    code: "DATABASE_REPOSITORY_UNAVAILABLE" as const
  });
  const adminCore: StorageVnextAdminCoreApplication = {
    createKnowledgeBase: unavailable,
    getKnowledgeBase: unavailable,
    deleteKnowledgeBase: unavailable,
    async readGeneratedContent(request) {
      if (
        request.knowledgeBaseId !== "kb-001"
        || request.logicalPath !== "pages/intro.md"
      ) return { ok: false, code: "NOT_FOUND" };
      return {
        ok: true,
        value: {
          file: {
            id: "bundle-file-001",
            logicalPath: "pages/intro.md",
            contentType: "text/markdown; charset=utf-8",
            okfType: "page",
            title: "Intro",
            tags: ["docs"]
          },
          content: "---\ntype: page\ntitle: Intro\n---\n# Intro",
          readOnly: true
        }
      };
    },
    async deleteSourceFile(request) {
      records.mutationCalls.push(request);
      return { ok: false, code: "NOT_FOUND" };
    },
    async listFiles(request) {
      records.sourceCalls.push(request);
      return { ok: true, value: sourceList };
    },
    getFile: unavailable
  };
  const adminProcessing: StorageVnextAdminProcessingApplication = {
    async getProcessingSummary(request) {
      records.processingCalls.push(request);
      return {
        ok: true,
        value: processingSummary()
      };
    }
  };
  return { adminRead, adminCore, adminProcessing, records, sourceList };
}

function pagesEntry() {
  return {
    id: "tree-pages",
    parentPath: "",
    name: "pages",
    logicalPath: "pages",
    sortKey: "0:pages",
    entryType: "directory" as const,
    generatedFileId: null,
    sourceFileId: null,
    fileKind: null,
    directEntryCount: 1,
    directDirectoryCount: 0,
    directFileCount: 1,
    descendantFileCount: 1,
    resourceRevision: null,
    sourceDirectoryId: null,
    deletable: false
  };
}

function indexEntry() {
  return {
    id: "tree-index",
    parentPath: "",
    name: "index.md",
    logicalPath: "index.md",
    sortKey: "1:index.md",
    entryType: "file" as const,
    generatedFileId: "bundle-file-index",
    sourceFileId: null,
    fileKind: "index",
    directEntryCount: 0,
    directDirectoryCount: 0,
    directFileCount: 0,
    descendantFileCount: 0,
    resourceRevision: null,
    sourceDirectoryId: null,
    deletable: false
  };
}

function introEntry() {
  return {
    ...indexEntry(),
    id: "tree-intro",
    parentPath: "pages",
    name: "intro.md",
    logicalPath: "pages/intro.md",
    sortKey: "1:intro.md",
    generatedFileId: "bundle-file-001",
    sourceFileId: "source-001",
    fileKind: "page",
    deletable: true
  };
}

function visibleSourceFile() {
  return {
    id: "source-001",
    name: "intro.md",
    generatedFileAvailable: true,
    generatedFileId: "bundle-file-001",
    generatedFilePath: "pages/intro.md",
    graphSummary: null,
    state: "visible",
    currentStage: "generation_activation",
    failure: null,
    actions: []
  };
}

function failedSourceFile() {
  return {
    id: "source-001",
    name: "intro.md",
    generatedFileAvailable: false,
    generatedFileId: null,
    generatedFilePath: null,
    graphSummary: null,
    state: "failed",
    currentStage: "projection_generation",
    failure: {
      code: "GENERATION_VALIDATION_FAILED",
      retryKind: "publication",
      correlationId: "publication-job-1"
    },
    actions: [
      { kind: "view_failure_details" },
      {
        kind: "retry_publication",
        scope: "knowledge_base_publication"
      }
    ]
  };
}

function processingSummary() {
  return {
    activeVersionId: "generation-001",
    sourceFileJobs: {
      queuedCount: 3,
      runningCount: 2,
      failedCount: 1,
      oldestQueuedAgeSeconds: 45
    },
    publicationJobs: {
      queuedCount: 1,
      runningCount: 0,
      oldestQueuedAgeSeconds: 30
    },
    pendingDispatch: {
      pendingCount: 2,
      paused: false,
      pausedReason: null
    },
    publicationProgress: {
      generationId: "generation-001",
      stage: "building",
      processedImpactCount: 3,
      totalImpactCount: 5
    },
    maintenanceProgress: {
      migration: null,
      lexicalRebuild: null,
      projectionRepair: null,
      compaction: { active: null, latestCompleted: null }
    },
    indexMaintenance: {
      requestId: null,
      state: "idle",
      active: false,
      maintenanceRequired: false
    },
    dirtySourceFiles: {
      count: 2,
      oldestDirtyAt: "2026-06-14T00:00:00.000Z"
    }
  };
}

function createConfig(): RuntimeConfig {
  return {
    admin: { username: "admin", password: "admin-secret" },
    database: { url: "postgres://focowiki:focowiki@127.0.0.1:5432/focowiki" },
    redis: { url: "redis://127.0.0.1:6379/0" },
    ports: { adminApi: 43_000, adminUi: 43_100, publicOpenApi: 43_200 },
    publicApi: { baseUrl: "https://kb.example.com" },
    storage: {
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "focowiki",
      accessKeyId: "s3-access",
      secretAccessKey: "s3-secret",
      prefix: "tenant/demo",
      forcePathStyle: true
    },
    publication: {
      mode: "batch",
      batchSize: 300,
      intervalSeconds: 300,
      indexShardSize: 1_000,
      linkIndexShardSize: 1_000,
      manifestShardSize: 1_000,
      graphEdgeShardSize: 5_000,
      graphCandidateLimit: 200,
      graphMaintenanceBatchSize: 500,
      rootSummaryLimit: 500
    },
    pagination: {
      defaultPageSize: 50,
      maxPageSize: 200,
      treeDefaultPageSize: 100,
      treeMaxPageSize: 500,
      cursorTtlSeconds: 900,
      generatedContentMaxBytes: 10_485_760
    },
    model: { enabled: false },
    corsOrigins: []
  };
}
