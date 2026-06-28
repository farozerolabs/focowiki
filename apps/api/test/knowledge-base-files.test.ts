import { describe, expect, it } from "vitest";
import { createApiApp } from "../src/server.js";
import type { RuntimeConfig } from "../src/config.js";
import type {
  WorkerJobKind,
  WorkerJobRepository
} from "../src/db/worker-job-repository.js";
import { createRedisCoordinator } from "../src/redis/coordination.js";
import { createStorageKeyspace } from "../src/storage/keys.js";
import type { StorageAdapter, StoredObject } from "../src/storage/s3.js";
import {
  createTestRedisCoordinator,
  loginAndReadSessionCookie,
  MemoryRedisCommandClient
} from "./support/session.js";

const knowledgeBase = {
  id: "kb-001",
  name: "Developer docs",
  description: null,
  activeReleaseId: "release-001",
  createdAt: "2026-06-14T00:00:00.000Z",
  updatedAt: "2026-06-14T00:00:00.000Z"
};

function createConfig(): RuntimeConfig {
  return {
    admin: {
      username: "admin",
      password: "admin-secret",
    },
    database: {
      url: "postgres://focowiki:focowiki@127.0.0.1:5432/focowiki"
    },
    redis: {
      url: "redis://127.0.0.1:6379/0"
    },
    ports: {
      adminApi: 43_000,
      adminUi: 43_100,
      publicOpenApi: 43_200
    },
    publicApi: {
      baseUrl: "https://kb.example.com"
    },
    storage: {
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "focowiki",
      accessKeyId: "s3-access",
      secretAccessKey: "s3-secret",
      prefix: "tenant/demo",
      forcePathStyle: true
    },
    upload: {
      maxBytes: 1_048_576,
      maxFiles: 8,
      generationBatchSize: 50,
      fileProcessingConcurrency: 1,
      storageConcurrency: 4
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
    model: {
      enabled: false
    },
    corsOrigins: []
  };
}

class MemoryStorage implements StorageAdapter {
  public readonly keyspace = createStorageKeyspace("tenant/demo");
  public readonly objects = new Map<string, string>([
    [
      "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/pages/intro.md",
      "---\ntype: page\ntitle: Intro\n---\n# Intro"
    ]
  ]);

  public async putObject(object: StoredObject): Promise<void> {
    this.objects.set(
      object.key,
      typeof object.body === "string" ? object.body : new TextDecoder().decode(object.body)
    );
  }

  public async getObjectText(key: string): Promise<string | null> {
    return this.objects.get(key) ?? null;
  }

  public async writeCurrentPointer(): Promise<void> {
    throw new Error("Not used by knowledge base file tests");
  }

  public async readCurrentPointer(): Promise<null> {
    return null;
  }
}

function createRepositories() {
  const treeCalls: Array<{
    limit: number;
    cursor: string | null;
    parentPath: string;
    entryType?: string | null;
  }> = [];
  const treeSearchCalls: Array<{
    limit: number;
    cursor: string | null;
    query: string;
  }> = [];
  const sourceCalls: Array<{
    knowledgeBaseId?: string;
    limit: number;
    cursor: string | null;
    processingStatus?: string | null;
    processingStage?: string | null;
    modelInvocationStatus?: string | null;
    generatedOutputStatus?: string | null;
    fileNameQuery?: string | null;
    fileIdQuery?: string | null;
    startedFrom?: string | null;
    startedTo?: string | null;
    endedFrom?: string | null;
    endedTo?: string | null;
    errorState?: string | null;
    errorCodeQuery?: string | null;
    actionState?: string | null;
  }> = [];
  const releaseCalls: Array<{ limit: number; cursor: string | null }> = [];
  const bundleCalls: Array<{ limit: number; cursor: string | null }> = [];
  const generatedOutputCalls: Array<{
    knowledgeBaseId: string;
    releaseId: string;
    sourceFileIds: string[];
  }> = [];
  const graphSummaryCalls: Array<{ knowledgeBaseId: string; sourceFileId: string; limit: number }> = [];
  const queueSummaryCalls: Array<{
    knowledgeBaseId?: string | null;
    kinds?: WorkerJobKind[];
  }> = [];
  const dirtySourceFileCountCalls: Array<{ knowledgeBaseId: string }> = [];
  const bundleFile = {
    id: "bundle-file-001",
    knowledgeBaseId: "kb-001",
    releaseId: "release-001",
    sourceFileId: "source-001",
    fileKind: "page" as const,
    logicalPath: "pages/intro.md",
    objectKey: "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/pages/intro.md",
    contentType: "text/markdown; charset=utf-8",
    sizeBytes: 42,
    checksumSha256: "checksum",
    okfType: "page",
    title: "Intro",
    description: null,
    tags: ["docs"],
    frontmatter: {
      type: "page",
      title: "Intro"
    }
  };

  return {
    records: {
      bundleFile,
      treeCalls,
      treeSearchCalls,
      sourceCalls,
      releaseCalls,
      bundleCalls,
      generatedOutputCalls,
      graphSummaryCalls,
      queueSummaryCalls,
      dirtySourceFileCountCalls
    },
    repositories: {
      knowledgeBases: {
        async listKnowledgeBases() {
          return { items: [knowledgeBase], nextCursor: null };
        },
        async createKnowledgeBase() {
          return knowledgeBase;
        },
        async getKnowledgeBase(id: string) {
          return id === "kb-001" ? knowledgeBase : null;
        }
      },
      files: {
        async listBundleTreeEntries(request: {
          limit: number;
          cursor: string | null;
          parentPath: string;
          entryType?: string | null;
        }) {
          treeCalls.push(request);
          const entries = [
            {
              id: "tree-pages",
              knowledgeBaseId: "kb-001",
              releaseId: "release-001",
              parentPath: "",
              name: "pages",
              logicalPath: "pages",
              sortKey: "0:pages",
              entryType: "directory" as const,
              bundleFileId: null,
              sourceFileId: null,
              fileKind: null,
              childCount: 1
            },
            {
              id: "tree-index",
              knowledgeBaseId: "kb-001",
              releaseId: "release-001",
              parentPath: "",
              name: "index.md",
              logicalPath: "index.md",
              sortKey: "1:index.md",
              entryType: "file" as const,
              bundleFileId: "bundle-file-index",
              sourceFileId: null,
              fileKind: "index" as const,
              childCount: 0
            }
          ];
          const start = request.cursor ? Number(request.cursor) : 0;

          return {
            items: entries.slice(start, start + request.limit),
            nextCursor: start + request.limit < entries.length ? String(start + request.limit) : null
          };
        },
        async searchBundleTreeEntries(request: {
          limit: number;
          cursor: string | null;
          query: string;
        }) {
          treeSearchCalls.push(request);
          const pagesEntry = {
            id: "tree-pages",
            knowledgeBaseId: "kb-001",
            releaseId: "release-001",
            parentPath: "",
            name: "pages",
            logicalPath: "pages",
            sortKey: "0:pages",
            entryType: "directory" as const,
            bundleFileId: null,
            sourceFileId: null,
            fileKind: null,
            childCount: 1
          };
          const introEntry = {
            id: "tree-intro",
            knowledgeBaseId: "kb-001",
            releaseId: "release-001",
            parentPath: "pages",
            name: "intro.md",
            logicalPath: "pages/intro.md",
            sortKey: "1:intro.md",
            entryType: "file" as const,
            bundleFileId: "bundle-file-001",
            sourceFileId: "source-001",
            fileKind: "page" as const,
            childCount: 0
          };
          const matches = request.query.toLocaleLowerCase("en-US").includes("intro")
            ? [
                {
                  entry: introEntry,
                  ancestors: [pagesEntry]
                }
              ]
            : request.query.toLocaleLowerCase("en-US").includes("pages")
              ? [
                  {
                    entry: pagesEntry,
                    ancestors: []
                  }
                ]
              : [];

          return {
            items: matches,
            nextCursor: null
          };
        },
        async getBundleFile(input: { knowledgeBaseId: string; releaseId: string; logicalPath: string }) {
          return input.knowledgeBaseId === "kb-001" &&
            input.releaseId === "release-001" &&
            input.logicalPath === "pages/intro.md"
            ? bundleFile
            : null;
        },
        async listGeneratedOutputsForSourceFiles(input: {
          knowledgeBaseId: string;
          releaseId: string;
          sourceFileIds: string[];
        }) {
          generatedOutputCalls.push(input);
          return input.knowledgeBaseId === "kb-001" &&
            input.releaseId === "release-001" &&
            input.sourceFileIds.includes("source-001")
            ? [
                {
                  sourceFileId: "source-001",
                  bundleFileId: bundleFile.id,
                  logicalPath: bundleFile.logicalPath
                }
              ]
            : [];
        },
        async listSourceFiles(request: {
          knowledgeBaseId?: string;
          limit: number;
          cursor: string | null;
          processingStatus?: string | null;
          processingStage?: string | null;
          modelInvocationStatus?: string | null;
          generatedOutputStatus?: string | null;
          fileNameQuery?: string | null;
          fileIdQuery?: string | null;
          startedFrom?: string | null;
          startedTo?: string | null;
          endedFrom?: string | null;
          endedTo?: string | null;
          errorState?: string | null;
          errorCodeQuery?: string | null;
          actionState?: string | null;
        }) {
          sourceCalls.push(request);
          return {
            items: [
              {
                id: "source-001",
                knowledgeBaseId: "kb-001",
                originalName: "intro.md",
                objectKey: "tenant/demo/source/intro.md",
                contentType: "text/markdown; charset=utf-8",
                sizeBytes: 42,
                checksumSha256: "checksum",
                metadata: { type: "page", title: "Intro" },
                generatedOutputStatus: "visible" as const,
                generatedBundleFileId: "stale-bundle-file-001",
                generatedBundleFilePath: "pages/intro.md",
                createdAt: "2026-06-14T00:00:00.000Z",
                deletedAt: null
              }
            ].slice(request.cursor ? Number(request.cursor) : 0, (request.cursor ? Number(request.cursor) : 0) + request.limit),
            nextCursor: null
          };
        },
        async countDirtySourceFiles(input: { knowledgeBaseId: string }) {
          dirtySourceFileCountCalls.push(input);
          return {
            count: 2,
            oldestDirtyAt: "2026-06-14T00:00:00.000Z"
          };
        },
        async listReleases(request: { limit: number; cursor: string | null }) {
          releaseCalls.push(request);
          return {
            items: [
              {
                id: "release-001",
                knowledgeBaseId: "kb-001",
                bundleRootKey: "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/",
                generatedAt: "2026-06-14T00:00:00.000Z",
                publishedAt: "2026-06-14T00:00:00.000Z",
                fileCount: 7,
                manifestChecksumSha256: "checksum",
                createdAt: "2026-06-14T00:00:00.000Z"
              }
            ].slice(request.cursor ? Number(request.cursor) : 0, (request.cursor ? Number(request.cursor) : 0) + request.limit),
            nextCursor: null
          };
        },
        async listBundleFiles(request: { limit: number; cursor: string | null }) {
          bundleCalls.push(request);
          return {
            items: [bundleFile].slice(request.cursor ? Number(request.cursor) : 0, (request.cursor ? Number(request.cursor) : 0) + request.limit),
            nextCursor: null
          };
        }
      },
      graph: {
        async upsertGraphNode() {
          return undefined;
        },
        async upsertGraphEdges() {
          return undefined;
        },
        async listGraphNodes() {
          return { items: [], nextCursor: null };
        },
        async listGraphEdges() {
          return { items: [], nextCursor: null };
        },
        async listGraphNeighborhood() {
          return { items: [], nextCursor: null };
        },
        async getGraphSummary(input: { knowledgeBaseId: string; sourceFileId: string; limit: number }) {
          graphSummaryCalls.push(input);
          return {
            sourceFileId: input.sourceFileId,
            relationshipCount: 1,
            relationships: [
              {
                fileId: "source-related",
                sourceFileId: "source-related",
                bundleFileId: "bundle-related",
                path: "pages/related.md",
                title: "Related",
                relationType: "shared_tag",
                direction: "outgoing" as const,
                weight: 0.8,
                reason: "Both files share tags.",
                source: "deterministic",
                contentAvailable: true
              }
            ]
          };
        },
        async deleteGraphForSourceFile() {
          return undefined;
        }
      },
      workerJobs: {
        async enqueueWorkerJob() {
          throw new Error("Not used by knowledge base file tests");
        },
        async enqueueSourceFileJob() {
          throw new Error("Not used by knowledge base file tests");
        },
        async enqueuePublicationJob() {
          throw new Error("Not used by knowledge base file tests");
        },
        async claimWorkerJobs() {
          return [];
        },
        async releaseWorkerJob() {
          return null;
        },
        async completeWorkerJob() {
          return null;
        },
        async failWorkerJob() {
          return null;
        },
        async deadLetterWorkerJob() {
          return null;
        },
        async heartbeatWorkerJob() {
          return null;
        },
        async recordWorkerHeartbeat(
          input: Parameters<WorkerJobRepository["recordWorkerHeartbeat"]>[0]
        ) {
          return {
            workerId: input.workerId,
            lastSeenAt: input.lastSeenAt,
            activeJobCount: input.activeJobCount,
            metadata: input.metadata ?? {},
            createdAt: input.lastSeenAt,
            updatedAt: input.lastSeenAt
          };
        },
        async listWorkerHeartbeats() {
          return [];
        },
        async getWorkerQueueSummary(
          input: Parameters<WorkerJobRepository["getWorkerQueueSummary"]>[0]
        ) {
          queueSummaryCalls.push(input);
          return input.kinds?.includes("publication")
            ? {
                queuedCount: 1,
                runningCount: 0,
                completedCount: 0,
                failedCount: 0,
                deadLetterCount: 0,
                oldestQueuedAt: "2026-06-14T00:00:00.000Z",
                oldestQueuedAgeSeconds: 30
              }
            : {
                queuedCount: 3,
                runningCount: 2,
                completedCount: 0,
                failedCount: 1,
                deadLetterCount: 0,
                oldestQueuedAt: "2026-06-14T00:00:00.000Z",
                oldestQueuedAgeSeconds: 45
              };
        },
        async cleanupWorkerJobs() {
          return 0;
        },
        async countActiveWorkerJobs() {
          return 0;
        }
      }
    }
  };
}

async function createAuthenticatedFileApp() {
  const { repositories, records } = createRepositories();
  const app = createApiApp({
    config: createConfig(),
    storage: new MemoryStorage(),
    redis: createTestRedisCoordinator(),
    repositories
  });
  const cookie = await loginAndReadSessionCookie(app);
  return { app, cookie, records };
}

describe("Knowledge base file Admin API", () => {
  it("returns a knowledge base scoped generated file tree page", async () => {
    const { app, cookie } = await createAuthenticatedFileApp();
    const response = await app.request("/admin/api/knowledge-bases/kb-001/files/tree", {
      headers: {
        cookie
      }
    });

    await expect(response.json()).resolves.toEqual({
      items: [
        {
          id: "tree-pages",
          parentPath: "",
          name: "pages",
          logicalPath: "pages",
          sortKey: "0:pages",
          entryType: "directory",
          bundleFileId: null,
          sourceFileId: null,
          fileKind: null,
          childCount: 1,
          deletable: false
        },
        {
          id: "tree-index",
          parentPath: "",
          name: "index.md",
          logicalPath: "index.md",
          sortKey: "1:index.md",
          entryType: "file",
          bundleFileId: "bundle-file-index",
          sourceFileId: null,
          fileKind: "index",
          childCount: 0,
          deletable: false
        }
      ],
      nextCursor: null
    });
    expect(response.status).toBe(200);
  });

  it("returns generated file detail by resolving DB metadata and reading S3 body", async () => {
    const { app, cookie, records } = await createAuthenticatedFileApp();
    const response = await app.request(
      "/admin/api/knowledge-bases/kb-001/files/detail?path=pages/intro.md",
      {
        headers: {
          cookie
        }
      }
    );
    const body = (await response.json()) as {
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
    expect(records.bundleFile).not.toHaveProperty("content");
  });

  it("returns not found when the knowledge base or file record is missing", async () => {
    const { app, cookie } = await createAuthenticatedFileApp();
    const missingKnowledgeBase = await app.request(
      "/admin/api/knowledge-bases/kb-missing/files/tree",
      {
        headers: {
          cookie
        }
      }
    );
    const missingFile = await app.request(
      "/admin/api/knowledge-bases/kb-001/files/detail?path=pages/missing.md",
      {
        headers: {
          cookie
        }
      }
    );

    expect(missingKnowledgeBase.status).toBe(404);
    expect(missingFile.status).toBe(404);
  });

  it("paginates file tree directories with Redis cursor and page cache state", async () => {
    const { repositories, records } = createRepositories();
    const redisClient = new MemoryRedisCommandClient();
    const app = createApiApp({
      config: createConfig(),
      storage: new MemoryStorage(),
      redis: createRedisCoordinator(redisClient, { keyPrefix: "focowiki-test" }),
      repositories
    });
    const cookie = await loginAndReadSessionCookie(app);
    const first = await app.request("/admin/api/knowledge-bases/kb-001/files/tree?limit=1", {
      headers: {
        cookie
      }
    });
    const firstBody = (await first.json()) as { nextCursor: string | null };

    expect(first.status).toBe(200);
    expect(firstBody.nextCursor).toEqual(expect.stringMatching(/^cursor-/));
    expect(
      Array.from(redisClient.values.keys()).some((key) =>
        key.startsWith("focowiki-test:pagination-cursors:file-tree:kb-001:release-001:")
      )
    ).toBe(true);

    const second = await app.request(
      `/admin/api/knowledge-bases/kb-001/files/tree?limit=1&cursor=${firstBody.nextCursor}`,
      {
        headers: {
          cookie
        }
      }
    );

    expect(second.status).toBe(200);
    expect(records.treeCalls).toEqual([
      expect.objectContaining({ limit: 1, cursor: null, parentPath: "" }),
      expect.objectContaining({ limit: 1, cursor: "1", parentPath: "" })
    ]);
  });

  it("passes file tree entry type filters to the repository", async () => {
    const { app, cookie, records } = await createAuthenticatedFileApp();
    const response = await app.request(
      "/admin/api/knowledge-bases/kb-001/files/tree?entryType=directory&limit=1",
      {
        headers: {
          cookie
        }
      }
    );

    expect(response.status).toBe(200);
    expect(records.treeCalls).toEqual([
      expect.objectContaining({
        limit: 1,
        cursor: null,
        parentPath: "",
        entryType: "directory"
      })
    ]);
  });

  it("returns file tree search matches with ancestors", async () => {
    const { app, cookie, records } = await createAuthenticatedFileApp();
    const response = await app.request(
      "/admin/api/knowledge-bases/kb-001/files/tree/search?query=intro",
      {
        headers: {
          cookie
        }
      }
    );

    await expect(response.json()).resolves.toEqual({
      items: [
        {
          entry: {
            id: "tree-intro",
            parentPath: "pages",
            name: "intro.md",
            logicalPath: "pages/intro.md",
            sortKey: "1:intro.md",
            entryType: "file",
            bundleFileId: "bundle-file-001",
            sourceFileId: "source-001",
            fileKind: "page",
            childCount: 0,
            deletable: true
          },
          ancestors: [
            {
              id: "tree-pages",
              parentPath: "",
              name: "pages",
              logicalPath: "pages",
              sortKey: "0:pages",
              entryType: "directory",
              bundleFileId: null,
              sourceFileId: null,
              fileKind: null,
              childCount: 1,
              deletable: false
            }
          ]
        }
      ],
      nextCursor: null
    });
    expect(response.status).toBe(200);
    expect(records.treeSearchCalls).toEqual([
      expect.objectContaining({ limit: 100, cursor: null, query: "intro" })
    ]);
  });

  it("caches repeated file tree search pages in Redis", async () => {
    const { repositories, records } = createRepositories();
    const redisClient = new MemoryRedisCommandClient();
    const app = createApiApp({
      config: createConfig(),
      storage: new MemoryStorage(),
      redis: createRedisCoordinator(redisClient, { keyPrefix: "focowiki-test" }),
      repositories
    });
    const cookie = await loginAndReadSessionCookie(app);
    const path = "/admin/api/knowledge-bases/kb-001/files/tree/search?query=missing";
    const first = await app.request(path, {
      headers: {
        cookie
      }
    });
    const second = await app.request(path, {
      headers: {
        cookie
      }
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ items: [], nextCursor: null });
    await expect(second.json()).resolves.toEqual({ items: [], nextCursor: null });
    expect(records.treeSearchCalls).toHaveLength(1);
    expect(
      Array.from(redisClient.values.keys()).some((key) =>
        key.startsWith("focowiki-test:page-cache:file-tree-search:kb-001:release-001:")
      )
    ).toBe(true);
  });

  it("rejects invalid file tree search before reading the repository", async () => {
    const { app, cookie, records } = await createAuthenticatedFileApp();
    const response = await app.request(
      "/admin/api/knowledge-bases/kb-001/files/tree/search?query=a",
      {
        headers: {
          cookie
        }
      }
    );

    await expect(response.json()).resolves.toEqual({
      error: {
        code: "FILE_TREE_SEARCH_QUERY_TOO_SHORT"
      }
    });
    expect(response.status).toBe(400);
    expect(records.treeSearchCalls).toEqual([]);
  });

  it("returns source file, release, and bundle file lists without storage keys", async () => {
    const { app, cookie, records } = await createAuthenticatedFileApp();
    const sourceFiles = await app.request("/admin/api/knowledge-bases/kb-001/source-files?limit=1", {
      headers: {
        cookie
      }
    });
    const releases = await app.request("/admin/api/knowledge-bases/kb-001/releases?limit=1", {
      headers: {
        cookie
      }
    });
    const bundleFiles = await app.request("/admin/api/knowledge-bases/kb-001/bundle-files?limit=1", {
      headers: {
        cookie
      }
    });
    const releaseBody = (await releases.json()) as { items: Array<Record<string, unknown>> };
    const bundleBody = (await bundleFiles.json()) as { items: Array<Record<string, unknown>> };
    const sourceBody = (await sourceFiles.json()) as {
      items: Array<Record<string, unknown>>;
      refreshAfterMs: number;
    };

    expect(sourceFiles.status).toBe(200);
    expect(releases.status).toBe(200);
    expect(bundleFiles.status).toBe(200);
    expect(sourceBody.items[0]).not.toHaveProperty("objectKey");
    expect(sourceBody.refreshAfterMs).toBe(30_000);
    expect(sourceBody.items[0]).toMatchObject({
      generatedFileAvailable: true,
      generatedFileId: "bundle-file-001",
      generatedFilePath: "pages/intro.md"
    });
    expect(sourceBody.items[0]).not.toHaveProperty("releaseId");
    expect(sourceBody.items[0]).not.toHaveProperty("bundleRootKey");
    expect(sourceBody.items[0]?.graphSummary).toBeNull();
    expect(releaseBody.items[0]).not.toHaveProperty("bundleRootKey");
    expect(bundleBody.items[0]).not.toHaveProperty("objectKey");
    expect(records.sourceCalls).toEqual([expect.objectContaining({ limit: 1, cursor: null })]);
    expect(records.generatedOutputCalls).toEqual([
      {
        knowledgeBaseId: "kb-001",
        releaseId: "release-001",
        sourceFileIds: ["source-001"]
      }
    ]);
    expect(records.graphSummaryCalls).toEqual([]);
    expect(records.releaseCalls).toEqual([expect.objectContaining({ limit: 1, cursor: null })]);
    expect(records.bundleCalls).toEqual([expect.objectContaining({ limit: 1, cursor: null })]);
  });

  it("passes source file lifecycle filters to the repository", async () => {
    const { app, cookie, records } = await createAuthenticatedFileApp();
    const response = await app.request(
      "/admin/api/knowledge-bases/kb-001/source-files?limit=1&processingStatus=failed&processingStage=llm_suggestion&generatedOutputStatus=unavailable&errorState=with_error",
      {
        headers: {
          cookie
        }
      }
    );

    expect(response.status).toBe(200);
    expect(records.sourceCalls).toEqual([
      expect.objectContaining({
        knowledgeBaseId: "kb-001",
        limit: 1,
        cursor: null,
        processingStatus: "failed",
        processingStage: "llm_suggestion",
        generatedOutputStatus: "unavailable",
        errorState: "with_error"
      })
    ]);
  });

  it("passes source file column filters to the repository with normalized timestamps", async () => {
    const { app, cookie, records } = await createAuthenticatedFileApp();
    const response = await app.request(
      "/admin/api/knowledge-bases/kb-001/source-files?limit=1&fileNameQuery=intro&fileIdQuery=source-file-001&processingStatus=completed&processingStage=release_activation&modelInvocationStatus=not_recorded&generatedOutputStatus=visible&startedFrom=2026-06-14T00%3A00%3A00.000Z&startedTo=2026-06-15T00%3A00%3A00.000Z&endedFrom=2026-06-14T00%3A00%3A00.000Z&endedTo=2026-06-15T00%3A00%3A00.000Z&errorState=without_error&errorCodeQuery=TIMEOUT&actionState=openable",
      {
        headers: {
          cookie
        }
      }
    );

    expect(response.status).toBe(200);
    expect(records.sourceCalls).toEqual([
      expect.objectContaining({
        knowledgeBaseId: "kb-001",
        limit: 1,
        cursor: null,
        fileNameQuery: "intro",
        fileIdQuery: "source-file-001",
        processingStatus: "completed",
        processingStage: "release_activation",
        modelInvocationStatus: "not_recorded",
        generatedOutputStatus: "visible",
        startedFrom: "2026-06-14T00:00:00.000Z",
        startedTo: "2026-06-15T00:00:00.000Z",
        endedFrom: "2026-06-14T00:00:00.000Z",
        endedTo: "2026-06-15T00:00:00.000Z",
        errorState: "without_error",
        errorCodeQuery: "TIMEOUT",
        actionState: "openable"
      })
    ]);
  });

  it("rejects invalid source file lifecycle filters before reading the repository", async () => {
    const { app, cookie, records } = await createAuthenticatedFileApp();
    const response = await app.request(
      "/admin/api/knowledge-bases/kb-001/source-files?processingStatus=archived",
      {
        headers: {
          cookie
        }
      }
    );

    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_SOURCE_FILE_FILTER"
      }
    });
    expect(response.status).toBe(400);
    expect(records.sourceCalls).toEqual([]);
  });

  it("rejects invalid source file text and time filters before reading the repository", async () => {
    const { app, cookie, records } = await createAuthenticatedFileApp();
    const shortText = await app.request(
      "/admin/api/knowledge-bases/kb-001/source-files?errorCodeQuery=a",
      {
        headers: {
          cookie
        }
      }
    );
    const invertedTime = await app.request(
      "/admin/api/knowledge-bases/kb-001/source-files?startedFrom=2026-06-15T00%3A00%3A00.000Z&startedTo=2026-06-14T00%3A00%3A00.000Z",
      {
        headers: {
          cookie
        }
      }
    );

    await expect(shortText.json()).resolves.toEqual({
      error: {
        code: "SOURCE_FILE_FILTER_TEXT_TOO_SHORT"
      }
    });
    await expect(invertedTime.json()).resolves.toEqual({
      error: {
        code: "SOURCE_FILE_FILTER_TIME_RANGE_INVALID"
      }
    });
    expect(shortText.status).toBe(400);
    expect(invertedTime.status).toBe(400);
    expect(records.sourceCalls).toEqual([]);
  });

  it("returns bounded processing summary from durable queue and dirty publication state", async () => {
    const { app, cookie, records } = await createAuthenticatedFileApp();
    const response = await app.request("/admin/api/knowledge-bases/kb-001/processing-summary", {
      headers: {
        cookie
      }
    });

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
      dirtySourceFiles: {
        count: 2,
        oldestDirtyAt: "2026-06-14T00:00:00.000Z"
      }
    });
    expect(response.status).toBe(200);
    expect(records.queueSummaryCalls).toEqual([
      expect.objectContaining({ knowledgeBaseId: "kb-001", kinds: ["source_file_processing"] }),
      expect.objectContaining({ knowledgeBaseId: "kb-001", kinds: ["publication"] })
    ]);
    expect(records.dirtySourceFileCountCalls).toEqual([{ knowledgeBaseId: "kb-001" }]);
  });

  it("keeps high Admin read traffic from enqueueing worker jobs", async () => {
    const { app, cookie, records } = await createAuthenticatedFileApp();
    const requests = Array.from({ length: 3 }, () => [
      app.request("/admin/api/knowledge-bases/kb-001/source-files?limit=1", {
        headers: { cookie }
      }),
      app.request("/admin/api/knowledge-bases/kb-001/files/tree?limit=1", {
        headers: { cookie }
      }),
      app.request("/admin/api/knowledge-bases/kb-001/files/detail?path=pages/intro.md", {
        headers: { cookie }
      })
    ]).flat();

    const responses = await Promise.all(requests);

    expect(responses.map((response) => response.status)).toEqual(Array(requests.length).fill(200));
    expect(records.sourceCalls.length).toBeGreaterThanOrEqual(1);
    expect(records.treeCalls.length).toBeGreaterThanOrEqual(1);
    expect(records.graphSummaryCalls).toEqual([]);
  });

  it("returns knowledge base public URLs without storage details", async () => {
    const { app, cookie } = await createAuthenticatedFileApp();
    const response = await app.request("/admin/api/knowledge-bases/kb-001/public-urls", {
      headers: {
        cookie
      }
    });

    await expect(response.json()).resolves.toEqual({
      publicUrls: {
        index:
          "https://kb.example.com/openapi/v1/knowledge-bases/kb-001/files/content?path=index.md",
        search:
          "https://kb.example.com/openapi/v1/knowledge-bases/kb-001/files/content?path=_index%2Fsearch.json",
        links:
          "https://kb.example.com/openapi/v1/knowledge-bases/kb-001/files/content?path=_index%2Flinks.json"
      }
    });
    expect(response.status).toBe(200);
  });
});
