import { randomBytes, randomUUID } from "node:crypto";
import type { RuntimeConfig } from "../config.js";
import type {
  AdminRepositories,
  BundleFileKind,
  BundleFileRecord,
  BundleFileSearchResultRecord,
  BundleTreeEntryRecord,
  CursorPage,
  SourceFileListFilters,
  SourceFileRecord
} from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { RuntimeSettingsService } from "../runtime-settings/service.js";
import { resolveUploadGenerationSettings } from "../runtime-settings/upload-generation.js";
import {
  StorageObjectTooLargeError,
  type StorageAdapter
} from "../storage/s3.js";
import { acceptUploadSourceFiles } from "../admin/source-file-upload.js";
import type { LoadedUploadFile } from "../admin/upload-processor-utils.js";
import { createDeletionService } from "../admin/deletion-service.js";
import { readGeneratedOutputsForSourceFilesSafely } from "../admin/source-file-generated-output.js";
import { createSourceFileCursorScope } from "../admin/source-file-list-filter-signature.js";
import {
  createSourceFileTaskDeletionService,
  type SourceFileTaskDeletionResponse
} from "../admin/source-file-task-deletion-service.js";
import { createDeveloperFileSearchCursorScope } from "./file-search-signature.js";
import {
  normalizeGeneratedFileSearchQuery,
  type GeneratedFileSearchScope
} from "../search/generated-file-search-documents.js";
import {
  createPageResponseCacheId,
  readPageResponseCache,
  writePageResponseCache
} from "../page-response-cache.js";
import { createWebhookDispatcher, type WebhookEvent } from "../webhooks/dispatcher.js";
import { createBundleTreeCursorScope } from "../tree-entry-filters.js";
import type { OpenAIResponsesClient } from "@focowiki/okf";
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
  toDeveloperBundleTreeEntry,
  toDeveloperFileSearchResult,
  toDeveloperKnowledgeBase,
  toDeveloperRelatedFile,
  toDeveloperSourceFile,
  toDeveloperSourceFileDetail,
  toDeveloperSourceFileEvent,
  toDeveloperWebhook,
  toDeveloperWebhookDelivery
} from "./serializers.js";

export type DeveloperOpenApiServices = {
  config: RuntimeConfig;
  repositories: AdminRepositories | null;
  redis: RedisCoordinator | null;
  storage: StorageAdapter;
  modelClient: OpenAIResponsesClient | null;
  runtimeSettings: RuntimeSettingsService | null;
};

type DeveloperFileSearchResponse = {
  query: DeveloperFileSearchQueryContext;
  items: ReturnType<typeof toDeveloperFileSearchResult>[];
  nextCursor: string | null;
  searchStatus: "ok" | "no_candidates" | "index_unavailable";
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
  sourceFileStatusById: string;
  sourceFileEventsById: string;
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
        cursor: await readCursor(requireRedis(), "developer-openapi:knowledge-bases", input.cursor)
      });

      return {
        items: page.items.map(toDeveloperKnowledgeBase),
        nextCursor: await writeCursor(
          requireRedis(),
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
    async deleteKnowledgeBase(knowledgeBaseId: string) {
      const repo = requireRepositories();
      const coordinator = requireRedis();
      const deletionService = createDeletionService(repo, storage, coordinator);

      if (!deletionService) {
        throw repositoryUnavailable();
      }

      const deleted = await deletionService.deleteKnowledgeBase({
        knowledgeBaseId,
        deletedAt: new Date().toISOString(),
        cursorTtlSeconds: config.pagination.cursorTtlSeconds
      });

      if (!deleted) {
        throw notFound();
      }

      await dispatchWebhookEvent({
        eventType: "knowledge_base.deleted",
        payload: { knowledgeBaseId }
      }).catch(() => undefined);

      return { deleted: true, knowledgeBaseId };
    },
    async uploadMarkdown(input: {
      knowledgeBaseId: string;
      files: File[];
    }) {
      const repo = requireRepositories();

      if (!repo.files?.createSourceFiles || !repo.files.getSourceFile || !repo.workerJobs) {
        throw repositoryUnavailable();
      }

      const knowledgeBase = await repo.knowledgeBases.getKnowledgeBase(input.knowledgeBaseId);

      if (!knowledgeBase) {
        throw notFound();
      }

      if (input.files.length === 0) {
        throw validationError("At least one Markdown file is required.", { field: "files" });
      }
      const uploadGeneration = await resolveUploadGenerationSettings({
        config,
        runtimeSettings: services.runtimeSettings
      });

      if (input.files.length > uploadGeneration.maxFiles) {
        throw payloadTooLarge("Too many files were uploaded.");
      }

      if (input.files.some((file) => !file.name.toLowerCase().endsWith(".md"))) {
        throw validationError("Only Markdown .md files are accepted.", { field: "files" });
      }

      const loadedFiles = await readLoadedFiles(input.files);
      const totalBytes = loadedFiles.reduce((sum, file) => sum + file.bytes.byteLength, 0);

      if (totalBytes > uploadGeneration.maxBytes) {
        throw payloadTooLarge("Uploaded files exceed the byte limit.");
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

      const sourceFileIds = await acceptUploadSourceFiles({
        files: loadedFiles,
        storageConcurrency: uploadGeneration.storageConcurrency,
        knowledgeBaseId: knowledgeBase.id,
        storage,
        createSourceFiles: repo.files.createSourceFiles
      });
      const sourceFiles = (
        await Promise.all(
          sourceFileIds.map((sourceFileId) =>
            repo.files?.getSourceFile?.({
              knowledgeBaseId: knowledgeBase.id,
              sourceFileId
            })
          )
        )
      ).filter(isDefined);

      for (const sourceFileId of sourceFileIds) {
        const generatedAt = new Date().toISOString();
        await dispatchWebhookEvent({
          eventType: "source_file.accepted",
          payload: {
            knowledgeBaseId: knowledgeBase.id,
            sourceFileId
          },
          createdAt: generatedAt
        }).catch(() => undefined);
      }

      await enqueueSourceFileProcessingJobs({
        repositories: repo,
        sourceFileIds,
        knowledgeBaseId: knowledgeBase.id,
        reason: "upload",
        config,
        worker: (await services.runtimeSettings?.getSnapshot())?.worker
      });

      return {
        knowledgeBaseId: knowledgeBase.id,
        files: sourceFiles.map((file) => toDeveloperSourceFile(file))
      };
    },
    async listSourceFiles(input: {
      knowledgeBaseId: string;
      limit: number;
      cursor: string | null;
      filters: SourceFileListFilters;
    }) {
      const repo = requireRepositories();

      if (!repo.files?.listSourceFiles) {
        throw repositoryUnavailable();
      }

      const knowledgeBase = await requireKnowledgeBase(repo, input.knowledgeBaseId);
      const scope = `developer-openapi:${createSourceFileCursorScope(knowledgeBase.id, input.filters)}`;
      const redisCoordinator = requireRedis();
      const repositoryCursor = await readCursor(redisCoordinator, scope, input.cursor);
      const cacheId = createPageResponseCacheId({
        cursorToken: input.cursor,
        limit: input.limit
      });
      const cachedResponse = await readPageResponseCache<{
        items: ReturnType<typeof toDeveloperSourceFile>[];
        nextCursor: string | null;
      }>({
        redis: redisCoordinator,
        scope,
        cacheId,
        invalidationScopes: [`developer-openapi:source-files:${input.knowledgeBaseId}`]
      });

      if (cachedResponse) {
        return cachedResponse;
      }

      const page = await repo.files.listSourceFiles({
        knowledgeBaseId: knowledgeBase.id,
        limit: input.limit,
        cursor: repositoryCursor,
        ...input.filters
      });
      const generatedOutputs = await readGeneratedOutputsForSourceFilesSafely({
        repositories: repo,
        knowledgeBase,
        sourceFiles: page.items
      });

      const response = await pageResponse(
        page,
        scope,
        config.pagination.cursorTtlSeconds,
        redisCoordinator,
        (file) => toDeveloperSourceFile(file, generatedOutputs.get(file.id) ?? null)
      );
      await writePageResponseCache({
        redis: redisCoordinator,
        scope,
        cacheId,
        value: response
      });

      return response;
    },
    async deleteSourceFileTasks(input: { knowledgeBaseId: string; sourceFileIds: string[] }) {
      const repo = requireRepositories();
      const coordinator = requireRedis();
      const deletionService = createSourceFileTaskDeletionService(repo, storage, coordinator);

      if (!deletionService) {
        throw repositoryUnavailable();
      }

      const knowledgeBase = await requireKnowledgeBase(repo, input.knowledgeBaseId);
      const result = await deletionService.deleteTasks({
        knowledgeBaseId: knowledgeBase.id,
        sourceFileIds: input.sourceFileIds,
        deletedAt: new Date().toISOString(),
        cursorTtlSeconds: config.pagination.cursorTtlSeconds
      });

      if (!result) {
        throw notFound();
      }

      return toDeveloperSourceFileTaskDeletionResponse(result);
    },
    async getSourceFile(input: {
      knowledgeBaseId: string;
      sourceFileId: string;
    }) {
      const repo = requireRepositories();

      if (!repo.files?.getSourceFile) {
        throw repositoryUnavailable();
      }

      const knowledgeBase = await requireKnowledgeBase(repo, input.knowledgeBaseId);
      const sourceFile = await repo.files.getSourceFile({
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFileId: input.sourceFileId
      });

      if (!sourceFile) {
        throw notFound();
      }

      const generatedOutputs = await readGeneratedOutputsForSourceFilesSafely({
        repositories: repo,
        knowledgeBase,
        sourceFiles: [sourceFile]
      });

      return {
        file: toDeveloperSourceFile(sourceFile, generatedOutputs.get(sourceFile.id) ?? null)
      };
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
        cursor: await readCursor(requireRedis(), scope, input.cursor)
      });

      return pageResponse(
        page,
        scope,
        config.pagination.cursorTtlSeconds,
        requireRedis(),
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
      const queuedFile =
        (await repo.files.getSourceFile({
          knowledgeBaseId: knowledgeBase.id,
          sourceFileId: sourceFile.id
        })) ?? sourceFile;

      await enqueueSourceFileProcessingJobs({
        repositories: repo,
        sourceFileIds: [sourceFile.id],
        knowledgeBaseId: knowledgeBase.id,
        reason: "retry",
        config,
        worker: (await services.runtimeSettings?.getSnapshot())?.worker
      });

      return {
        file: toDeveloperSourceFile(queuedFile)
      };
    },
    async listTree(input: {
      knowledgeBaseId: string;
      parentPath: string;
      entryType: BundleTreeEntryRecord["entryType"] | null;
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

      const scope = createBundleTreeCursorScope({
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        parentPath: input.parentPath,
        entryType: input.entryType,
        scopePrefix: "developer-openapi:tree"
      });
      const redisCoordinator = requireRedis();
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
      limit: number;
      cursor: string | null;
    }) {
      const repo = requireRepositories();

      if (!repo.files?.searchBundleFiles || !repo.files.countBundleFileSearchDocuments) {
        throw repositoryUnavailable();
      }

      const knowledgeBase = await requireKnowledgeBase(repo, input.knowledgeBaseId);
      const normalizedQuery = normalizeGeneratedFileSearchQuery(input.query);
      const queryContext = createFileSearchQueryContext(input, normalizedQuery);
      const nextRequestTemplates = createFileSearchNextRequestTemplates(knowledgeBase.id);

      if (!knowledgeBase.activeReleaseId) {
        return createUnavailableSearchResponse(queryContext, nextRequestTemplates);
      }

      const indexedCount = await repo.files.countBundleFileSearchDocuments({
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId
      });

      if (indexedCount === 0) {
        return createUnavailableSearchResponse(queryContext, nextRequestTemplates);
      }

      const scope = createDeveloperFileSearchCursorScope({
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        query: normalizedQuery,
        scope: input.scope,
        fileKind: input.fileKind
      });
      const redisCoordinator = requireRedis();
      const repositoryCursor = await readCursor(redisCoordinator, scope, input.cursor);
      const cacheId = createPageResponseCacheId({
        cursorToken: input.cursor,
        limit: input.limit,
        extra: `file-search-response-v3:${normalizedQuery}:${input.scope}:${input.fileKind ?? "all"}`
      });
      const cachedResponse = await readPageResponseCache<DeveloperFileSearchResponse>({
        redis: redisCoordinator,
        scope,
        cacheId,
        invalidationScopes: [
          `developer-openapi:file-search:${knowledgeBase.id}:${knowledgeBase.activeReleaseId}`
        ]
      });

      if (cachedResponse) {
        return cachedResponse;
      }

      const page = await repo.files.searchBundleFiles({
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        query: normalizedQuery,
        scope: input.scope,
        fileKind: input.fileKind,
        limit: input.limit,
        cursor: repositoryCursor
      });
      const response = await pageResponse<BundleFileSearchResultRecord, ReturnType<typeof toDeveloperFileSearchResult>>(
        page,
        scope,
        config.pagination.cursorTtlSeconds,
        redisCoordinator,
        toDeveloperFileSearchResult
      );
      const searchResponse: DeveloperFileSearchResponse = {
        query: queryContext,
        ...response,
        searchStatus: response.items.length > 0 ? "ok" : "no_candidates",
        resultSummary: createFileSearchResultSummary(
          response.items.length,
          Boolean(response.nextCursor),
          response.items.length > 0 ? "ok" : "no_candidates"
        ),
        nextRequestTemplates,
        ...(response.items.length > 0 ? {} : noCandidateSearchHints())
      };

      await writePageResponseCache({
        redis: redisCoordinator,
        scope,
        cacheId,
        value: searchResponse
      });

      return searchResponse;
    },
    async getFileById(input: { knowledgeBaseId: string; fileId: string }) {
      const repo = requireRepositories();
      const resolved = await resolveFileById(repo, input);

      if (resolved.kind === "source") {
        const knowledgeBase = await requireKnowledgeBase(repo, input.knowledgeBaseId);
        const generatedOutputs = await readGeneratedOutputsForSourceFilesSafely({
          repositories: repo,
          knowledgeBase,
          sourceFiles: [resolved.file]
        });

        return {
          file: toDeveloperSourceFileDetail(
            resolved.file,
            generatedOutputs.get(resolved.file.id) ?? null
          )
        };
      }

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

      if (!repo.graph?.listGraphNeighborhood) {
        throw repositoryUnavailable();
      }

      const resolved = await resolveFileById(repo, input);
      const sourceFileId =
        resolved.kind === "bundle" ? resolved.file.sourceFileId : resolved.file.id;

      if (!sourceFileId) {
        throw conflict("Only source-backed files can return related files.");
      }

      const scope = `developer-openapi:related:${input.knowledgeBaseId}:${sourceFileId}`;
      const page = await repo.graph.listGraphNeighborhood({
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFileId,
        limit: input.limit,
        cursor: await readCursor(requireRedis(), scope, input.cursor)
      });

      return {
        fileId: input.fileId,
        sourceFileId,
        items: page.items.map(toDeveloperRelatedFile),
        nextCursor: await writeCursor(
          requireRedis(),
          scope,
          page.nextCursor,
          config.pagination.cursorTtlSeconds
        )
      };
    },
    async getFileContentById(input: { knowledgeBaseId: string; fileId: string }) {
      const resolved = await resolveFileById(requireRepositories(), input);

      if (resolved.kind !== "bundle") {
        throw conflict("File content is not available until publication completes.");
      }

      const content = await readGeneratedObjectText(storage, resolved.file.objectKey, config);

      if (content === null) {
        throw notFound();
      }

      return {
        file: toDeveloperBundleFile(resolved.file, resolved.source),
        content
      };
    },
    async getFileContentByPath(input: { knowledgeBaseId: string; path: string }) {
      const repo = requireRepositories();

      assertSafeLogicalPath(input.path, false);
      const knowledgeBase = await requireKnowledgeBase(repo, input.knowledgeBaseId);

      if (!knowledgeBase.activeReleaseId || !repo.files?.getBundleFile) {
        throw notFound();
      }

      const file = await repo.files.getBundleFile({
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        logicalPath: input.path
      });

      if (!file) {
        throw notFound();
      }

      const content = await readGeneratedObjectText(storage, file.objectKey, config);

      if (content === null) {
        throw notFound();
      }

      return {
        file: toDeveloperBundleFile(file, await readSourceForBundle(repo, file)),
        content
      };
    },
    async deleteFileById(input: {
      knowledgeBaseId: string;
      fileId: string;
    }) {
      const resolved = await resolveFileById(requireRepositories(), input);

      if (resolved.kind !== "bundle") {
        throw validationError("Only generated source-backed files can be deleted.");
      }

      return deleteBundleFile(resolved.file);
    },
    async deleteFileByPath(input: {
      knowledgeBaseId: string;
      path: string;
    }) {
      const repo = requireRepositories();
      const knowledgeBase = await requireKnowledgeBase(repo, input.knowledgeBaseId);

      assertSafeLogicalPath(input.path, false);

      if (!knowledgeBase.activeReleaseId || !repo.files?.getBundleFile) {
        throw notFound();
      }

      const file = await repo.files.getBundleFile({
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        logicalPath: input.path
      });

      if (!file) {
        throw notFound();
      }

      return deleteBundleFile(file);
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
        cursor: await readCursor(requireRedis(), scope, input.cursor)
      });

      return pageResponse(page, scope, config.pagination.cursorTtlSeconds, requireRedis(), toDeveloperWebhook);
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
        cursor: await readCursor(requireRedis(), scope, input.cursor)
      });

      return pageResponse(
        page,
        scope,
        config.pagination.cursorTtlSeconds,
        requireRedis(),
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

  async function deleteBundleFile(file: BundleFileRecord) {
    const repo = requireRepositories();
    const coordinator = requireRedis();
    const deletionService = createDeletionService(repo, storage, coordinator);

    if (!deletionService || file.fileKind !== "page" || !file.sourceFileId) {
      throw validationError("Only generated source-backed files can be deleted.");
    }

    const deletedAt = new Date().toISOString();
    const uploadGeneration = await resolveUploadGenerationSettings({
      config,
      runtimeSettings: services.runtimeSettings
    });
    const result = await deletionService.deleteSourcePage({
      knowledgeBaseId: file.knowledgeBaseId,
      logicalPath: file.logicalPath,
      deletedAt,
      generatedAt: deletedAt,
      batchSize: uploadGeneration.generationBatchSize,
      cursorTtlSeconds: config.pagination.cursorTtlSeconds,
      fileProcessingConcurrency: uploadGeneration.fileProcessingConcurrency,
      okfLog: config.okf?.log,
      publication: config.publication
    });

    if (!result.ok) {
      throw result.reason === "not_deletable"
        ? validationError("File is not deletable.")
        : notFound();
    }

    await dispatchWebhookEvent({
      eventType: "file.deleted",
      payload: {
        knowledgeBaseId: file.knowledgeBaseId,
        fileId: file.id,
        sourceFileId: file.sourceFileId,
        path: file.logicalPath,
        publicationQueued: result.publicationQueued
      }
    }).catch(() => undefined);

    return {
      knowledgeBaseId: file.knowledgeBaseId,
      deleted: true,
      publicationQueued: result.publicationQueued,
      file: toDeveloperBundleFile(file, await readSourceForBundle(repo, file))
    };
  }

  async function dispatchWebhookEvent(event: WebhookEvent): Promise<void> {
    const dispatcher = createWebhookDispatcher({ repositories, redis });
    await dispatcher?.dispatch(event);
  }

  async function resolveFileById(
    repo: AdminRepositories,
    input: { knowledgeBaseId: string; fileId: string }
  ): Promise<
    | { kind: "bundle"; file: BundleFileRecord; source: SourceFileRecord | null }
    | { kind: "source"; file: SourceFileRecord }
  > {
    const knowledgeBase = await requireKnowledgeBase(repo, input.knowledgeBaseId);

    if (knowledgeBase.activeReleaseId) {
      const bundleFile = await repo.files?.getBundleFileById?.({
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        fileId: input.fileId
      });

      if (bundleFile) {
        return {
          kind: "bundle",
          file: bundleFile,
          source: await readSourceForBundle(repo, bundleFile)
        };
      }
    }

    const source = await repo.files?.getSourceFile?.({
      knowledgeBaseId: input.knowledgeBaseId,
      sourceFileId: input.fileId
    });

    if (!source) {
      throw notFound();
    }

    return { kind: "source", file: source };
  }
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
  nextRequestTemplates: DeveloperFileSearchNextRequestTemplates
): DeveloperFileSearchResponse {
  return {
    query,
    items: [],
    nextCursor: null,
    searchStatus: "index_unavailable",
    resultSummary: createFileSearchResultSummary(0, false, "index_unavailable"),
    nextRequestTemplates,
    message:
      "Generated file search is not available for the active release. Continue with index.md and file-tree reads.",
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
      "Try title, path, jurisdiction, product, or domain-specific terms from the question."
    ]
  };
}

function createFileSearchQueryContext(
  input: {
    query: string;
    scope: GeneratedFileSearchScope;
    fileKind: BundleFileKind | null;
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
    limit: input.limit,
    cursorProvided: Boolean(input.cursor)
  };
}

function createFileSearchNextRequestTemplates(
  knowledgeBaseId: string
): DeveloperFileSearchNextRequestTemplates {
  const base = `/openapi/v1/knowledge-bases/${knowledgeBaseId}`;

  return {
    searchAgain: `${base}/files/search?query={query}`,
    listTree: `${base}/tree?parentPath={parentPath}`,
    readIndex: `${base}/files/content?path=index.md`,
    fileDetailById: `${base}/files/{generatedFileId}`,
    fileContentById: `${base}/files/{generatedFileId}/content`,
    fileContentByPath: `${base}/files/content?path={generatedFilePath}`,
    relatedFilesById: `${base}/files/{generatedFileId}/related`,
    sourceFileStatusById: `${base}/source-files/{sourceFileId}`,
    sourceFileEventsById: `${base}/source-files/{sourceFileId}/events`
  };
}

function createFileSearchResultSummary(
  resultCount: number,
  hasMore: boolean,
  status: DeveloperFileSearchResponse["searchStatus"]
): DeveloperFileSearchResultSummary {
  return {
    resultCount,
    hasMore,
    sort: ["score desc", "path asc", "fileId asc"],
    meaning:
      status === "ok"
        ? "Candidates matched the query. Read candidate content and related files before answering."
        : status === "no_candidates"
          ? "No generated files matched this query. Relevant data may still exist under different terms."
          : "Generated file search is not available for the active release. Use tree and index reads to continue exploration."
  };
}

async function readLoadedFiles(files: File[]): Promise<LoadedUploadFile[]> {
  return Promise.all(
    files.map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());

      return {
        fileName: file.name,
        bytes,
        content: new TextDecoder().decode(bytes)
      };
    })
  );
}

async function readCursor(
  redis: RedisCoordinator,
  scope: string,
  cursor: string | null
): Promise<string | null> {
  if (!cursor) {
    return null;
  }

  const value = await redis.getPaginationCursor<string>(scope, cursor);

  if (!value) {
    throw validationError("Pagination cursor is invalid or expired.", { field: "cursor" });
  }

  return value;
}

async function writeCursor(
  redis: RedisCoordinator,
  scope: string,
  cursor: string | null,
  ttlSeconds: number
): Promise<string | null> {
  if (!cursor) {
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
  redis: RedisCoordinator,
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
    isAllowedGeneratedPath(path) ||
    (allowDirectory && isSafeGeneratedDirectoryPath(path))
  ) {
    return;
  }

  throw validationError("Logical path is not supported.", { field: "path" });
}

function isAllowedGeneratedPath(path: string): boolean {
  return (
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").includes("..") &&
    !path.includes("//") &&
    !path.startsWith("sources/") &&
    (path === "index.md" ||
      path === "log.md" ||
      path === "schema.md" ||
      /^pages\/[^/].*\.md$/u.test(path) ||
      /^_index\/[^/]+\.json$/u.test(path) ||
      /^_index\/(?:manifest|search|links)\/[0-9]{6}\.jsonl$/u.test(path) ||
      isAllowedGraphPath(path))
  );
}

function isAllowedGraphPath(path: string): boolean {
  return (
    path === "_graph/index.md" ||
    path === "_graph/manifest.json" ||
    path === "_graph/nodes.jsonl" ||
    /^_graph\/nodes\/[0-9]{4}\.jsonl$/u.test(path) ||
    /^_graph\/edges\/[0-9]{4}\.jsonl$/u.test(path) ||
    /^_graph\/by-file\/[^/]+\.json$/u.test(path)
  );
}

function isSafeGeneratedDirectoryPath(path: string): boolean {
  const parts = path.split("/");

  return (
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("//") &&
    !path.startsWith("sources/") &&
    parts.every((part) => part !== "" && part !== "." && part !== ".." && !part.includes(".."))
  );
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

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function toDeveloperSourceFileTaskDeletionResponse(result: SourceFileTaskDeletionResponse) {
  return {
    results: result.results.map((item) => ({
      sourceFileId: item.sourceFileId,
      result: item.status,
      ...(item.reason ? { reason: item.reason } : {}),
      ...(item.generatedFileId ? { generatedFileId: item.generatedFileId } : {}),
      ...(item.generatedFilePath ? { generatedFilePath: item.generatedFilePath } : {})
    })),
    summary: result.summary
  };
}
