import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolveGraphConfig, type RuntimeConfig } from "../config.js";
import type {
  AdminRepositories,
  BundleFileKind,
  BundleFileRecord,
  BundleFileSearchResultRecord,
  BundleGraphSearchResultRecord,
  BundleTreeEntryRecord,
  CursorPage,
  SourceFileRecord
} from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { RuntimeSettingsService } from "../runtime-settings/service.js";
import {
  StorageObjectTooLargeError,
  type StorageAdapter
} from "../storage/s3.js";
import { createDeveloperFileSearchCursorScope } from "./file-search-signature.js";
import {
  normalizeGeneratedFileSearchQuery,
  type GeneratedFileSearchScope
} from "../search/generated-file-search-documents.js";
import {
  graphRefForSourceFile,
  normalizeGraphSearchQuery,
  type GraphSearchDepth,
  type GraphSearchMode,
  type GraphSearchSummary
} from "../search/graph-search-documents.js";
import {
  createPageResponseCacheId,
  readPageResponseCache,
  readThroughPageResponseCache,
  writePageResponseCache
} from "../page-response-cache.js";
import { createWebhookDispatcher } from "../webhooks/dispatcher.js";
import { createBundleTreeCursorScope } from "../tree-entry-filters.js";
import {
  isAllowedPublicBundleDirectoryPath,
  isAllowedPublicBundleFilePath
} from "../public-bundle-path.js";
import type { OpenAIModelClient } from "@focowiki/okf";
import {
  assertSourceFileQueueCapacity,
  enqueueSourceFileProcessingJobs,
  WorkerQueueBackpressureError
} from "../worker/source-file-jobs.js";
import {
  conflict,
  notFound,
  payloadTooLarge,
  queueBackpressure,
  repositoryUnavailable,
  validationError
} from "./errors.js";
import {
  toDeveloperBundleFile,
  toDeveloperBundleTreeSearchEntry,
  toDeveloperBundleTreeEntry,
  toDeveloperFileSearchResult,
  toDeveloperKnowledgeBase,
  toDeveloperRelatedFile,
  toDeveloperSourceFileEvent,
  toDeveloperWebhook,
  toDeveloperWebhookDelivery
} from "./serializers.js";
import type { RuntimeLogger } from "../logger.js";
import { readGeneratedContentWithMetrics } from "../application/generated-content-read.js";
import { reportGeneratedContentRead } from "../app/generated-content-read-logger.js";

export type DeveloperOpenApiServices = {
  config: RuntimeConfig;
  repositories: AdminRepositories | null;
  redis: RedisCoordinator | null;
  storage: StorageAdapter;
  modelClient: OpenAIModelClient | null;
  runtimeSettings: RuntimeSettingsService | null;
  logger?: RuntimeLogger;
};

type DeveloperFileSearchResponse = {
  query: DeveloperFileSearchQueryContext;
  items: ReturnType<typeof toDeveloperFileSearchResult>[];
  nextCursor: string | null;
  searchStatus: "ok" | "no_candidates" | "index_unavailable";
  searchMode: GraphSearchMode;
  graphStatus: "available" | "index_unavailable" | "disabled_for_file_mode";
  graphSummary: GraphSearchSummary;
  resultSummary: DeveloperFileSearchResultSummary;
  nextRequestTemplates: DeveloperFileSearchNextRequestTemplates;
  message?: string;
  nextActions?: string[];
};

type DeveloperFileSearchQueryContext = {
  query: string;
  normalizedQuery: string;
  scope: GeneratedFileSearchScope;
  fileKind: BundleFileKind | "all";
  mode: GraphSearchMode;
  graphDepth: GraphSearchDepth;
  graphFanout: number;
  limit: number;
  cursorProvided: boolean;
};

type DeveloperFileSearchResultSummary = {
  resultCount: number;
  hasMore: boolean;
  sort: string[];
  meaning: string;
};

type DeveloperFileSearchNextRequestTemplates = {
  searchAgain: string;
  listTree: string;
  readIndex: string;
  fileDetailById: string;
  fileContentById: string;
  fileContentByPath: string;
  relatedFilesById: string;
  graphExpansionByFileId: string;
  sourceFileStatusById: string;
  sourceFileEventsById: string;
};

type DeveloperGraphExpansionResponse = {
  query: {
    fileId: string | null;
    nodeId: string | null;
    edgeId: string | null;
    query: string | null;
    normalizedQuery: string | null;
    depth: GraphSearchDepth;
    fanout: number;
    limit: number;
    cursorProvided: boolean;
  };
  seedFile: ReturnType<typeof toDeveloperBundleFile> | null;
  seedResults: ReturnType<typeof toDeveloperFileSearchResult>[];
  relationships: ReturnType<typeof toDeveloperRelatedFile>[];
  graphPaths: string[];
  nextCursor: string | null;
  resultSummary: {
    seedCount: number;
    relationshipCount: number;
    hasMore: boolean;
    depth: GraphSearchDepth;
    fanout: number;
    meaning: string;
  };
  message?: string;
  nextActions?: string[];
};

type DeveloperGraphInsightsResponse = {
  file: ReturnType<typeof toDeveloperBundleFile>;
  contentPath: "_graph/insights.json";
  insights: Record<string, unknown>[];
  generatedAt: string | null;
  resultSummary: {
    insightCount: number;
    meaning: string;
  };
  readActions: {
    graphIndex: string;
    graphManifest: string;
    graphInsightsFile: string;
    graphInsightsContent: string;
  };
  nextActions: string[];
};

export function createDeveloperOpenApiService(services: DeveloperOpenApiServices) {
  const { config, repositories, redis, storage } = services;

  function requireRepositories(): AdminRepositories {
    if (!repositories) {
      throw repositoryUnavailable();
    }

    return repositories;
  }

  function requireRedis(): RedisCoordinator {
    if (!redis) {
      throw repositoryUnavailable();
    }

    return redis;
  }

  async function readGraphSettings() {
    return (await services.runtimeSettings?.getSnapshot())?.graph ?? resolveGraphConfig(config);
  }

  return {
    async createKnowledgeBase(input: { name: string; description: string | null }) {
      const repo = requireRepositories();
      const normalizedName = input.name.trim();

      if (!normalizedName) {
        throw validationError("Knowledge base name is required.", { field: "name" });
      }

      const knowledgeBase = await repo.knowledgeBases.createKnowledgeBase({
        name: normalizedName,
        description: input.description?.trim() || null
      });

      return { knowledgeBase: toDeveloperKnowledgeBase(knowledgeBase) };
    },
    async listKnowledgeBases(input: { limit: number; cursor: string | null }) {
      const repo = requireRepositories();
      const page = await repo.knowledgeBases.listKnowledgeBases({
        limit: input.limit,
        cursor: await readCursor(redis, "developer-openapi:knowledge-bases", input.cursor)
      });

      return {
        items: page.items.map(toDeveloperKnowledgeBase),
        nextCursor: await writeCursor(
          redis,
          "developer-openapi:knowledge-bases",
          page.nextCursor,
          config.pagination.cursorTtlSeconds
        )
      };
    },
    async getKnowledgeBase(knowledgeBaseId: string) {
      const knowledgeBase = await requireRepositories().knowledgeBases.getKnowledgeBase(
        knowledgeBaseId
      );

      if (!knowledgeBase) {
        throw notFound();
      }

      return { knowledgeBase: toDeveloperKnowledgeBase(knowledgeBase) };
    },
    async listSourceFileEvents(input: {
      knowledgeBaseId: string;
      sourceFileId: string;
      limit: number;
      cursor: string | null;
    }) {
      const repo = requireRepositories();

      if (!repo.files?.getSourceFile || !repo.files.listSourceFileEvents) {
        throw repositoryUnavailable();
      }

      const sourceFile = await repo.files.getSourceFile({
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFileId: input.sourceFileId
      });

      if (!sourceFile) {
        throw notFound();
      }

      const scope = `developer-openapi:source-file-events:${input.knowledgeBaseId}:${input.sourceFileId}`;
      const page = await repo.files.listSourceFileEvents({
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFileId: input.sourceFileId,
        limit: input.limit,
        cursor: await readCursor(redis, scope, input.cursor)
      });

      return pageResponse(
        page,
        scope,
        config.pagination.cursorTtlSeconds,
        redis,
        toDeveloperSourceFileEvent
      );
    },
    async retrySourceFile(input: {
      knowledgeBaseId: string;
      sourceFileId: string;
    }) {
      const repo = requireRepositories();

      if (
        !repo.files?.getSourceFile ||
        !repo.files.createSourceFileRetryAttempt ||
        !repo.workerJobs
      ) {
        throw repositoryUnavailable();
      }

      const knowledgeBase = await requireKnowledgeBase(repo, input.knowledgeBaseId);
      const sourceFile = await repo.files.getSourceFile({
        knowledgeBaseId: knowledgeBase.id,
        sourceFileId: input.sourceFileId
      });

      if (!sourceFile) {
        throw notFound();
      }

      if (sourceFile.processingStatus !== "failed") {
        throw conflict("Only failed source files can be retried.");
      }

      try {
        await assertSourceFileQueueCapacity({
          repositories: repo,
          knowledgeBaseId: knowledgeBase.id,
          config,
          worker: (await services.runtimeSettings?.getSnapshot())?.worker
        });
      } catch (error) {
        if (error instanceof WorkerQueueBackpressureError) {
          throw queueBackpressure({
            activeJobCount: error.activeJobCount,
            limit: error.limit,
            knowledgeBaseActiveJobCount: error.knowledgeBaseActiveJobCount,
            knowledgeBaseLimit: error.knowledgeBaseLimit,
            oldestQueuedAgeSeconds: error.oldestQueuedAgeSeconds,
            maxQueuedAgeSeconds: error.maxQueuedAgeSeconds,
            retryAfterSeconds: error.retryAfterSeconds
          });
        }

        throw error;
      }

      const startedAt = new Date().toISOString();
      await repo.files.createSourceFileRetryAttempt({
        knowledgeBaseId: knowledgeBase.id,
        sourceFileId: sourceFile.id,
        status: "running",
        startedAt,
        endedAt: null,
        errorCode: null
      });
      await enqueueSourceFileProcessingJobs({
        repositories: repo,
        sourceFileIds: [sourceFile.id],
        knowledgeBaseId: knowledgeBase.id,
        reason: "retry",
        config,
        worker: (await services.runtimeSettings?.getSnapshot())?.worker
      });

      return { sourceFileId: sourceFile.id };
    },
    async listTree(input: {
      knowledgeBaseId: string;
      parentPath: string;
      entryType: BundleTreeEntryRecord["entryType"] | null;
      query: string | null;
      limit: number;
      cursor: string | null;
    }) {
      const repo = requireRepositories();

      if (!repo.files?.listBundleTreeEntries) {
        throw repositoryUnavailable();
      }

      assertSafeLogicalPath(input.parentPath, true);
      const knowledgeBase = await requireKnowledgeBase(repo, input.knowledgeBaseId);

      if (!knowledgeBase.activeReleaseId) {
        return { items: [], nextCursor: null };
      }

      const searchQuery = input.query?.trim() ?? "";

      if (searchQuery) {
        if (!repo.files.searchBundleTreeEntries) {
          throw repositoryUnavailable();
        }

        const scope = createBundleTreeCursorScope({
          knowledgeBaseId: knowledgeBase.id,
          releaseId: knowledgeBase.activeReleaseId,
          parentPath: "",
          entryType: input.entryType,
          query: searchQuery,
          scopePrefix: "developer-openapi:tree-search"
        });
        const redisCoordinator = redis;
        const repositoryCursor = await readCursor(redisCoordinator, scope, input.cursor);
        const cacheId = createPageResponseCacheId({
          cursorToken: input.cursor,
          limit: input.limit,
          extra: searchQuery
        });
        const cachedResponse = await readPageResponseCache<{
          items: ReturnType<typeof toDeveloperBundleTreeSearchEntry>[];
          nextCursor: string | null;
        }>({
          redis: redisCoordinator,
          scope,
          cacheId,
          invalidationScopes: [`developer-openapi:tree:${knowledgeBase.id}:${knowledgeBase.activeReleaseId}`]
        });

        if (cachedResponse) {
          return cachedResponse;
        }

        const page = await repo.files.searchBundleTreeEntries({
          knowledgeBaseId: knowledgeBase.id,
          releaseId: knowledgeBase.activeReleaseId,
          query: searchQuery,
          entryType: input.entryType,
          limit: input.limit,
          cursor: repositoryCursor
        });
        const response = await pageResponse(
          page,
          scope,
          config.pagination.cursorTtlSeconds,
          redisCoordinator,
          toDeveloperBundleTreeSearchEntry
        );
        await writePageResponseCache({
          redis: redisCoordinator,
          scope,
          cacheId,
          value: response
        });

        return response;
      }

      const scope = createBundleTreeCursorScope({
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        parentPath: input.parentPath,
        entryType: input.entryType,
        scopePrefix: "developer-openapi:tree"
      });
      const redisCoordinator = redis;
      const repositoryCursor = await readCursor(redisCoordinator, scope, input.cursor);
      const cacheId = createPageResponseCacheId({
        cursorToken: input.cursor,
        limit: input.limit,
        extra: input.parentPath
      });
      const cachedResponse = await readPageResponseCache<{
        items: ReturnType<typeof toDeveloperBundleTreeEntry>[];
        nextCursor: string | null;
      }>({
        redis: redisCoordinator,
        scope,
        cacheId,
        invalidationScopes: [`developer-openapi:tree:${knowledgeBase.id}:${knowledgeBase.activeReleaseId}`]
      });

      if (cachedResponse) {
        return cachedResponse;
      }

      const page = await repo.files.listBundleTreeEntries({
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        parentPath: input.parentPath,
        entryType: input.entryType,
        limit: input.limit,
        cursor: repositoryCursor
      });

      const response = await pageResponse(
        page,
        scope,
        config.pagination.cursorTtlSeconds,
        redisCoordinator,
        toDeveloperBundleTreeEntry
      );
      await writePageResponseCache({
        redis: redisCoordinator,
        scope,
        cacheId,
        value: response
      });

      return response;
    },
    async searchFiles(input: {
      knowledgeBaseId: string;
      query: string;
      scope: GeneratedFileSearchScope;
      fileKind: BundleFileKind | null;
      mode: GraphSearchMode;
      graphDepth: GraphSearchDepth;
      graphFanout: number;
      limit: number;
      cursor: string | null;
    }) {
      const repo = requireRepositories();
      const graphSettings = await readGraphSettings();

      if (!repo.files?.searchBundleFiles || !repo.files.getReleaseReadSummary) {
        throw repositoryUnavailable();
      }

      const knowledgeBase = await requireKnowledgeBase(repo, input.knowledgeBaseId);
      const normalizedQuery = input.mode === "file"
        ? normalizeGeneratedFileSearchQuery(input.query)
        : normalizeGraphSearchQuery(input.query);
      const queryContext = createFileSearchQueryContext(input, normalizedQuery);
      const nextRequestTemplates = createFileSearchNextRequestTemplates(knowledgeBase.id);

      if (!knowledgeBase.activeReleaseId) {
        return createUnavailableSearchResponse(queryContext, nextRequestTemplates, input);
      }

      const releaseSummary = await repo.files.getReleaseReadSummary({
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId
      });
      const indexedCount = releaseSummary?.searchableFileCount ?? 0;
      const graphIndexedCount = input.mode === "file"
        ? 0
        : releaseSummary?.graphDocumentCount ?? 0;
      const graphRelationshipCount = input.mode === "file"
        ? 0
        : releaseSummary?.graphRelationshipCount ?? 0;

      if (
        (input.mode === "file" && indexedCount === 0) ||
        (input.mode === "graph" && graphIndexedCount === 0) ||
        (input.mode === "hybrid" && indexedCount === 0 && graphIndexedCount === 0)
      ) {
        return createUnavailableSearchResponse(queryContext, nextRequestTemplates, input, {
          graphIndexedCount,
          graphRelationshipCount
        });
      }

      const scope = createDeveloperFileSearchCursorScope({
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        query: normalizedQuery,
        scope: input.scope,
        fileKind: input.fileKind,
        mode: input.mode,
        graphDepth: input.graphDepth,
        graphFanout: input.graphFanout
      });
      const redisCoordinator = redis;
      const repositoryCursor = await readCursor(redisCoordinator, scope, input.cursor);
      const cacheId = createPageResponseCacheId({
        cursorToken: input.cursor,
        limit: input.limit,
        extra: `file-search-response-v4:${input.mode}:${normalizedQuery}:${input.scope}:${input.fileKind ?? "all"}:${input.graphDepth}:${input.graphFanout}`
      });
      return readThroughPageResponseCache<DeveloperFileSearchResponse>({
        redis: redisCoordinator,
        scope,
        cacheId,
        invalidationScopes: [
          `developer-openapi:file-search:${knowledgeBase.id}:${knowledgeBase.activeReleaseId}`,
          `developer-openapi:graph-search:${knowledgeBase.id}:${knowledgeBase.activeReleaseId}`
        ],
        ttlSeconds: graphSettings.cacheTtlSeconds,
        negativeTtlSeconds: Math.max(1, Math.min(5, graphSettings.cacheTtlSeconds)),
        isNegative: (value) => value.searchStatus !== "ok",
        load: async () => {
          const page = await searchFilesByMode({
            repo,
            knowledgeBaseId: knowledgeBase.id,
            releaseId: knowledgeBase.activeReleaseId!,
            query: normalizedQuery,
            scope: input.scope,
            fileKind: input.fileKind,
            mode: input.mode,
            graphDepth: input.graphDepth,
            graphFanout: input.graphFanout,
            graphIndexedCount,
            limit: input.limit,
            cursor: repositoryCursor
          });
          const response = await pageResponse<
            BundleFileSearchResultRecord | BundleGraphSearchResultRecord,
            ReturnType<typeof toDeveloperFileSearchResult>
          >(
            page,
            scope,
            config.pagination.cursorTtlSeconds,
            redisCoordinator,
            toDeveloperFileSearchResult
          );

          return {
            query: queryContext,
            ...response,
            searchStatus: response.items.length > 0 ? "ok" : "no_candidates",
            searchMode: input.mode,
            graphStatus: graphStatusForMode(input.mode, graphIndexedCount),
            graphSummary: {
              available: graphIndexedCount > 0,
              indexedDocumentCount: graphIndexedCount,
              indexedRelationshipCount: graphRelationshipCount,
              depth: input.graphDepth,
              fanout: input.graphFanout
            },
            resultSummary: createFileSearchResultSummary(
              response.items.length,
              Boolean(response.nextCursor),
              response.items.length > 0 ? "ok" : "no_candidates",
              input.mode
            ),
            nextRequestTemplates,
            ...(response.items.length > 0 ? {} : noCandidateSearchHints())
          } satisfies DeveloperFileSearchResponse;
        }
      });
    },
    async getFileById(input: { knowledgeBaseId: string; fileId: string }) {
      const repo = requireRepositories();
      const resolved = await resolveBundleFileById(repo, input);

      return {
        file: toDeveloperBundleFile(resolved.file, resolved.source)
      };
    },
    async listRelatedFiles(input: {
      knowledgeBaseId: string;
      fileId: string;
      limit: number;
      cursor: string | null;
    }) {
      const repo = requireRepositories();
      const knowledgeBase = await requireKnowledgeBase(repo, input.knowledgeBaseId);

      if (!repo.graph?.listActiveGraphNeighborhood) {
        throw repositoryUnavailable();
      }

      const resolved = await resolveBundleFileById(repo, input);
      const sourceFileId = resolved.file.sourceFileId;

      if (!sourceFileId) {
        throw conflict("Only source-backed files can return related files.");
      }

      if (!knowledgeBase.activeReleaseId) throw conflict("Knowledge base has no readable generated content yet.");

      const scope = `developer-openapi:related:${input.knowledgeBaseId}:${sourceFileId}`;
      const page = await repo.graph.listActiveGraphNeighborhood({
        knowledgeBaseId: input.knowledgeBaseId,
        releaseId: knowledgeBase.activeReleaseId,
        sourceFileId,
        limit: input.limit,
        cursor: await readCursor(redis, scope, input.cursor)
      });

      return {
        fileId: input.fileId,
        sourceFileId,
        items: page.items.map((item) => toDeveloperRelatedFile(item, input.knowledgeBaseId)),
        nextCursor: await writeCursor(
          redis,
          scope,
          page.nextCursor,
          config.pagination.cursorTtlSeconds
        )
      };
    },
    async expandGraph(input: {
      knowledgeBaseId: string;
      fileId: string | null;
      nodeId: string | null;
      edgeId: string | null;
      query: string | null;
      depth: GraphSearchDepth;
      fanout: number;
      limit: number;
      cursor: string | null;
    }): Promise<DeveloperGraphExpansionResponse> {
      const repo = requireRepositories();

      if (!repo.graph?.listActiveGraphNeighborhood) {
        throw repositoryUnavailable();
      }

      if (input.fileId) {
        return expandGraphFromFile({
          repo,
          input: {
            ...input,
            fileId: input.fileId
          },
          redis
        });
      }

      if (input.nodeId) {
        return expandGraphFromNode({
          repo,
          input: {
            ...input,
            nodeId: input.nodeId
          },
          redis
        });
      }

      if (input.edgeId) {
        return expandGraphFromEdge({
          repo,
          input: {
            ...input,
            edgeId: input.edgeId
          },
          redis
        });
      }

      if (input.query) {
        return expandGraphFromQuery({
          repo,
          input: {
            ...input,
            query: input.query
          },
          redis
        });
      }

      throw validationError("Graph expansion requires a fileId, nodeId, edgeId, or query.");
    },
    async getGraphInsights(input: { knowledgeBaseId: string }): Promise<DeveloperGraphInsightsResponse> {
      const repo = requireRepositories();
      const knowledgeBase = await requireKnowledgeBase(repo, input.knowledgeBaseId);
      const getBundleFile = repo.files?.getBundleFile;
      const getReleaseGraphInsights = repo.files?.getReleaseGraphInsights;

      if (!knowledgeBase.activeReleaseId || !getBundleFile || !getReleaseGraphInsights) {
        throw notFound();
      }
      const releaseId = knowledgeBase.activeReleaseId;
      const graphSettings = await readGraphSettings();
      const scope = `developer-openapi:graph-insights:${knowledgeBase.id}:${releaseId}`;

      return readThroughPageResponseCache<DeveloperGraphInsightsResponse>({
        redis,
        scope,
        cacheId: createPageResponseCacheId({
          cursorToken: null,
          limit: 1,
          extra: "graph-insights-response-v2"
        }),
        ttlSeconds: graphSettings.cacheTtlSeconds,
        negativeTtlSeconds: Math.max(1, Math.min(5, graphSettings.cacheTtlSeconds)),
        isNegative: (value) => value.insights.length === 0,
        load: async () => {
          const [file, graphInsights] = await Promise.all([
            getBundleFile({
              knowledgeBaseId: knowledgeBase.id,
              releaseId,
              logicalPath: "_graph/insights.json"
            }),
            getReleaseGraphInsights({
              knowledgeBaseId: knowledgeBase.id,
              releaseId,
              limit: 100
            })
          ]);

          if (!file || !graphInsights) {
            throw notFound();
          }
          const source = await readSourceForBundle(repo, file);
          const base = `/openapi/v2/knowledge-bases/${knowledgeBase.id}/files/content?path=`;

          return {
            file: toDeveloperBundleFile(file, source),
            contentPath: "_graph/insights.json",
            insights: graphInsights.insights,
            generatedAt: graphInsights.generatedAt,
            resultSummary: {
              insightCount: graphInsights.insights.length,
              meaning:
                graphInsights.insights.length > 0
                  ? "Graph insights can guide further file and graph exploration."
                  : "No graph insights are currently published. Continue with file tree, file search, and graph expansion."
            },
            readActions: {
              graphIndex: `${base}_graph%2Findex.md`,
              graphManifest: `${base}_graph%2Fmanifest.json`,
              graphInsightsFile: `${base}_graph%2Finsights.json`,
              graphInsightsContent: `${base}_graph%2Finsights.json`
            },
            nextActions: [
              "Read _graph/index.md to understand available graph files.",
              "Read _graph/manifest.json for graph shard paths.",
              "Use graph expansion or file search before answering from insights alone."
            ]
          };
        }
      });
    },
    async getFileContentById(input: { knowledgeBaseId: string; fileId: string }) {
      const result = await readGeneratedContentWithMetrics({
        resolve: () => resolveBundleFileById(requireRepositories(), input),
        read: (resolved) => readGeneratedObjectText(storage, resolved.file.objectKey, config),
        now: () => performance.now(),
        onComplete: (metrics) =>
          reportGeneratedContentRead(services.logger, "developer_openapi", metrics)
      });

      if (!result.descriptor || result.content === null) {
        throw notFound();
      }

      return {
        file: toDeveloperBundleFile(result.descriptor.file, result.descriptor.source),
        content: result.content
      };
    },
    async getFileContentByPath(input: { knowledgeBaseId: string; path: string }) {
      const repo = requireRepositories();

      assertSafeLogicalPath(input.path, false);
      const result = await readGeneratedContentWithMetrics({
        resolve: async () => {
          const knowledgeBase = await requireKnowledgeBase(repo, input.knowledgeBaseId);

          if (!knowledgeBase.activeReleaseId || !repo.files?.getBundleFile) {
            return null;
          }

          const file = await repo.files.getBundleFile({
            knowledgeBaseId: knowledgeBase.id,
            releaseId: knowledgeBase.activeReleaseId,
            logicalPath: input.path
          });

          if (!file) {
            return null;
          }

          return { file, source: await readSourceForBundle(repo, file) };
        },
        read: (resolved) => readGeneratedObjectText(storage, resolved.file.objectKey, config),
        now: () => performance.now(),
        onComplete: (metrics) =>
          reportGeneratedContentRead(services.logger, "developer_openapi", metrics)
      });

      if (!result.descriptor || result.content === null) {
        throw notFound();
      }

      return {
        file: toDeveloperBundleFile(result.descriptor.file, result.descriptor.source),
        content: result.content
      };
    },
    async createWebhook(input: { name: string | null; url: string; events: string[] }) {
      const repo = requireRepositories();

      if (!repo.webhooks) {
        throw repositoryUnavailable();
      }

      const url = normalizeWebhookUrl(input.url);
      const rawSecret = `fwwh_${randomBytes(32).toString("base64url")}`;
      const createdAt = new Date().toISOString();
      const webhook = await repo.webhooks.createWebhookSubscription({
        id: `webhook-${randomUUID()}`,
        name: input.name?.trim() || "Webhook",
        url,
        signingSecret: rawSecret,
        events: input.events.filter((event) => typeof event === "string" && event.trim()),
        createdAt
      });

      return {
        webhook: toDeveloperWebhook(webhook),
        signingSecret: rawSecret
      };
    },
    async listWebhooks(input: { limit: number; cursor: string | null }) {
      const repo = requireRepositories();

      if (!repo.webhooks) {
        throw repositoryUnavailable();
      }

      const scope = "developer-openapi:webhooks";
      const page = await repo.webhooks.listWebhookSubscriptions({
        limit: input.limit,
        cursor: await readCursor(redis, scope, input.cursor)
      });

      return pageResponse(page, scope, config.pagination.cursorTtlSeconds, redis, toDeveloperWebhook);
    },
    async deleteWebhook(webhookId: string) {
      const repo = requireRepositories();

      if (!repo.webhooks) {
        throw repositoryUnavailable();
      }

      const deleted = await repo.webhooks.deleteWebhookSubscription({
        id: webhookId,
        updatedAt: new Date().toISOString()
      });

      if (!deleted) {
        throw notFound();
      }

      return { deleted: true, webhookId };
    },
    async listWebhookDeliveries(input: { limit: number; cursor: string | null }) {
      const repo = requireRepositories();

      if (!repo.webhooks) {
        throw repositoryUnavailable();
      }

      const scope = "developer-openapi:webhook-deliveries";
      const page = await repo.webhooks.listWebhookDeliveries({
        limit: input.limit,
        cursor: await readCursor(redis, scope, input.cursor)
      });

      return pageResponse(
        page,
        scope,
        config.pagination.cursorTtlSeconds,
        redis,
        toDeveloperWebhookDelivery
      );
    },
    async redeliverWebhook(deliveryId: string) {
      const repo = requireRepositories();

      if (!repo.webhooks?.getWebhookDelivery) {
        throw repositoryUnavailable();
      }

      const delivery = await repo.webhooks.getWebhookDelivery(deliveryId);

      if (!delivery) {
        throw notFound();
      }

      const dispatcher = createWebhookDispatcher({ repositories: repo, redis: requireRedis() });

      if (!dispatcher) {
        throw repositoryUnavailable();
      }

      return { delivery: toDeveloperWebhookDelivery(await dispatcher.redeliver(delivery)) };
    }
  };

  async function resolveBundleFileById(
    repo: AdminRepositories,
    input: { knowledgeBaseId: string; fileId: string }
  ): Promise<{ file: BundleFileRecord; source: SourceFileRecord | null }> {
    const knowledgeBase = await requireKnowledgeBase(repo, input.knowledgeBaseId);

    if (knowledgeBase.activeReleaseId) {
      const bundleFile = await repo.files?.getBundleFileById?.({
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        fileId: input.fileId
      });

      if (bundleFile) {
        return {
          file: bundleFile,
          source: await readSourceForBundle(repo, bundleFile)
        };
      }
    }
    throw notFound();
  }

  async function expandGraphFromFile(input: {
    repo: AdminRepositories;
    redis: RedisCoordinator | null;
    input: {
      knowledgeBaseId: string;
      fileId: string;
      nodeId: string | null;
      edgeId: string | null;
      query: string | null;
      depth: GraphSearchDepth;
      fanout: number;
      limit: number;
      cursor: string | null;
    };
  }): Promise<DeveloperGraphExpansionResponse> {
    const graphSettings = await readGraphSettings();
    const resolved = await resolveBundleFileById(input.repo, input.input);
    const sourceFileId = resolved.file.sourceFileId;

    if (!sourceFileId) {
      throw conflict("Only source-backed files can expand graph relationships.");
    }

    const knowledgeBase = await requireKnowledgeBase(input.repo, input.input.knowledgeBaseId);
    const scope = createGraphExpansionFileScope({
      knowledgeBaseId: input.input.knowledgeBaseId,
      sourceFileId,
      depth: input.input.depth,
      fanout: input.input.fanout
    });
    const cacheId = createPageResponseCacheId({
      cursorToken: input.input.cursor,
      limit: input.input.limit,
      extra: "graph-expand-file-v1"
    });
    const invalidationScopes = knowledgeBase.activeReleaseId
      ? [
          `developer-openapi:graph-expand:${knowledgeBase.id}:${knowledgeBase.activeReleaseId}`,
          `developer-openapi:graph-search:${knowledgeBase.id}:${knowledgeBase.activeReleaseId}`
        ]
      : [];
    const cachedResponse = await readPageResponseCache<DeveloperGraphExpansionResponse>({
      redis: input.redis,
      scope,
      cacheId,
      invalidationScopes
    });

    if (cachedResponse) {
      return cachedResponse;
    }

    const firstHop = input.input.depth === 0
      ? { items: [], nextCursor: null }
      : await input.repo.graph!.listActiveGraphNeighborhood!({
          knowledgeBaseId: input.input.knowledgeBaseId,
          releaseId: requireActiveReleaseId(knowledgeBase.activeReleaseId),
          sourceFileId,
          limit: input.input.limit,
          cursor: await readCursor(input.redis, scope, input.input.cursor)
        });
    const related = [...firstHop.items];

    if (input.input.depth >= 2) {
      for (const relationship of firstHop.items.slice(0, input.input.fanout)) {
        const nextHop = await input.repo.graph!.listActiveGraphNeighborhood!({
          knowledgeBaseId: input.input.knowledgeBaseId,
          releaseId: requireActiveReleaseId(knowledgeBase.activeReleaseId),
          sourceFileId: relationship.sourceFileId,
          limit: input.input.fanout,
          cursor: null
        });
        related.push(...nextHop.items);
      }
    }

    const relationships = uniqueRelatedFiles(related, new Set([sourceFileId])).map((item) =>
      toDeveloperRelatedFile(item, input.input.knowledgeBaseId)
    );

    const response: DeveloperGraphExpansionResponse = {
      query: createGraphExpansionQuery({
        fileId: input.input.fileId,
        nodeId: null,
        edgeId: null,
        query: null,
        normalizedQuery: null,
        input: input.input
      }),
      seedFile: toDeveloperBundleFile(resolved.file, resolved.source),
      seedResults: [],
      relationships,
      graphPaths: uniqueStrings([
        graphRefForSourceFile(sourceFileId),
        ...relationships.map((relationship) => graphRefForSourceFile(relationship.sourceFileId))
      ]),
      nextCursor: await writeCursor(
        input.redis,
        scope,
        firstHop.nextCursor,
        config.pagination.cursorTtlSeconds
      ),
      resultSummary: createGraphExpansionSummary({
        seedCount: 1,
        relationshipCount: relationships.length,
        hasMore: Boolean(firstHop.nextCursor),
        depth: input.input.depth,
        fanout: input.input.fanout
      }),
      nextActions: [
        "Read candidate file content before answering.",
        "Continue with related-file reads when more evidence is needed.",
        "Use graph search when this expansion does not provide enough evidence."
      ]
    };
    await writePageResponseCache({
      redis: input.redis,
      scope,
      cacheId,
      value: response,
      ttlSeconds: graphSettings.cacheTtlSeconds
    });
    return response;
  }

  async function expandGraphFromNode(input: {
    repo: AdminRepositories;
    redis: RedisCoordinator | null;
    input: {
      knowledgeBaseId: string;
      fileId: string | null;
      nodeId: string;
      edgeId: string | null;
      query: string | null;
      depth: GraphSearchDepth;
      fanout: number;
      limit: number;
      cursor: string | null;
    };
  }): Promise<DeveloperGraphExpansionResponse> {
    const graphSettings = await readGraphSettings();
    const source = await input.repo.files?.getSourceFile?.({
      knowledgeBaseId: input.input.knowledgeBaseId,
      sourceFileId: input.input.nodeId
    });

    if (!source) {
      throw notFound();
    }

    const knowledgeBase = await requireKnowledgeBase(input.repo, input.input.knowledgeBaseId);
    const scope = createGraphExpansionFileScope({
      knowledgeBaseId: input.input.knowledgeBaseId,
      sourceFileId: input.input.nodeId,
      depth: input.input.depth,
      fanout: input.input.fanout
    });
    const cacheId = createPageResponseCacheId({
      cursorToken: input.input.cursor,
      limit: input.input.limit,
      extra: "graph-expand-node-v1"
    });
    const invalidationScopes = knowledgeBase.activeReleaseId
      ? [
          `developer-openapi:graph-expand:${knowledgeBase.id}:${knowledgeBase.activeReleaseId}`,
          `developer-openapi:graph-search:${knowledgeBase.id}:${knowledgeBase.activeReleaseId}`
        ]
      : [];
    const cachedResponse = await readPageResponseCache<DeveloperGraphExpansionResponse>({
      redis: input.redis,
      scope,
      cacheId,
      invalidationScopes
    });

    if (cachedResponse) {
      return cachedResponse;
    }

    const firstHop = input.input.depth === 0
      ? { items: [], nextCursor: null }
      : await input.repo.graph!.listActiveGraphNeighborhood!({
          knowledgeBaseId: input.input.knowledgeBaseId,
          releaseId: requireActiveReleaseId(knowledgeBase.activeReleaseId),
          sourceFileId: input.input.nodeId,
          limit: input.input.limit,
          cursor: await readCursor(input.redis, scope, input.input.cursor)
        });
    const related = [...firstHop.items];

    if (input.input.depth >= 2) {
      for (const relationship of firstHop.items.slice(0, input.input.fanout)) {
        const nextHop = await input.repo.graph!.listActiveGraphNeighborhood!({
          knowledgeBaseId: input.input.knowledgeBaseId,
          releaseId: requireActiveReleaseId(knowledgeBase.activeReleaseId),
          sourceFileId: relationship.sourceFileId,
          limit: input.input.fanout,
          cursor: null
        });
        related.push(...nextHop.items);
      }
    }

    const relationships = uniqueRelatedFiles(related, new Set([input.input.nodeId])).map((item) =>
      toDeveloperRelatedFile(item, input.input.knowledgeBaseId)
    );
    const seedBundleFile = knowledgeBase.activeReleaseId && source.generatedBundleFileId
      ? await input.repo.files?.getBundleFileById?.({
          knowledgeBaseId: input.input.knowledgeBaseId,
          releaseId: knowledgeBase.activeReleaseId,
          fileId: source.generatedBundleFileId
        }) ?? null
      : null;
    const response: DeveloperGraphExpansionResponse = {
      query: createGraphExpansionQuery({
        fileId: null,
        nodeId: input.input.nodeId,
        edgeId: null,
        query: null,
        normalizedQuery: null,
        input: input.input
      }),
      seedFile: seedBundleFile ? toDeveloperBundleFile(seedBundleFile, source) : null,
      seedResults: [],
      relationships,
      graphPaths: uniqueStrings([
        graphRefForSourceFile(input.input.nodeId),
        ...relationships.map((relationship) => graphRefForSourceFile(relationship.sourceFileId))
      ]),
      nextCursor: await writeCursor(
        input.redis,
        scope,
        firstHop.nextCursor,
        config.pagination.cursorTtlSeconds
      ),
      resultSummary: createGraphExpansionSummary({
        seedCount: 1,
        relationshipCount: relationships.length,
        hasMore: Boolean(firstHop.nextCursor),
        depth: input.input.depth,
        fanout: input.input.fanout
      }),
      nextActions: [
        "Read candidate file content before answering.",
        "Continue with related-file reads when more evidence is needed.",
        "Use graph search when this expansion does not provide enough evidence."
      ]
    };

    await writePageResponseCache({
      redis: input.redis,
      scope,
      cacheId,
      value: response,
      ttlSeconds: graphSettings.cacheTtlSeconds
    });
    return response;
  }

  async function expandGraphFromEdge(input: {
    repo: AdminRepositories;
    redis: RedisCoordinator | null;
    input: {
      knowledgeBaseId: string;
      fileId: string | null;
      nodeId: string | null;
      edgeId: string;
      query: string | null;
      depth: GraphSearchDepth;
      fanout: number;
      limit: number;
      cursor: string | null;
    };
  }): Promise<DeveloperGraphExpansionResponse> {
    const graphSettings = await readGraphSettings();
    if (!input.repo.graph?.getGraphEdge) {
      throw repositoryUnavailable();
    }

    const knowledgeBase = await requireKnowledgeBase(input.repo, input.input.knowledgeBaseId);
    if (!knowledgeBase.activeReleaseId || !input.repo.graph.getActiveGraphEdge) {
      throw conflict("Knowledge base has no active graph release.");
    }
    const edge = await input.repo.graph.getActiveGraphEdge({
      knowledgeBaseId: input.input.knowledgeBaseId,
      releaseId: knowledgeBase.activeReleaseId,
      edgeId: input.input.edgeId
    });

    if (!edge) {
      throw notFound();
    }

    const scope = createGraphExpansionEdgeScope({
      knowledgeBaseId: input.input.knowledgeBaseId,
      edgeId: input.input.edgeId,
      depth: input.input.depth,
      fanout: input.input.fanout
    });
    const cacheId = createPageResponseCacheId({
      cursorToken: input.input.cursor,
      limit: input.input.limit,
      extra: "graph-expand-edge-v1"
    });
    const invalidationScopes = knowledgeBase.activeReleaseId
      ? [
          `developer-openapi:graph-expand:${knowledgeBase.id}:${knowledgeBase.activeReleaseId}`,
          `developer-openapi:graph-search:${knowledgeBase.id}:${knowledgeBase.activeReleaseId}`
        ]
      : [];
    const cachedResponse = await readPageResponseCache<DeveloperGraphExpansionResponse>({
      redis: input.redis,
      scope,
      cacheId,
      invalidationScopes
    });

    if (cachedResponse) {
      return cachedResponse;
    }

    const fromHop = input.input.depth === 0
      ? { items: [], nextCursor: null }
      : await input.repo.graph.listActiveGraphNeighborhood!({
          knowledgeBaseId: input.input.knowledgeBaseId,
          releaseId: knowledgeBase.activeReleaseId,
          sourceFileId: edge.fromFileId,
          limit: input.input.limit,
          cursor: await readCursor(input.redis, scope, input.input.cursor)
        });
    const toHop = input.input.depth === 0
      ? { items: [], nextCursor: null }
      : await input.repo.graph.listActiveGraphNeighborhood!({
          knowledgeBaseId: input.input.knowledgeBaseId,
          releaseId: knowledgeBase.activeReleaseId,
          sourceFileId: edge.toFileId,
          limit: input.input.fanout,
          cursor: null
        });
    const relationships = uniqueRelatedFiles([...fromHop.items, ...toHop.items]).map((item) =>
      toDeveloperRelatedFile(item, input.input.knowledgeBaseId)
    );
    const response: DeveloperGraphExpansionResponse = {
      query: createGraphExpansionQuery({
        fileId: null,
        nodeId: null,
        edgeId: input.input.edgeId,
        query: null,
        normalizedQuery: null,
        input: input.input
      }),
      seedFile: null,
      seedResults: [],
      relationships,
      graphPaths: uniqueStrings([
        graphRefForSourceFile(edge.fromFileId),
        graphRefForSourceFile(edge.toFileId),
        ...relationships.map((relationship) => graphRefForSourceFile(relationship.sourceFileId))
      ]),
      nextCursor: await writeCursor(
        input.redis,
        scope,
        fromHop.nextCursor,
        config.pagination.cursorTtlSeconds
      ),
      resultSummary: createGraphExpansionSummary({
        seedCount: 1,
        relationshipCount: relationships.length,
        hasMore: Boolean(fromHop.nextCursor),
        depth: input.input.depth,
        fanout: input.input.fanout
      }),
      nextActions: [
        "Read candidate file content before answering.",
        "Continue with related-file reads when more evidence is needed.",
        "Use graph search when this expansion does not provide enough evidence."
      ]
    };

    await writePageResponseCache({
      redis: input.redis,
      scope,
      cacheId,
      value: response,
      ttlSeconds: graphSettings.cacheTtlSeconds
    });
    return response;
  }

  async function expandGraphFromQuery(input: {
    repo: AdminRepositories;
    redis: RedisCoordinator | null;
    input: {
      knowledgeBaseId: string;
      fileId: string | null;
      nodeId: string | null;
      edgeId: string | null;
      query: string;
      depth: GraphSearchDepth;
      fanout: number;
      limit: number;
      cursor: string | null;
    };
  }): Promise<DeveloperGraphExpansionResponse> {
    const graphSettings = await readGraphSettings();
    const normalizedQuery = normalizeGraphSearchQuery(input.input.query);
    const knowledgeBase = await requireKnowledgeBase(input.repo, input.input.knowledgeBaseId);

    if (!knowledgeBase.activeReleaseId || !input.repo.files?.searchBundleGraphFiles) {
      return createUnavailableGraphExpansionResponse({
        input: input.input,
        normalizedQuery,
        message: "Relationship exploration is not available for this knowledge base yet. Continue with index.md and tree reads."
      });
    }

    const scope = createGraphExpansionQueryScope({
      knowledgeBaseId: input.input.knowledgeBaseId,
      releaseId: knowledgeBase.activeReleaseId,
      query: normalizedQuery,
      depth: input.input.depth,
      fanout: input.input.fanout
    });
    const cacheId = createPageResponseCacheId({
      cursorToken: input.input.cursor,
      limit: input.input.limit,
      extra: "graph-expand-query-v1"
    });
    const cachedResponse = await readPageResponseCache<DeveloperGraphExpansionResponse>({
      redis: input.redis,
      scope,
      cacheId,
      invalidationScopes: [
        `developer-openapi:graph-expand:${knowledgeBase.id}:${knowledgeBase.activeReleaseId}`,
        `developer-openapi:graph-search:${knowledgeBase.id}:${knowledgeBase.activeReleaseId}`
      ]
    });

    if (cachedResponse) {
      return cachedResponse;
    }

    const page = await searchFilesByMode({
      repo: input.repo,
      knowledgeBaseId: input.input.knowledgeBaseId,
      releaseId: knowledgeBase.activeReleaseId,
      query: normalizedQuery,
      scope: "all",
      fileKind: "page",
      mode: "graph",
      graphDepth: input.input.depth,
      graphFanout: input.input.fanout,
      graphIndexedCount: 1,
      limit: input.input.limit,
      cursor: await readCursor(input.redis, scope, input.input.cursor)
    });
    const seedResults = page.items.map(toDeveloperFileSearchResult);
    const relationships = uniqueRelatedFiles(
      page.items.flatMap((result) => "graphContext" in result ? result.graphContext.relationships : [])
    ).map((item) => toDeveloperRelatedFile(item, input.input.knowledgeBaseId));

    const response: DeveloperGraphExpansionResponse = {
      query: createGraphExpansionQuery({
        fileId: null,
        nodeId: null,
        edgeId: null,
        query: input.input.query,
        normalizedQuery,
        input: input.input
      }),
      seedFile: null,
      seedResults,
      relationships,
      graphPaths: uniqueStrings(
        seedResults.flatMap((result) => result.graphContext?.graphPaths ?? [])
      ),
      nextCursor: await writeCursor(
        input.redis,
        scope,
        page.nextCursor,
        config.pagination.cursorTtlSeconds
      ),
      resultSummary: createGraphExpansionSummary({
        seedCount: seedResults.length,
        relationshipCount: relationships.length,
        hasMore: Boolean(page.nextCursor),
        depth: input.input.depth,
        fanout: input.input.fanout
      }),
      ...(seedResults.length > 0
        ? {}
        : {
            message:
              "No graph candidates matched this query. Relevant data may still exist under different file paths, titles, or shorter terms.",
            nextActions: [
              "Read index.md through the file content endpoint.",
              "List the file tree and continue from visible directories.",
              "Search again with shorter or adjacent terms."
            ]
          })
    };
    await writePageResponseCache({
      redis: input.redis,
      scope,
      cacheId,
      value: response,
      ttlSeconds: graphSettings.cacheTtlSeconds
    });
    return response;
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function requireActiveReleaseId(value: string | null): string {
  if (!value) throw conflict("Knowledge base has no active graph release.");
  return value;
}

function createGraphExpansionFileScope(input: {
  knowledgeBaseId: string;
  sourceFileId: string;
  depth: GraphSearchDepth;
  fanout: number;
}): string {
  return [
    "developer-openapi:graph-expand:file",
    input.knowledgeBaseId,
    input.sourceFileId,
    String(input.depth),
    String(input.fanout)
  ].join(":");
}

function createGraphExpansionEdgeScope(input: {
  knowledgeBaseId: string;
  edgeId: string;
  depth: GraphSearchDepth;
  fanout: number;
}): string {
  return [
    "developer-openapi:graph-expand:edge",
    input.knowledgeBaseId,
    hashDeveloperOpenApiScopeValue(input.edgeId),
    String(input.depth),
    String(input.fanout)
  ].join(":");
}

function createGraphExpansionQueryScope(input: {
  knowledgeBaseId: string;
  releaseId: string;
  query: string;
  depth: GraphSearchDepth;
  fanout: number;
}): string {
  return [
    "developer-openapi:graph-expand:query",
    input.knowledgeBaseId,
    input.releaseId,
    String(input.depth),
    String(input.fanout),
    hashDeveloperOpenApiScopeValue(input.query)
  ].join(":");
}

function hashDeveloperOpenApiScopeValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function createGraphExpansionQuery(input: {
  fileId: string | null;
  nodeId: string | null;
  edgeId: string | null;
  query: string | null;
  normalizedQuery: string | null;
  input: {
    depth: GraphSearchDepth;
    fanout: number;
    limit: number;
    cursor: string | null;
  };
}): DeveloperGraphExpansionResponse["query"] {
  return {
    fileId: input.fileId,
    nodeId: input.nodeId,
    edgeId: input.edgeId,
    query: input.query,
    normalizedQuery: input.normalizedQuery,
    depth: input.input.depth,
    fanout: input.input.fanout,
    limit: input.input.limit,
    cursorProvided: Boolean(input.input.cursor)
  };
}

function createGraphExpansionSummary(input: {
  seedCount: number;
  relationshipCount: number;
  hasMore: boolean;
  depth: GraphSearchDepth;
  fanout: number;
}): DeveloperGraphExpansionResponse["resultSummary"] {
  return {
    ...input,
    meaning:
      input.relationshipCount > 0
        ? "Graph expansion returned related files. Read file content before answering."
        : "Graph expansion returned no relationships. Continue with file tree, index, or search reads."
  };
}

function createUnavailableGraphExpansionResponse(input: {
  input: {
    fileId: string | null;
    nodeId: string | null;
    edgeId: string | null;
    query: string | null;
    depth: GraphSearchDepth;
    fanout: number;
    limit: number;
    cursor: string | null;
  };
  normalizedQuery: string | null;
  message: string;
}): DeveloperGraphExpansionResponse {
  return {
    query: createGraphExpansionQuery({
      fileId: input.input.fileId,
      nodeId: input.input.nodeId,
      edgeId: input.input.edgeId,
      query: input.input.query,
      normalizedQuery: input.normalizedQuery,
      input: input.input
    }),
    seedFile: null,
    seedResults: [],
    relationships: [],
    graphPaths: [],
    nextCursor: null,
    resultSummary: createGraphExpansionSummary({
      seedCount: 0,
      relationshipCount: 0,
      hasMore: false,
      depth: input.input.depth,
      fanout: input.input.fanout
    }),
    message: input.message,
    nextActions: [
      "Read index.md through the file content endpoint.",
      "List the file tree to discover generated files.",
      "Use file search when graph expansion is unavailable."
    ]
  };
}

function uniqueRelatedFiles<T extends { sourceFileId: string }>(
  relationships: T[],
  excludedSourceFileIds: ReadonlySet<string> = new Set()
): T[] {
  const seen = new Set<string>();
  const output: T[] = [];

  for (const relationship of relationships) {
    const key = relationship.sourceFileId;

    if (excludedSourceFileIds.has(key) || seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(relationship);
  }

  return output;
}

async function requireKnowledgeBase(repo: AdminRepositories, knowledgeBaseId: string) {
  const knowledgeBase = await repo.knowledgeBases.getKnowledgeBase(knowledgeBaseId);

  if (!knowledgeBase) {
    throw notFound();
  }

  return knowledgeBase;
}

function createUnavailableSearchResponse(
  query: DeveloperFileSearchQueryContext,
  nextRequestTemplates: DeveloperFileSearchNextRequestTemplates,
  input: {
    mode: GraphSearchMode;
    graphDepth: GraphSearchDepth;
    graphFanout: number;
  },
  graph?: {
    graphIndexedCount: number;
    graphRelationshipCount: number;
  }
): DeveloperFileSearchResponse {
  const graphIndexedCount = graph?.graphIndexedCount ?? 0;
  const graphRelationshipCount = graph?.graphRelationshipCount ?? 0;
  return {
    query,
    items: [],
    nextCursor: null,
    searchStatus: "index_unavailable",
    searchMode: input.mode,
    graphStatus: graphStatusForMode(input.mode, graphIndexedCount),
    graphSummary: {
      available: graphIndexedCount > 0,
      indexedDocumentCount: graphIndexedCount,
      indexedRelationshipCount: graphRelationshipCount,
      depth: input.graphDepth,
      fanout: input.graphFanout
    },
    resultSummary: createFileSearchResultSummary(0, false, "index_unavailable", input.mode),
    nextRequestTemplates,
    message:
      input.mode === "file"
        ? "File search is not available for this knowledge base yet. Continue with index.md and file-tree reads."
        : "Relationship search is not available for this knowledge base yet. Continue with index.md, file-tree reads, and related-file reads after opening candidate files.",
    nextActions: [
      "Read index.md through the file content endpoint.",
      "List the file tree to discover generated files.",
      "Read related files after opening a candidate file."
    ]
  };
}

function noCandidateSearchHints(): Pick<DeveloperFileSearchResponse, "message" | "nextActions"> {
  return {
    message:
      "No generated files matched this query. The knowledge base may still contain relevant data through different titles, paths, or metadata terms.",
    nextActions: [
      "Split the user question into shorter terms and search again.",
      "Read index.md through the file content endpoint.",
      "List the file tree and continue exploration from visible directories.",
      "Try title, path, subject, product name, workflow, identifier, or shorter terms from the question.",
      "Use graph or hybrid search mode when a direct file search does not find enough evidence."
    ]
  };
}

function createFileSearchQueryContext(
  input: {
    query: string;
    scope: GeneratedFileSearchScope;
    fileKind: BundleFileKind | null;
    mode: GraphSearchMode;
    graphDepth: GraphSearchDepth;
    graphFanout: number;
    limit: number;
    cursor: string | null;
  },
  normalizedQuery: string
): DeveloperFileSearchQueryContext {
  return {
    query: input.query,
    normalizedQuery,
    scope: input.scope,
    fileKind: input.fileKind ?? "all",
    mode: input.mode,
    graphDepth: input.graphDepth,
    graphFanout: input.graphFanout,
    limit: input.limit,
    cursorProvided: Boolean(input.cursor)
  };
}

async function searchFilesByMode(input: {
  repo: AdminRepositories;
  knowledgeBaseId: string;
  releaseId: string;
  query: string;
  scope: GeneratedFileSearchScope;
  fileKind: BundleFileKind | null;
  mode: GraphSearchMode;
  graphDepth: GraphSearchDepth;
  graphFanout: number;
  graphIndexedCount: number;
  limit: number;
  cursor: string | null;
}): Promise<CursorPage<BundleFileSearchResultRecord | BundleGraphSearchResultRecord>> {
  if (input.mode === "file") {
    return input.repo.files!.searchBundleFiles!({
      knowledgeBaseId: input.knowledgeBaseId,
      releaseId: input.releaseId,
      query: input.query,
      scope: input.scope,
      fileKind: input.fileKind,
      limit: input.limit,
      cursor: input.cursor
    });
  }

  if (input.mode === "graph" || (input.mode === "hybrid" && input.graphIndexedCount > 0)) {
    if (!input.repo.files?.searchBundleGraphFiles) {
      return { items: [], nextCursor: null };
    }

    return input.repo.files.searchBundleGraphFiles({
      knowledgeBaseId: input.knowledgeBaseId,
      releaseId: input.releaseId,
      query: input.query,
      scope: input.scope,
      fileKind: input.fileKind,
      graphDepth: input.graphDepth,
      graphFanout: input.graphFanout,
      limit: input.limit,
      cursor: input.cursor
    });
  }

  return input.repo.files!.searchBundleFiles!({
    knowledgeBaseId: input.knowledgeBaseId,
    releaseId: input.releaseId,
    query: input.query,
    scope: input.scope,
    fileKind: input.fileKind,
    limit: input.limit,
    cursor: input.cursor
  });
}

function graphStatusForMode(
  mode: GraphSearchMode,
  indexedDocumentCount: number
): DeveloperFileSearchResponse["graphStatus"] {
  if (mode === "file") {
    return "disabled_for_file_mode";
  }

  return indexedDocumentCount > 0 ? "available" : "index_unavailable";
}

function createFileSearchNextRequestTemplates(
  knowledgeBaseId: string
): DeveloperFileSearchNextRequestTemplates {
  const base = `/openapi/v2/knowledge-bases/${knowledgeBaseId}`;

  return {
    searchAgain: `${base}/files/search?query={query}`,
    listTree: `${base}/tree?parentPath={parentPath}`,
    readIndex: `${base}/files/content?path=index.md`,
    fileDetailById: `${base}/files/{generatedFileId}`,
    fileContentById: `${base}/files/{generatedFileId}/content`,
    fileContentByPath: `${base}/files/content?path={generatedFilePath}`,
    relatedFilesById: `${base}/files/{generatedFileId}/related`,
    graphExpansionByFileId: `${base}/graph/expand?fileId={generatedFileId}`,
    sourceFileStatusById: `${base}/source-files/{sourceFileId}`,
    sourceFileEventsById: `${base}/source-files/{sourceFileId}/events`
  };
}

function createFileSearchResultSummary(
  resultCount: number,
  hasMore: boolean,
  status: DeveloperFileSearchResponse["searchStatus"],
  mode: GraphSearchMode
): DeveloperFileSearchResultSummary {
  return {
    resultCount,
    hasMore,
    sort: ["score desc", "path asc", "fileId asc"],
    meaning:
      status === "ok"
        ? mode === "file"
          ? "Candidates matched the query. Read candidate content and related files before answering."
          : "Graph candidates matched the query. Read candidate content, graph context, and related files before answering."
        : status === "no_candidates"
          ? "No generated files matched this query. Relevant data may still exist under different terms or graph paths."
          : mode === "file"
            ? "File search is not available for this knowledge base yet. Use tree and index reads to continue exploration."
            : "Relationship search is not available for this knowledge base yet. Use tree, index, and related-file reads to continue exploration."
  };
}

async function readCursor(
  redis: RedisCoordinator | null,
  scope: string,
  cursor: string | null
): Promise<string | null> {
  if (!cursor) {
    return null;
  }

  if (!redis) {
    throw validationError("Pagination cursor is unavailable while the cache service is offline.", {
      field: "cursor"
    });
  }

  const value = await redis.getPaginationCursor<string>(scope, cursor);

  if (!value) {
    throw validationError("Pagination cursor is invalid or expired.", { field: "cursor" });
  }

  return value;
}

async function writeCursor(
  redis: RedisCoordinator | null,
  scope: string,
  cursor: string | null,
  ttlSeconds: number
): Promise<string | null> {
  if (!cursor) {
    return null;
  }

  if (!redis) {
    return null;
  }

  const cursorId = `cursor-${randomUUID()}`;
  await redis.setPaginationCursor(scope, cursorId, cursor, ttlSeconds);
  return cursorId;
}

async function pageResponse<T, U>(
  page: CursorPage<T>,
  scope: string,
  ttlSeconds: number,
  redis: RedisCoordinator | null,
  map: (value: T) => U
): Promise<{ items: U[]; nextCursor: string | null }> {
  return {
    items: page.items.map(map),
    nextCursor: await writeCursor(redis, scope, page.nextCursor, ttlSeconds)
  };
}

function assertSafeLogicalPath(path: string, allowDirectory: boolean): void {
  if (
    (allowDirectory && path === "") ||
    isAllowedPublicBundleFilePath(path) ||
    (allowDirectory && isAllowedPublicBundleDirectoryPath(path))
  ) {
    return;
  }

  throw validationError("Logical path is not supported.", { field: "path" });
}

async function readSourceForBundle(
  repo: AdminRepositories,
  file: BundleFileRecord
): Promise<SourceFileRecord | null> {
  if (!file.sourceFileId) {
    return null;
  }

  return (
    (await repo.files?.getSourceFile?.({
      knowledgeBaseId: file.knowledgeBaseId,
      sourceFileId: file.sourceFileId
    })) ?? null
  );
}

async function readGeneratedObjectText(
  storage: StorageAdapter,
  objectKey: string,
  config: RuntimeConfig
): Promise<string | null> {
  try {
    return await storage.getObjectText(objectKey, {
      maxBytes: config.pagination.generatedContentMaxBytes
    });
  } catch (error) {
    if (error instanceof StorageObjectTooLargeError) {
      throw payloadTooLarge("Generated file content exceeds the configured read limit.");
    }

    throw error;
  }
}

function normalizeWebhookUrl(value: string): string {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw validationError("Webhook URL is invalid.", { field: "url" });
  }

  if (parsed.protocol !== "https:") {
    throw validationError("Webhook URL must use HTTPS.", { field: "url" });
  }

  return parsed.toString();
}
