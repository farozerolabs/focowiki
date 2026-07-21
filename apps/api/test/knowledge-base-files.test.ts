import { describe, expect, it } from "vitest";
import { createApiApp } from "../src/server.js";
import type { RuntimeConfig } from "../src/config.js";
import type { AdminRepositories } from "../src/db/admin-repositories.js";
import type {
  ActiveGenerationFile,
  ActiveGenerationProjection,
  ActiveGenerationReadRepository
} from "../src/application/ports/active-generation-read-repository.js";
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
  activeGenerationId: "generation-001",
  catalogGeneration: 0,
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
      "tenant/demo/knowledge-bases/kb-001/generated/objects/v1/checksum",
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
    state?: string | null;
    currentStage?: string | null;
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
  const generatedOutputCalls: Array<{
    sourceFileIds: string[];
  }> = [];
  const graphSummaryCalls: Array<{ knowledgeBaseId: string; sourceFileId: string; limit: number }> = [];
  const queueSummaryCalls: Array<{ knowledgeBaseId: string; role: string }> = [];
  const dispatchSummaryCalls: Array<{ knowledgeBaseId: string }> = [];
  const publicationProgressCalls: Array<{ knowledgeBaseId: string }> = [];
  const maintenanceProgressCalls: Array<{ knowledgeBaseId: string }> = [];
  const generatedFile = {
    id: "bundle-file-001",
    knowledgeBaseId: "kb-001",
    sourceFileId: "source-001",
    fileKind: "page" as const,
    logicalPath: "pages/intro.md",
    objectKey: "tenant/demo/knowledge-bases/kb-001/generated/objects/v1/checksum",
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
      generatedFile,
      treeCalls,
      treeSearchCalls,
      sourceCalls,
      generatedOutputCalls,
      graphSummaryCalls,
      queueSummaryCalls,
      dispatchSummaryCalls,
      publicationProgressCalls,
      maintenanceProgressCalls
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
        async listSourceFiles(request: {
          knowledgeBaseId?: string;
          limit: number;
          cursor: string | null;
          state?: string | null;
          currentStage?: string | null;
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
                sourceRevisionId: "source-revision-001",
                name: "intro.md",
                relativePath: "intro.md",
                objectKey: "tenant/demo/source/intro.md",
                contentType: "text/markdown; charset=utf-8",
                sizeBytes: 42,
                checksumSha256: "checksum",
                metadata: { type: "page", title: "Intro" },
                generatedOutputStatus: "visible" as const,
                createdAt: "2026-06-14T00:00:00.000Z",
                deletedAt: null
              }
            ].slice(request.cursor ? Number(request.cursor) : 0, (request.cursor ? Number(request.cursor) : 0) + request.limit),
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
                generatedFileId: "bundle-related",
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
      }
    } as unknown as AdminRepositories,
    activeGenerationReads: createActiveGenerationReads({
      generatedFile,
      generatedOutputCalls,
      treeCalls,
      treeSearchCalls
    }),
    roleJobs: {
      async getQueueSummary(input: { knowledgeBaseId: string; role: string }) {
        queueSummaryCalls.push(input);
        return input.role === "publication"
          ? queueSummary(1, 0, 0, 30)
          : queueSummary(3, 2, 1, 45);
      }
    },
    sourceDispatch: {
      async getSummary(input: { knowledgeBaseId: string }) {
        dispatchSummaryCalls.push(input);
        return {
          pendingCount: 2,
          oldestPendingAt: "2026-06-14T00:00:00.000Z",
          paused: false,
          pausedReason: null
        };
      }
    },
    publicationGenerations: {
      async getProgressSummary(input: { knowledgeBaseId: string }) {
        publicationProgressCalls.push(input);
        return {
          generationId: "generation-001",
          stage: "building",
          processedImpactCount: 3,
          totalImpactCount: 5,
          touchedShardCount: 2,
          throughputPerMinute: 90,
          oldestDirtyAt: "2026-06-14T00:00:00.000Z",
          queuedAt: "2026-06-14T00:00:00.000Z",
          startedAt: "2026-06-14T00:00:01.000Z",
          heartbeatAt: "2026-06-14T00:00:02.000Z",
          completedAt: null,
          lastSuccessAt: null,
          safeErrorCode: null,
          safeErrorMessage: null
        };
      }
    },
    maintenanceProgress: {
      async getSummary(input: { knowledgeBaseId: string }) {
        maintenanceProgressCalls.push(input);
        return {
          migration: {
            state: "backfilling",
            phase: "projection_segments",
            attemptCount: 1,
            maxAttempts: 5,
            startedAt: "2026-06-14T00:00:00.000Z",
            updatedAt: "2026-06-14T00:00:02.000Z",
            completedAt: null,
            safeErrorCode: null,
            safeErrorMessage: null
          },
          compaction: {
            active: {
              state: "running",
              attemptCount: 1,
              maxAttempts: 5,
              queuedAt: "2026-06-14T00:00:01.000Z",
              updatedAt: "2026-06-14T00:00:02.000Z",
              completedAt: null,
              safeErrorCode: null
            },
            latestCompleted: null
          }
        };
      }
    }
  };
}

function queueSummary(
  queuedCount: number,
  runningCount: number,
  failedCount: number,
  oldestQueuedAgeSeconds: number
) {
  return {
    queuedCount,
    runningCount,
    completedCount: 0,
    failedCount,
    deadLetterCount: 0,
    oldestQueuedAt: "2026-06-14T00:00:00.000Z",
    oldestQueuedAgeSeconds
  };
}

function createActiveGenerationReads(input: {
  generatedFile: {
    id: string;
    sourceFileId: string;
    logicalPath: string;
    objectKey: string;
    contentType: string;
    sizeBytes: number;
    checksumSha256: string;
    title: string;
    description: string | null;
    tags: string[];
    frontmatter: Record<string, unknown>;
  };
  generatedOutputCalls: Array<{ sourceFileIds: string[] }>;
  treeCalls: Array<{
    limit: number;
    cursor: string | null;
    parentPath: string;
    entryType?: string | null;
  }>;
  treeSearchCalls: Array<{ limit: number; cursor: string | null; query: string }>;
}): ActiveGenerationReadRepository {
  const pages = treeProjection({
    recordId: "tree-pages",
    path: "pages",
    parentPath: "",
    sortKey: "0:pages",
    title: "pages",
    payload: {
      kind: "directory",
      name: "pages",
      directEntryCount: 1,
      directDirectoryCount: 0,
      directFileCount: 1,
      descendantFileCount: 1
    }
  });
  const index = treeProjection({
    recordId: "tree-index",
    path: "index.md",
    parentPath: "",
    sortKey: "1:index.md",
    title: "index.md",
    payload: { kind: "file", name: "index.md", fileId: "bundle-file-index" }
  });
  const intro = treeProjection({
    recordId: "tree-intro",
    sourceFileId: "source-001",
    path: "pages/intro.md",
    parentPath: "pages",
    sortKey: "1:intro.md",
    title: "Intro",
    payload: { kind: "file", name: "intro.md", fileId: input.generatedFile.id }
  });
  const activeFile: ActiveGenerationFile = {
    generationId: "generation-001",
    fileId: input.generatedFile.id,
    refKind: "page",
    refKey: input.generatedFile.sourceFileId,
    lastChangedGenerationId: "generation-001",
    path: input.generatedFile.logicalPath,
    sourceFileId: input.generatedFile.sourceFileId,
    objectKey: input.generatedFile.objectKey,
    contentType: input.generatedFile.contentType,
    sizeBytes: input.generatedFile.sizeBytes,
    checksumSha256: input.generatedFile.checksumSha256,
    title: input.generatedFile.title,
    summary: input.generatedFile.description,
    payload: {
      type: "page",
      tags: input.generatedFile.tags,
      metadata: {
        type: "page",
        title: input.generatedFile.title ?? "Intro"
      }
    }
  };
  return {
    async withActiveGeneration(knowledgeBaseId, reader) {
      if (knowledgeBaseId !== "kb-001") return null;
      return reader({
        knowledgeBaseId,
        generationId: "generation-001",
        async findFileById(fileId) {
          return fileId === activeFile.fileId ? activeFile : null;
        },
        async findFileByPath(path) {
          return path === activeFile.path ? activeFile : null;
        },
        async findFilesBySourceIds(sourceFileIds) {
          input.generatedOutputCalls.push({ sourceFileIds });
          return sourceFileIds.includes(activeFile.sourceFileId!) ? [activeFile] : [];
        },
        async findProjection() {
          return null;
        },
        async getGraphSummary() {
          return { nodeCount: 0, edgeCount: 0, graphIndexAvailable: false, persisted: true };
        },
        async listTree(request) {
          const cursor = request.cursor ? "1" : null;
          if (request.query) {
            input.treeSearchCalls.push({
              limit: request.limit,
              cursor,
              query: request.query
            });
          } else {
            input.treeCalls.push({
              limit: request.limit,
              cursor,
              parentPath: request.parentPath,
              entryType: request.entryType
            });
          }
          const entries = request.query
            ? request.query.toLocaleLowerCase("en-US").includes("intro") ? [intro] : []
            : [pages, index].filter((entry) => {
                if (!request.entryType) return true;
                return request.entryType === "directory"
                  ? readProjectionKind(entry) === "directory"
                  : readProjectionKind(entry) === "file";
              });
          const start = request.cursor ? 1 : 0;
          const items = entries.slice(start, start + request.limit);
          return {
            items,
            nextCursor: start + request.limit < entries.length
              ? { sortKey: items.at(-1)!.sortKey, recordId: items.at(-1)!.recordId }
              : null
          };
        },
        async listTreeAncestors(paths) {
          return new Map(paths.map((path) => [path, path === intro.path ? [pages] : []]));
        },
        async search() {
          return { items: [], nextCursor: null };
        },
        async listRelated() {
          return { items: [], nextCursor: null };
        },
        async listRelatedForSources(input) {
          return new Map(input.sourceFileIds.map((sourceFileId) => [sourceFileId, []]));
        }
      });
    }
  };
}

function readProjectionKind(entry: ActiveGenerationProjection): string | null {
  const payload = entry.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload instanceof Date) {
    return null;
  }
  const kind = (payload as { readonly [key: string]: unknown }).kind;
  return typeof kind === "string" ? kind : null;
}

function treeProjection(
  input: Partial<ActiveGenerationProjection> & Pick<ActiveGenerationProjection, "recordId">
): ActiveGenerationProjection {
  return {
    generationId: "generation-001",
    projectionKind: "tree",
    recordId: input.recordId,
    sourceFileId: input.sourceFileId ?? null,
    relatedSourceFileId: null,
    path: input.path ?? null,
    parentPath: input.parentPath ?? null,
    sortKey: input.sortKey ?? input.recordId,
    title: input.title ?? null,
    summary: null,
    score: null,
    payload: input.payload ?? {}
  };
}

function createFileTestApp(
  fixture: ReturnType<typeof createRepositories>,
  redis = createTestRedisCoordinator()
) {
  return createApiApp({
    config: createConfig(),
    storage: new MemoryStorage(),
    redis,
    repositories: fixture.repositories,
    activeGenerationReads: fixture.activeGenerationReads,
    roleJobs: fixture.roleJobs as never,
    sourceDispatch: fixture.sourceDispatch as never,
    publicationGenerations: fixture.publicationGenerations as never,
    maintenanceProgress: fixture.maintenanceProgress as never
  });
}

async function createAuthenticatedFileApp() {
  const fixture = createRepositories();
  const app = createFileTestApp(fixture);
  const cookie = await loginAndReadSessionCookie(app);
  return { app, cookie, records: fixture.records, repositories: fixture.repositories };
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
        },
        {
          id: "tree-index",
          parentPath: "",
          name: "index.md",
          logicalPath: "index.md",
          sortKey: "1:index.md",
          entryType: "file",
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
    expect(body.file).not.toHaveProperty("checksumSha256");
    expect(records.generatedFile).not.toHaveProperty("content");
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
    const fixture = createRepositories();
    const { records } = fixture;
    const redisClient = new MemoryRedisCommandClient();
    const app = createFileTestApp(
      fixture,
      createRedisCoordinator(redisClient, { keyPrefix: "focowiki-test" })
    );
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
        key.startsWith("focowiki-test:pagination-cursors:file-tree:kb-001:active:root:")
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
            generatedFileId: "bundle-file-001",
            sourceFileId: "source-001",
            fileKind: "page",
            directEntryCount: 0,
            directDirectoryCount: 0,
            directFileCount: 0,
            descendantFileCount: 0,
            resourceRevision: null,
            sourceDirectoryId: null,
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
    const fixture = createRepositories();
    const { records } = fixture;
    const redisClient = new MemoryRedisCommandClient();
    const app = createFileTestApp(
      fixture,
      createRedisCoordinator(redisClient, { keyPrefix: "focowiki-test" })
    );
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
        key.startsWith("focowiki-test:page-cache:active-read:admin:tree-search:kb-001:generation-001:")
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

  it("returns source file lists with active generation outputs and without storage keys", async () => {
    const { app, cookie, records } = await createAuthenticatedFileApp();
    const sourceFiles = await app.request("/admin/api/knowledge-bases/kb-001/source-files?limit=1", {
      headers: {
        cookie
      }
    });
    const sourceBody = (await sourceFiles.json()) as {
      items: Array<Record<string, unknown>>;
      refreshAfterMs: number;
    };

    expect(sourceFiles.status).toBe(200);
    expect(sourceBody.items[0]).not.toHaveProperty("objectKey");
    expect(sourceBody.items[0]).not.toHaveProperty("checksumSha256");
    expect(sourceBody.refreshAfterMs).toBe(30_000);
    expect(sourceBody.items[0]).toMatchObject({
      generatedFileAvailable: true,
      generatedFileId: "bundle-file-001",
      generatedFilePath: "pages/intro.md"
    });
    expect(sourceBody.items[0]).not.toHaveProperty("releaseId");
    expect(sourceBody.items[0]).not.toHaveProperty("bundleRootKey");
    expect(sourceBody.items[0]?.graphSummary).toBeNull();
    expect(records.sourceCalls).toEqual([expect.objectContaining({ limit: 1, cursor: null })]);
    expect(records.generatedOutputCalls).toEqual([
      {
        sourceFileIds: ["source-001"]
      }
    ]);
    expect(records.graphSummaryCalls).toEqual([]);
  });

  it("scopes source-file list caches to the active generation and admin authorization", async () => {
    const fixture = createRepositories();
    const redisClient = new MemoryRedisCommandClient();
    const app = createFileTestApp(
      fixture,
      createRedisCoordinator(redisClient, { keyPrefix: "focowiki-test" })
    );
    const cookie = await loginAndReadSessionCookie(app);
    const path = "/admin/api/knowledge-bases/kb-001/source-files?limit=1";

    expect((await app.request(path, { headers: { cookie } })).status).toBe(200);
    expect((await app.request(path, { headers: { cookie } })).status).toBe(200);
    expect(fixture.records.sourceCalls).toHaveLength(1);
    expect(Array.from(redisClient.values.keys()).some((key) => key.startsWith(
      "focowiki-test:page-cache:active-read:admin:source-file-list:kb-001:generation-001:"
    ))).toBe(true);
  });

  it("returns publication terminal failure and authorized actions from the Admin route", async () => {
    const { app, cookie, repositories } = await createAuthenticatedFileApp();
    repositories.files!.listSourceFiles = async () => ({
      items: [
        {
          id: "source-001",
          knowledgeBaseId: "kb-001",
          sourceRevisionId: "source-revision-001",
          name: "intro.md",
          relativePath: "intro.md",
          resourceRevision: 1,
          objectKey: "tenant/demo/source/intro.md",
          contentType: "text/markdown; charset=utf-8",
          sizeBytes: 42,
          checksumSha256: "checksum",
          metadata: { type: "page", title: "Intro" },
          processingStatus: "completed",
          processingStage: "projection_generation",
          generatedOutputStatus: "unavailable",
          terminalFailure: {
            stage: "projection_generation",
            code: "GENERATION_VALIDATION_FAILED",
            message: "Generated navigation could not be validated.",
            occurredAt: "2026-07-16T14:00:00.000Z",
            retryKind: "publication",
            correlationId: "publication-job-1"
          },
          createdAt: "2026-07-16T13:59:00.000Z",
          deletedAt: null
        }
      ],
      nextCursor: null
    });
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

  it("passes source file lifecycle filters to the repository", async () => {
    const { app, cookie, records } = await createAuthenticatedFileApp();
    const response = await app.request(
      "/admin/api/knowledge-bases/kb-001/source-files?limit=1&state=failed&currentStage=llm_suggestion&generatedOutputStatus=unavailable&errorState=with_error",
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
        state: "failed",
        currentStage: "llm_suggestion",
        generatedOutputStatus: "unavailable",
        errorState: "with_error"
      })
    ]);
  });

  it("passes source file column filters to the repository with normalized timestamps", async () => {
    const { app, cookie, records } = await createAuthenticatedFileApp();
    const response = await app.request(
      "/admin/api/knowledge-bases/kb-001/source-files?limit=1&fileNameQuery=intro&fileIdQuery=source-file-001&state=visible&currentStage=generation_activation&modelInvocationStatus=not_recorded&generatedOutputStatus=visible&startedFrom=2026-06-14T00%3A00%3A00.000Z&startedTo=2026-06-15T00%3A00%3A00.000Z&endedFrom=2026-06-14T00%3A00%3A00.000Z&endedTo=2026-06-15T00%3A00%3A00.000Z&errorState=without_error&errorCodeQuery=TIMEOUT&actionState=openable",
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
      })
    ]);
  });

  it("rejects invalid source file lifecycle filters before reading the repository", async () => {
    const { app, cookie, records } = await createAuthenticatedFileApp();
    const response = await app.request(
      "/admin/api/knowledge-bases/kb-001/source-files?state=archived",
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

  it("returns bounded processing summary from role queues, dispatch, and generation progress", async () => {
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
      pendingDispatch: {
        pendingCount: 2,
        paused: false,
        pausedReason: null
      },
      publicationProgress: {
        generationId: "generation-001",
        stage: "building",
        processedImpactCount: 3,
        totalImpactCount: 5,
        touchedShardCount: 2,
        throughputPerMinute: 90
      },
      maintenanceProgress: {
        migration: {
          state: "backfilling",
          phase: "projection_segments"
        },
        compaction: {
          active: {
            state: "running"
          },
          latestCompleted: null
        }
      },
      dirtySourceFiles: {
        count: 2,
        oldestDirtyAt: "2026-06-14T00:00:00.000Z"
      }
    });
    expect(response.status).toBe(200);
    expect(records.queueSummaryCalls).toEqual([
      expect.objectContaining({ knowledgeBaseId: "kb-001", role: "source" }),
      expect.objectContaining({ knowledgeBaseId: "kb-001", role: "publication" })
    ]);
    expect(records.dispatchSummaryCalls).toEqual([{ knowledgeBaseId: "kb-001" }]);
    expect(records.publicationProgressCalls).toEqual([{ knowledgeBaseId: "kb-001" }]);
    expect(records.maintenanceProgressCalls).toEqual([{ knowledgeBaseId: "kb-001" }]);
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
