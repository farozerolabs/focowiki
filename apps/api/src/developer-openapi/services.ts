import { randomBytes, randomUUID } from "node:crypto";
import type { RuntimeConfig } from "../config.js";
import type {
  AdminRepositories,
  CursorPage
} from "../db/admin-repositories.js";
import type { GeneratedFileKind } from "../okf/publication-files.js";
import {
  GENERATED_GRAPH_RESOURCES,
  graphFileContentAction,
  graphTreeAction
} from "../okf/generated-graph-resources.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { RuntimeSettingsService } from "../runtime-settings/service.js";
import {
  StorageObjectTooLargeError,
  type StorageAdapter
} from "../storage/s3.js";
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
  expandActiveGenerationGraph
} from "./active-generation-graph-expansion.js";
import { createWebhookDispatcher } from "../webhooks/dispatcher.js";
import {
  isAllowedPublicGeneratedDirectoryPath,
  isAllowedPublicGeneratedFilePath
} from "../public-generated-path.js";
import type { OpenAIModelClient } from "@focowiki/okf";
import {
  retrySourceFile,
  SourceFileRetryServiceError
} from "../application/source-file-retry.js";
import {
  conflict,
  notFound,
  payloadTooLarge,
  repositoryUnavailable,
  validationError
} from "./errors.js";
import {
  toDeveloperKnowledgeBase,
  toDeveloperSourceFileEvent,
  toDeveloperWebhook,
  toDeveloperWebhookDelivery
} from "./serializers.js";
import type { RuntimeLogger } from "../logger.js";
import { readGeneratedContentWithMetrics } from "../application/generated-content-read.js";
import { reportGeneratedContentRead } from "../app/generated-content-read-logger.js";
import type {
  ActiveGenerationProjection,
  ActiveGenerationReadRepository
} from "../application/ports/active-generation-read-repository.js";
import type { SourceFileRetryRepository } from "../application/ports/source-file-retry-repository.js";
import {
  toDeveloperActiveFile,
  toDeveloperActiveRelatedFile,
  toDeveloperActiveSearchResult,
  toDeveloperActiveTreeEntry
} from "./active-generation-serializers.js";

export type DeveloperOpenApiServices = {
  config: RuntimeConfig;
  repositories: AdminRepositories | null;
  redis: RedisCoordinator | null;
  storage: StorageAdapter;
  modelClient: OpenAIModelClient | null;
  runtimeSettings: RuntimeSettingsService | null;
  logger?: RuntimeLogger;
  activeGenerationReads: ActiveGenerationReadRepository | null;
  sourceFileRetries: SourceFileRetryRepository | null;
};

type DeveloperFileSearchResponse = {
  generationId: string | null;
  query: DeveloperFileSearchQueryContext;
  items: ReturnType<typeof toDeveloperActiveSearchResult>[];
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
  fileKind: GeneratedFileKind | "all";
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
  generationId: string;
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
  seedFile: ReturnType<typeof toDeveloperActiveFile> | null;
  seedResults: ReturnType<typeof toDeveloperActiveSearchResult>[];
  relationships: ReturnType<typeof toDeveloperActiveRelatedFile>[];
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

type DeveloperGraphOverviewResponse = {
  generationId: string;
  availability: "available" | "empty" | "unavailable";
  summary: {
    nodeCount: number;
    edgeCount: number;
  };
  resources: {
    graphIndexPath: string | null;
    nodeDirectoryPath: string | null;
    edgeDirectoryPath: string | null;
    byFileDirectoryPath: string | null;
  };
  readActions: {
    readIndexContent: string;
    graphIndexContent: string | null;
    listGraphRoot: string;
    listGraphNodes: string | null;
    listGraphEdges: string | null;
    listByFileGraph: string | null;
    searchGraph: string;
    expandGraphByFileId: string;
    fileDetailById: string;
    fileContentById: string;
    fileContentByPath: string;
    relatedFilesById: string;
  };
  message: string;
  nextActions: string[];
};

type GenerationCursorEnvelope<T> = {
  generationId: string;
  value: T;
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

  function requireActiveGenerationReads(): ActiveGenerationReadRepository {
    if (!services.activeGenerationReads) {
      throw repositoryUnavailable();
    }
    return services.activeGenerationReads;
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

      try {
        return await retrySourceFile({
          repositories: repo,
          retries: services.sourceFileRetries,
          knowledgeBaseId: input.knowledgeBaseId,
          sourceFileId: input.sourceFileId,
          config,
          worker: (await services.runtimeSettings?.getSnapshot())?.worker
        });
      } catch (error) {
        if (error instanceof SourceFileRetryServiceError) {
          if (error.code === "SOURCE_FILE_NOT_FOUND") throw notFound();
          if (error.code === "SOURCE_FILE_RETRY_BACKEND_UNAVAILABLE") {
            throw repositoryUnavailable();
          }
          throw conflict(
            error.code === "SOURCE_FILE_RETRY_NOT_ALLOWED"
              ? "This source-file failure cannot be retried."
              : "The source file is being changed or deleted. Retry is unavailable."
          );
        }
        throw error;
      }
    },
    async listTree(input: {
      knowledgeBaseId: string;
      parentPath: string;
      entryType: "directory" | "file" | null;
      query: string | null;
      limit: number;
      cursor: string | null;
    }) {
      assertSafeLogicalPath(input.parentPath, true);
      const cursorScope = [
        "developer-openapi:generation-tree",
        input.knowledgeBaseId,
        input.parentPath,
        input.entryType ?? "all",
        input.query?.trim() ?? ""
      ].join(":");
      const storedCursor = await readCursor<GenerationCursorEnvelope<{
        sortKey: string;
        recordId: string;
      }>>(redis, cursorScope, input.cursor);
      const result = await requireActiveGenerationReads().withActiveGeneration(
        input.knowledgeBaseId,
        async (scope) => {
          assertCursorGeneration(storedCursor, scope.generationId);
          const page = await scope.listTree({
            parentPath: input.parentPath,
            entryType: input.entryType,
            query: input.query,
            limit: input.limit,
            cursor: storedCursor?.value ?? null
          });
          return { generationId: scope.generationId, page };
        }
      );
      if (!result) {
        return { generationId: null, items: [], nextCursor: null };
      }
      return {
        generationId: result.generationId,
        items: result.page.items.map((item) =>
          toDeveloperActiveTreeEntry(input.knowledgeBaseId, item)
        ),
        nextCursor: await writeCursor(
          redis,
          cursorScope,
          result.page.nextCursor
            ? { generationId: result.generationId, value: result.page.nextCursor }
            : null,
          config.pagination.cursorTtlSeconds
        )
      };
    },
    async searchFiles(input: {
      knowledgeBaseId: string;
      query: string;
      scope: GeneratedFileSearchScope;
      fileKind: GeneratedFileKind | null;
      mode: GraphSearchMode;
      graphDepth: GraphSearchDepth;
      graphFanout: number;
      limit: number;
      cursor: string | null;
    }) {
      const normalizedQuery = input.mode === "file"
        ? normalizeGeneratedFileSearchQuery(input.query)
        : normalizeGraphSearchQuery(input.query);
      const queryContext = createFileSearchQueryContext(input, normalizedQuery);
      const nextRequestTemplates = createFileSearchNextRequestTemplates(input.knowledgeBaseId);
      const cursorScope = [
        "developer-openapi:generation-search",
        input.knowledgeBaseId,
        normalizedQuery,
        input.scope,
        input.fileKind ?? "all",
        input.mode,
        input.graphDepth,
        input.graphFanout
      ].join(":");
      const storedCursor = await readCursor<GenerationCursorEnvelope<{
        score: number;
        recordId: string;
      }>>(redis, cursorScope, input.cursor);
      const result = await requireActiveGenerationReads().withActiveGeneration(
        input.knowledgeBaseId,
        async (scope) => {
          assertCursorGeneration(storedCursor, scope.generationId);
          const page = await scope.search({
            query: normalizedQuery,
            mode: input.mode,
            limit: input.limit,
            cursor: storedCursor?.value ?? null
          });
          const relatedBySource = input.mode === "file"
            ? new Map<string, ActiveGenerationProjection[]>()
            : await scope.listRelatedForSources({
                sourceFileIds: page.items
                  .map((item) => item.sourceFileId)
                  .filter((sourceFileId): sourceFileId is string => Boolean(sourceFileId)),
                limitPerSource: input.graphFanout
              });
          return { generationId: scope.generationId, page, relatedBySource };
        }
      );
      if (!result) {
        return createUnavailableSearchResponse(queryContext, nextRequestTemplates, input);
      }
      const nextCursor = await writeCursor(
        redis,
        cursorScope,
        result.page.nextCursor
          ? { generationId: result.generationId, value: result.page.nextCursor }
          : null,
        config.pagination.cursorTtlSeconds
      );
      const items = result.page.items.map((item) =>
        toDeveloperActiveSearchResult(input.knowledgeBaseId, item, {
          mode: input.mode,
          depth: input.graphDepth,
          relationships: item.sourceFileId
            ? result.relatedBySource.get(item.sourceFileId) ?? []
            : []
        })
      );
      const status = items.length > 0 ? "ok" : "no_candidates";
      return {
        generationId: result.generationId,
        query: queryContext,
        items,
        nextCursor,
        searchStatus: status,
        searchMode: input.mode,
        graphStatus: input.mode === "file" ? "disabled_for_file_mode" : "available",
        graphSummary: {
          available: input.mode !== "file",
          indexedDocumentCount: items.length,
          indexedRelationshipCount: 0,
          depth: input.graphDepth,
          fanout: input.graphFanout
        },
        resultSummary: createFileSearchResultSummary(
          items.length,
          Boolean(nextCursor),
          status,
          input.mode
        ),
        nextRequestTemplates,
        ...(items.length > 0 ? {} : noCandidateSearchHints())
      };
    },
    async getFileById(input: { knowledgeBaseId: string; fileId: string }) {
      const result = await requireActiveGenerationReads().withActiveGeneration(
        input.knowledgeBaseId,
        (scope) => scope.findFileById(input.fileId)
      );
      if (!result) throw notFound();
      return { file: toDeveloperActiveFile(input.knowledgeBaseId, result) };
    },
    async listRelatedFiles(input: {
      knowledgeBaseId: string;
      fileId: string;
      limit: number;
      cursor: string | null;
    }) {
      const cursorScope = `developer-openapi:generation-related:${input.knowledgeBaseId}:${input.fileId}`;
      const storedCursor = await readCursor<GenerationCursorEnvelope<{
        score: number;
        recordId: string;
      }>>(redis, cursorScope, input.cursor);
      const result = await requireActiveGenerationReads().withActiveGeneration(
        input.knowledgeBaseId,
        async (scope) => {
          assertCursorGeneration(storedCursor, scope.generationId);
          const file = await scope.findFileById(input.fileId);
          if (!file) return null;
          if (!file.sourceFileId) {
            throw conflict("Only source-backed files can return related files.");
          }
          const page = await scope.listRelated({
            sourceFileId: file.sourceFileId,
            limit: input.limit,
            cursor: storedCursor?.value ?? null
          });
          return { generationId: scope.generationId, file, page };
        }
      );
      if (!result) throw notFound();
      return {
        generationId: result.generationId,
        fileId: input.fileId,
        sourceFileId: result.file.sourceFileId,
        items: result.page.items.map((item) =>
          toDeveloperActiveRelatedFile(input.knowledgeBaseId, item)
        ),
        nextCursor: await writeCursor(
          redis,
          cursorScope,
          result.page.nextCursor
            ? { generationId: result.generationId, value: result.page.nextCursor }
            : null,
          config.pagination.cursorTtlSeconds
        ),
        ...(result.page.items.length > 0 ? {} : {
          message: "No related files matched this file in the active generation. Continue with tree or search using broader terms.",
          nextActions: [
            "Read the file content before changing search terms.",
            "Search for the file title, subjects, entities, or shorter concepts.",
            "Browse neighboring directories when relationship evidence is sparse."
          ]
        })
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
      const normalizedQuery = input.query ? normalizeGraphSearchQuery(input.query) : null;
      const cursorScope = [
        "developer-openapi:generation-graph-expand",
        input.knowledgeBaseId,
        input.fileId ?? "",
        input.nodeId ?? "",
        input.edgeId ?? "",
        normalizedQuery ?? "",
        input.depth,
        input.fanout
      ].join(":");
      const storedCursor = await readCursor<GenerationCursorEnvelope<{
        score: number;
        recordId: string;
      }>>(redis, cursorScope, input.cursor);
      const result = await requireActiveGenerationReads().withActiveGeneration(
        input.knowledgeBaseId,
        async (scope) => {
          assertCursorGeneration(storedCursor, scope.generationId);
          const expansion = await expandActiveGenerationGraph(scope, {
            ...input,
            query: normalizedQuery,
            cursor: storedCursor?.value ?? null
          });
          return expansion ? { generationId: scope.generationId, expansion } : null;
        }
      );
      if (!result) throw notFound();
      const nextCursor = await writeCursor(
        redis,
        cursorScope,
        result.expansion.nextCursor
          ? { generationId: result.generationId, value: result.expansion.nextCursor }
          : null,
        config.pagination.cursorTtlSeconds
      );
      const seedFile = result.expansion.seedFile
        ? toDeveloperActiveFile(input.knowledgeBaseId, result.expansion.seedFile)
        : null;
      const seedResults = result.expansion.seedResults.map((item) =>
        toDeveloperActiveSearchResult(input.knowledgeBaseId, item)
      );
      const relationships = result.expansion.relationships.map((item) =>
        toDeveloperActiveRelatedFile(input.knowledgeBaseId, item)
      );
      return {
        generationId: result.generationId,
        query: createGraphExpansionQuery({
          fileId: input.fileId,
          nodeId: input.nodeId,
          edgeId: input.edgeId,
          query: input.query,
          normalizedQuery,
          input
        }),
        seedFile,
        seedResults,
        relationships,
        graphPaths: uniqueStrings([
          ...result.expansion.seedResults.map((item) => item.sourceFileId),
          ...result.expansion.relationships.map((item) => item.relatedSourceFileId)
        ].filter((value): value is string => Boolean(value)).map(graphRefForSourceFile)),
        nextCursor,
        resultSummary: createGraphExpansionSummary({
          seedCount: result.expansion.seedCount,
          relationshipCount: relationships.length,
          hasMore: Boolean(nextCursor),
          depth: input.depth,
          fanout: input.fanout
        }),
        ...(seedFile || seedResults.length > 0 || relationships.length > 0 ? {} : {
          message: "No graph candidates matched in the active generation. Relevant files may still exist under different titles, paths, or shorter terms.",
          nextActions: [
            "Read index.md through the file content endpoint.",
            "List the file tree and continue from visible directories.",
            "Search again with shorter or adjacent terms."
          ]
        })
      };
    },
    async getGraphOverview(input: { knowledgeBaseId: string }): Promise<DeveloperGraphOverviewResponse> {
      const active = await requireActiveGenerationReads().withActiveGeneration(
        input.knowledgeBaseId,
        async (scope) => {
          const cacheScope = "developer-openapi:graph-overview";
          const cacheId = `${input.knowledgeBaseId}:${scope.generationId}`;
          const cached = await redis?.getPageCache<{
            nodeCount: number;
            edgeCount: number;
            graphIndexAvailable: boolean;
          }>(cacheScope, cacheId);
          if (cached) return { generationId: scope.generationId, summary: cached };
          const summary = await scope.getGraphSummary();
          if (!summary.persisted) {
            await redis?.setPageCache(cacheScope, cacheId, {
              nodeCount: summary.nodeCount,
              edgeCount: summary.edgeCount,
              graphIndexAvailable: summary.graphIndexAvailable
            }, 30);
          }
          return { generationId: scope.generationId, summary };
        }
      );
      if (!active) throw notFound();
      const availability = !active.summary.graphIndexAvailable
        ? "unavailable" as const
        : active.summary.nodeCount > 0 || active.summary.edgeCount > 0
          ? "available" as const
          : "empty" as const;
      const base = `/openapi/v2/knowledge-bases/${input.knowledgeBaseId}`;
      return {
        generationId: active.generationId,
        availability,
        summary: {
          nodeCount: active.summary.nodeCount,
          edgeCount: active.summary.edgeCount
        },
        resources: {
          graphIndexPath: active.summary.graphIndexAvailable
            ? GENERATED_GRAPH_RESOURCES.index.path
            : null,
          nodeDirectoryPath: active.summary.nodeCount > 0
            ? GENERATED_GRAPH_RESOURCES.nodeDirectoryPath
            : null,
          edgeDirectoryPath: active.summary.edgeCount > 0
            ? GENERATED_GRAPH_RESOURCES.edgeDirectoryPath
            : null,
          byFileDirectoryPath: active.summary.nodeCount > 0
            ? GENERATED_GRAPH_RESOURCES.byFileDirectoryPath
            : null
        },
        readActions: {
          readIndexContent: `${base}/files/content?path=index.md`,
          graphIndexContent: active.summary.graphIndexAvailable
            ? graphFileContentAction(input.knowledgeBaseId, GENERATED_GRAPH_RESOURCES.index.path)
            : null,
          listGraphRoot: graphTreeAction(
            input.knowledgeBaseId,
            GENERATED_GRAPH_RESOURCES.rootDirectoryPath
          ),
          listGraphNodes: active.summary.nodeCount > 0
            ? graphTreeAction(input.knowledgeBaseId, GENERATED_GRAPH_RESOURCES.nodeDirectoryPath)
            : null,
          listGraphEdges: active.summary.edgeCount > 0
            ? graphTreeAction(input.knowledgeBaseId, GENERATED_GRAPH_RESOURCES.edgeDirectoryPath)
            : null,
          listByFileGraph: active.summary.nodeCount > 0
            ? graphTreeAction(input.knowledgeBaseId, GENERATED_GRAPH_RESOURCES.byFileDirectoryPath)
            : null,
          searchGraph: `${base}/files/search?query={query}&mode=graph`,
          expandGraphByFileId: `${base}/graph/expand?fileId={fileId}`,
          fileDetailById: `${base}/files/{fileId}`,
          fileContentById: `${base}/files/{fileId}/content`,
          fileContentByPath: `${base}/files/content?path={path}`,
          relatedFilesById: `${base}/files/{fileId}/related`
        },
        message: availability === "available"
          ? "Graph projections are available. Continue to source-backed files before answering."
          : availability === "empty"
            ? "The graph is currently empty. Relevant source-backed files may still exist."
            : "Graph projections are not available yet. Continue with index.md, the file tree, and file search.",
        nextActions: [
          availability === "available"
            ? "Read the graph index or list graph directories to discover relationships."
            : "Read index.md and list the file tree to discover source-backed files.",
          "Use graph search, related files, or graph expansion to identify candidate files.",
          "Read candidate file content before answering."
        ]
      };
    },
    async getFileContentById(input: { knowledgeBaseId: string; fileId: string }) {
      const result = await readGeneratedContentWithMetrics({
        resolve: () => requireActiveGenerationReads().withActiveGeneration(
          input.knowledgeBaseId,
          (scope) => scope.findFileById(input.fileId)
        ),
        read: (resolved) => readGeneratedObjectText(storage, resolved.objectKey, config),
        now: () => performance.now(),
        onComplete: (metrics) =>
          reportGeneratedContentRead(services.logger, "developer_openapi", metrics)
      });

      if (!result.descriptor || result.content === null) {
        throw notFound();
      }

      return {
        file: toDeveloperActiveFile(input.knowledgeBaseId, result.descriptor),
        content: result.content
      };
    },
    async getFileContentByPath(input: { knowledgeBaseId: string; path: string }) {
      assertSafeLogicalPath(input.path, false);
      const result = await readGeneratedContentWithMetrics({
        resolve: () => requireActiveGenerationReads().withActiveGeneration(
          input.knowledgeBaseId,
          (scope) => scope.findFileByPath(input.path)
        ),
        read: (resolved) => readGeneratedObjectText(storage, resolved.objectKey, config),
        now: () => performance.now(),
        onComplete: (metrics) =>
          reportGeneratedContentRead(services.logger, "developer_openapi", metrics)
      });

      if (!result.descriptor || result.content === null) {
        throw notFound();
      }

      return {
        file: toDeveloperActiveFile(input.knowledgeBaseId, result.descriptor),
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

}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
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
    generationId: null,
    query,
    items: [],
    nextCursor: null,
    searchStatus: "index_unavailable",
    searchMode: input.mode,
    graphStatus: input.mode === "file" ? "disabled_for_file_mode" : "index_unavailable",
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
    fileKind: GeneratedFileKind | null;
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

async function readCursor<T = string>(
  redis: RedisCoordinator | null,
  scope: string,
  cursor: string | null
): Promise<T | null> {
  if (!cursor) {
    return null;
  }

  if (!redis) {
    throw validationError("Pagination cursor is unavailable while the cache service is offline.", {
      field: "cursor"
    });
  }

  const value = await redis.getPaginationCursor<T>(scope, cursor);

  if (!value) {
    throw validationError("Pagination cursor is invalid or expired.", { field: "cursor" });
  }

  return value;
}

async function writeCursor<T = string>(
  redis: RedisCoordinator | null,
  scope: string,
  cursor: T | null,
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

function assertCursorGeneration<T>(
  cursor: GenerationCursorEnvelope<T> | null,
  generationId: string
): void {
  if (cursor && cursor.generationId !== generationId) {
    throw validationError("Pagination cursor belongs to an inactive generation.", {
      field: "cursor"
    });
  }
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
    isAllowedPublicGeneratedFilePath(path) ||
    (allowDirectory && isAllowedPublicGeneratedDirectoryPath(path))
  ) {
    return;
  }

  throw validationError("Logical path is not supported.", { field: "path" });
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
