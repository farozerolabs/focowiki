import type { OpenAIResponsesClient } from "@focowiki/okf";
import { randomUUID } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { type RuntimeConfig } from "../config.js";
import type { AdminSessionManager } from "../auth/session.js";
import type {
  AdminRepositories,
  GeneratedSourceFileOutputRecord,
  SourceFileRecord
} from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import { acceptUploadSourceFiles } from "./source-file-upload.js";
import { readBoundedUploadFiles } from "./upload-processor-utils.js";
import {
  hasDuplicateUploadFileNames,
  hasExistingSourceFileName,
  hasUnsafeUploadFileNames,
  isUploadFile
} from "./upload-input.js";
import {
  StorageObjectTooLargeError,
  type StorageAdapter
} from "../storage/s3.js";
import { createDeletionService } from "./deletion-service.js";
import { readGeneratedOutputsForSourceFilesSafely } from "./source-file-generated-output.js";
import {
  assertSourceFileQueueCapacity,
  enqueueSourceFileProcessingJobs,
  WorkerQueueBackpressureError
} from "../worker/source-file-jobs.js";
import {
  adminUnauthorized,
  createAdminAuthMiddleware,
  createAdminWriteProtectionMiddleware,
  limitAdminLoginRequest,
  limitAdminUploadRequest,
  missingSessionBackend,
  recordAdminAudit,
  registerAdminSecurityMiddlewares
} from "./security.js";
import {
  toAdminBundleFile,
  toAdminRelease,
  toAdminSourceFile,
  toAdminSourceFileEvent
} from "./serializers.js";
import { registerAdminFileTreeRoutes } from "./file-tree-routes.js";
import { registerAdminFileTreeSearchRoutes } from "./file-tree-search-routes.js";
import { registerAdminKnowledgeBaseListRoutes } from "./knowledge-base-list-routes.js";
import { registerAdminOpenApiKeyRoutes } from "./openapi-key-routes.js";
import { readPageLimit } from "./pagination.js";
import {
  createPageResponseCacheId,
  readPageResponseCache,
  writePageResponseCache
} from "../page-response-cache.js";
import { registerAdminProcessingSummaryRoutes } from "./processing-summary-routes.js";
import { registerAdminPublicUrlRoutes } from "./public-url-routes.js";
import { registerAdminSourceFileRetryRoutes } from "./source-file-retry-routes.js";
import { registerAdminSourceFileTaskDeletionRoutes } from "./source-file-task-deletion-routes.js";
import { createSourceFileCursorScope } from "./source-file-list-filter-signature.js";
import {
  readSourceFileListFiltersFromQuery,
  type SourceFileListFilterErrorCode
} from "./source-file-list-filters.js";

export type AdminApiServices = {
  config: RuntimeConfig;
  storage: StorageAdapter;
  modelClient: OpenAIResponsesClient | null;
  sessionManager: AdminSessionManager | null;
  redis: RedisCoordinator | null;
  repositories: AdminRepositories | null;
};

export function registerAdminApiRoutes(app: Hono, services: AdminApiServices): void {
  const { config, storage, sessionManager, redis, repositories } = services;
  const requireAuth = createAdminAuthMiddleware({
    config,
    sessionManager,
    redis,
    repositories
  });
  const requireWriteProtection = createAdminWriteProtectionMiddleware({
    config,
    repositories
  });

  registerAdminSecurityMiddlewares(app, {
    config,
    redis,
    repositories
  });

  registerAdminOpenApiKeyRoutes(
    app,
    {
      config,
      redis,
      repositories
    },
    {
      requireAuth,
      requireWriteProtection
    }
  );
  registerAdminSourceFileRetryRoutes(
    app,
    { config, redis, repositories },
    {
      requireAuth,
      requireWriteProtection
    }
  );
  registerAdminSourceFileTaskDeletionRoutes(
    app,
    { config, storage, redis, repositories },
    {
      requireAuth,
      requireWriteProtection
    }
  );
  registerAdminFileTreeRoutes(
    app,
    { config, redis, repositories },
    {
      requireAuth
    }
  );
  registerAdminFileTreeSearchRoutes(app, { config, redis, repositories }, { requireAuth });
  registerAdminProcessingSummaryRoutes(
    app,
    { repositories },
    {
      requireAuth
    }
  );
  registerAdminPublicUrlRoutes(
    app,
    { config, repositories },
    {
      requireAuth
    }
  );
  registerAdminKnowledgeBaseListRoutes(
    app,
    { config, redis, repositories },
    {
      requireAuth
    }
  );

  app.post("/admin/api/login", async (context) => {
    if (containsCredentialQuery(context.req.raw.url)) {
      return context.json(
        {
          error: {
            code: "CREDENTIALS_IN_URL_NOT_ALLOWED"
          }
        },
        400
      );
    }

    if (!sessionManager) {
      return missingSessionBackend(context);
    }

    const body = await readJsonBody(context.req.raw);
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";
    const loginLimited = await limitAdminLoginRequest({
      config,
      redis,
      repositories,
      context,
      username
    });

    if (loginLimited) {
      return loginLimited;
    }

    if (!sessionManager.authenticate({ username, password })) {
      await recordAdminAudit({
        repositories,
        config,
        context,
        eventType: "admin_login",
        result: "failure",
        errorCode: "UNAUTHORIZED",
        username: username || null
      });
      return adminUnauthorized(context, "auth.invalidCredentials");
    }

    context.header("set-cookie", await sessionManager.createSessionCookie(username));
    await recordAdminAudit({
      repositories,
      config,
      context,
      eventType: "admin_login",
      result: "success",
      username
    });
    return context.json({ authenticated: true });
  });

  app.get("/admin/api/session", requireAuth, (context) =>
    context.json({ authenticated: true })
  );

  app.post("/admin/api/logout", requireAuth, requireWriteProtection, async (context) => {
    if (!sessionManager) {
      return missingSessionBackend(context);
    }

    await sessionManager.clearSessionFromCookieHeader(context.req.header("cookie"));
    context.header("set-cookie", sessionManager.createClearedSessionCookie());
    await recordAdminAudit({
      repositories,
      config,
      context,
      eventType: "admin_logout",
      result: "success"
    });
    return context.json({ authenticated: false });
  });

  app.post("/admin/api/knowledge-bases", requireAuth, requireWriteProtection, async (context) => {
    if (!repositories) {
      return missingRepositoryBackend(context);
    }

    const input = readKnowledgeBaseCreateInput(await readJsonBody(context.req.raw));

    if (!input) {
      return context.json(
        {
          error: {
            code: "INVALID_KNOWLEDGE_BASE",
            messageKey: "errors.invalidKnowledgeBase"
          }
        },
        400
      );
    }

    const knowledgeBase = await repositories.knowledgeBases.createKnowledgeBase(input);
    return context.json({ knowledgeBase }, 201);
  });

  app.get(
    "/admin/api/knowledge-bases/:knowledgeBaseId",
    requireAuth,
    async (context) => {
      if (!repositories) {
        return missingRepositoryBackend(context);
      }

      const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(
        context.req.param("knowledgeBaseId")
      );

      if (!knowledgeBase) {
        return notFound(context);
      }

      return context.json({ knowledgeBase });
    }
  );

  app.delete(
    "/admin/api/knowledge-bases/:knowledgeBaseId",
    requireAuth,
    requireWriteProtection,
    async (context) => {
      if (!repositories || !redis) {
        return missingRepositoryBackend(context);
      }

      const deletionService = createDeletionService(repositories, storage, redis);

      if (!deletionService) {
        return missingRepositoryBackend(context);
      }

      const deleted = await deletionService.deleteKnowledgeBase({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        deletedAt: new Date().toISOString(),
        cursorTtlSeconds: config.pagination.cursorTtlSeconds
      });

      if (!deleted) {
        return notFound(context);
      }

      return context.json({ deleted: true });
    }
  );

  app.get(
    "/admin/api/knowledge-bases/:knowledgeBaseId/files/detail",
    requireAuth,
    async (context) => {
      if (!repositories?.files || !redis) {
        return missingRepositoryBackend(context);
      }

      const logicalPath = context.req.query("path");

      if (!logicalPath) {
        return notFound(context);
      }

      const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(
        context.req.param("knowledgeBaseId")
      );

      if (!knowledgeBase?.activeReleaseId) {
        return notFound(context);
      }

      const file = await repositories.files.getBundleFile({
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        logicalPath
      });

      if (!file) {
        return notFound(context);
      }

      const content = await readGeneratedObjectText(storage, file.objectKey, config);

      if (content instanceof Response) {
        return content;
      }

      if (content === null) {
        return notFound(context);
      }

      return context.json({
        file: toAdminBundleFile(file),
        content,
        readOnly: true
      });
    }
  );

  app.delete(
    "/admin/api/knowledge-bases/:knowledgeBaseId/files/detail",
    requireAuth,
    requireWriteProtection,
    async (context) => {
      if (!repositories?.files || !redis) {
        return missingRepositoryBackend(context);
      }

      const logicalPath = context.req.query("path");

      if (!logicalPath) {
        return notFound(context);
      }

      const deletionService = createDeletionService(repositories, storage, redis);

      if (!deletionService) {
        return missingRepositoryBackend(context);
      }

      const deletedAt = new Date().toISOString();
      const result = await deletionService.deleteSourcePage({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        logicalPath,
        deletedAt,
        generatedAt: deletedAt,
        batchSize: config.upload.generationBatchSize,
        cursorTtlSeconds: config.pagination.cursorTtlSeconds,
        fileProcessingConcurrency: config.upload.fileProcessingConcurrency,
        okfLog: config.okf?.log,
        publication: config.publication
      });

      if (!result.ok) {
        return result.reason === "not_deletable" ? fileNotDeletable(context) : notFound(context);
      }

      return context.json(
        {
          deleted: true,
          publicationQueued: result.publicationQueued
        },
        200
      );
    }
  );

  app.get(
    "/admin/api/knowledge-bases/:knowledgeBaseId/releases",
    requireAuth,
    async (context) => {
      if (!repositories?.files || !redis) {
        return missingRepositoryBackend(context);
      }

      const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(
        context.req.param("knowledgeBaseId")
      );

      if (!knowledgeBase) {
        return notFound(context);
      }

      const limit = readPageLimit(context.req.query("limit"), config);

      if (!limit) {
        return invalidPagination(context);
      }

      const cursorScope = `releases:${knowledgeBase.id}`;
      const cursorToken = context.req.query("cursor") ?? null;
      const repositoryCursor = cursorToken
        ? await redis.getPaginationCursor<string>(cursorScope, cursorToken)
        : null;

      if (cursorToken && !repositoryCursor) {
        return invalidPagination(context);
      }

      const page = await repositories.files.listReleases({
        knowledgeBaseId: knowledgeBase.id,
        limit,
        cursor: repositoryCursor
      });
      const nextCursor = await writeOpaqueCursor({
        redis,
        scope: cursorScope,
        cursor: page.nextCursor,
        ttlSeconds: config.pagination.cursorTtlSeconds
      });

      return context.json({
        items: page.items.map(toAdminRelease),
        nextCursor
      });
    }
  );

  app.get(
    "/admin/api/knowledge-bases/:knowledgeBaseId/bundle-files",
    requireAuth,
    async (context) => {
      if (!repositories?.files || !redis) {
        return missingRepositoryBackend(context);
      }

      const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(
        context.req.param("knowledgeBaseId")
      );

      if (!knowledgeBase?.activeReleaseId) {
        return notFound(context);
      }

      const limit = readPageLimit(context.req.query("limit"), config);

      if (!limit) {
        return invalidPagination(context);
      }

      const cursorScope = `bundle-files:${knowledgeBase.id}:${knowledgeBase.activeReleaseId}`;
      const cursorToken = context.req.query("cursor") ?? null;
      const repositoryCursor = cursorToken
        ? await redis.getPaginationCursor<string>(cursorScope, cursorToken)
        : null;

      if (cursorToken && !repositoryCursor) {
        return invalidPagination(context);
      }

      const page = await repositories.files.listBundleFiles({
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        limit,
        cursor: repositoryCursor
      });
      const nextCursor = await writeOpaqueCursor({
        redis,
        scope: cursorScope,
        cursor: page.nextCursor,
        ttlSeconds: config.pagination.cursorTtlSeconds
      });

      return context.json({
        items: page.items.map(toAdminBundleFile),
        nextCursor
      });
    }
  );

  app.get(
    "/admin/api/knowledge-bases/:knowledgeBaseId/source-files",
    requireAuth,
    async (context) => {
      if (!repositories?.files || !redis) {
        return missingRepositoryBackend(context);
      }

      const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(
        context.req.param("knowledgeBaseId")
      );

      if (!knowledgeBase) {
        return notFound(context);
      }

      const limit = readPageLimit(context.req.query("limit"), config);

      if (!limit) {
        return invalidPagination(context);
      }

      const filters = readSourceFileListFiltersFromQuery((name) => context.req.query(name));

      if (!filters.ok) {
        return invalidSourceFileFilter(context, filters.code);
      }

      const cursorToken = context.req.query("cursor") ?? null;
      const cursorScope = createSourceFileCursorScope(knowledgeBase.id, filters.filters);
      const repositoryCursor = cursorToken
        ? await redis.getPaginationCursor<string>(cursorScope, cursorToken)
        : null;

      if (cursorToken && !repositoryCursor) {
        return invalidPagination(context);
      }

      const cacheId = createPageResponseCacheId({
        cursorToken,
        limit
      });
      const cachedResponse = await readPageResponseCache<{
        items: ReturnType<typeof toAdminSourceFile>[];
        nextCursor: string | null;
        refreshAfterMs: number;
      }>({
        redis,
        scope: cursorScope,
        cacheId,
        invalidationScopes: [`source-files:${knowledgeBase.id}`]
      });

      if (cachedResponse) {
        return context.json(cachedResponse);
      }

      const page = await repositories.files.listSourceFiles({
        knowledgeBaseId: knowledgeBase.id,
        limit,
        cursor: repositoryCursor,
        ...filters.filters
      });
      const generatedOutputs = await readGeneratedOutputsForSourceFilesSafely({
        repositories,
        knowledgeBase,
        sourceFiles: page.items
      });
      const items = page.items.map((file) =>
        toAdminSourceFile(file, null, generatedOutputs.get(file.id) ?? null)
      );
      const nextCursor = await writeOpaqueCursor({
        redis,
        scope: cursorScope,
        cursor: page.nextCursor,
        ttlSeconds: config.pagination.cursorTtlSeconds
      });

      const responseBody = {
        items,
        nextCursor,
        refreshAfterMs: readSourceFileRefreshAfterMs(page.items)
      };

      await writePageResponseCache({
        redis,
        scope: cursorScope,
        cacheId,
        value: responseBody,
        refreshAfterMs: responseBody.refreshAfterMs
      });

      return context.json(responseBody);
    }
  );

  app.get(
    "/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId",
    requireAuth,
    async (context) => {
      if (!repositories?.files?.getSourceFile || !repositories.files.listSourceFileEvents || !redis) {
        return missingRepositoryBackend(context);
      }

      const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(
        context.req.param("knowledgeBaseId")
      );

      if (!knowledgeBase) {
        return notFound(context);
      }

      const sourceFile = await repositories.files.getSourceFile({
        knowledgeBaseId: knowledgeBase.id,
        sourceFileId: context.req.param("sourceFileId")
      });

      if (!sourceFile) {
        return notFound(context);
      }

      const limit = readPageLimit(context.req.query("limit"), config);

      if (!limit) {
        return invalidPagination(context);
      }

      const cursorToken = context.req.query("cursor") ?? null;
      const cursorScope = `source-file-events:${knowledgeBase.id}:${sourceFile.id}`;
      const repositoryCursor = cursorToken
        ? await redis.getPaginationCursor<string>(cursorScope, cursorToken)
        : null;

      if (cursorToken && !repositoryCursor) {
        return invalidPagination(context);
      }

      const events = await repositories.files.listSourceFileEvents({
        knowledgeBaseId: knowledgeBase.id,
        sourceFileId: sourceFile.id,
        limit,
        cursor: repositoryCursor
      });
      const nextCursor = await writeOpaqueCursor({
        redis,
        scope: cursorScope,
        cursor: events.nextCursor,
        ttlSeconds: config.pagination.cursorTtlSeconds
      });

      return context.json({
        file: await readAdminSourceFileWithGraphSummary({
          repositories,
          knowledgeBaseId: knowledgeBase.id,
          sourceFile,
          generatedOutput:
            (
              await readGeneratedOutputsForSourceFilesSafely({
                repositories,
                knowledgeBase,
                sourceFiles: [sourceFile]
              })
            ).get(sourceFile.id) ?? null
        }),
        events: {
          items: events.items.map(toAdminSourceFileEvent),
          nextCursor
        }
      });
    }
  );

  app.post(
    "/admin/api/knowledge-bases/:knowledgeBaseId/uploads",
    requireAuth,
    requireWriteProtection,
    async (context) => {
      if (
         !repositories?.files?.createSourceFiles ||
         !repositories.files.getSourceFile ||
         !repositories.workerJobs ||
         !redis
       ) {
         return missingRepositoryBackend(context);
       }

      const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(
        context.req.param("knowledgeBaseId")
      );

      if (!knowledgeBase) {
        return notFound(context);
      }

      const uploadLimited = await limitAdminUploadRequest({
        config,
        redis,
        repositories,
        context
      });
      if (uploadLimited) {
        return uploadLimited;
      }
      try {
        await assertSourceFileQueueCapacity({
          repositories,
          knowledgeBaseId: knowledgeBase.id,
          config
        });
      } catch (error) {
        if (error instanceof WorkerQueueBackpressureError) {
          return queueBackpressure(context, error);
        }
        throw error;
      }

      const formData = await context.req.formData();
      const files = formData.getAll("files").filter(isUploadFile);

      if (files.length === 0) {
        return context.json(
          {
            error: {
              code: "NO_UPLOAD_FILES",
              messageKey: "errors.noUploadFiles"
            }
          },
          400
        );
      }

      if (files.length > config.upload.maxFiles) {
        await recordAdminAudit({
          repositories,
          config,
          context,
          eventType: "upload_rejected",
          result: "blocked",
          errorCode: "UPLOAD_FILE_COUNT_LIMIT_EXCEEDED"
        });
        return context.json(
          {
            error: {
              code: "UPLOAD_FILE_COUNT_LIMIT_EXCEEDED",
              messageKey: "errors.uploadFileCountLimit"
            }
          },
          413
        );
      }

      if (hasUnsafeUploadFileNames(files)) {
        return context.json(
          {
            error: {
              code: "UNSUPPORTED_FILE_TYPE",
              messageKey: "errors.uploadMarkdownOnly"
            }
          },
          400
        );
      }

      if (hasDuplicateUploadFileNames(files)) {
        return context.json(
          {
            error: {
              code: "DUPLICATE_UPLOAD_FILE_NAME",
              messageKey: "errors.duplicateUploadFileName"
            }
          },
          400
        );
      }

      if (
        await hasExistingSourceFileName({
          filesRepository: repositories.files,
          knowledgeBaseId: knowledgeBase.id,
          fileNames: files.map((file) => file.name),
          limit: config.pagination.maxPageSize
        })
      ) {
        return context.json(
          {
            error: {
              code: "DUPLICATE_UPLOAD_FILE_NAME",
              messageKey: "errors.duplicateUploadFileName"
            }
          },
          400
        );
      }

      const loadedFiles = await readBoundedUploadFiles(files);
      const totalBytes = loadedFiles.reduce((sum, file) => sum + file.bytes.byteLength, 0);

      if (totalBytes > config.upload.maxBytes) {
        await recordAdminAudit({
          repositories,
          config,
          context,
          eventType: "upload_rejected",
          result: "blocked",
          errorCode: "UPLOAD_BYTE_LIMIT_EXCEEDED"
        });
        return context.json(
          {
            error: {
              code: "UPLOAD_BYTE_LIMIT_EXCEEDED",
              messageKey: "errors.uploadByteLimit"
            }
          },
          413
        );
      }

      const sourceFileIds = await acceptUploadSourceFiles({
        files: loadedFiles,
        storageConcurrency: config.upload.storageConcurrency,
        knowledgeBaseId: knowledgeBase.id,
        storage,
        createSourceFiles: repositories.files.createSourceFiles
      });
      const sourceFiles = (
        await Promise.all(
          sourceFileIds.map((sourceFileId) =>
            repositories.files?.getSourceFile?.({
              knowledgeBaseId: knowledgeBase.id,
              sourceFileId
            })
          )
        )
      ).filter(isDefined);

       await enqueueSourceFileProcessingJobs({
         repositories,
         sourceFileIds,
         knowledgeBaseId: knowledgeBase.id,
         reason: "upload",
         config
       });

      return context.json(
        {
          files: sourceFiles.map((sourceFile) => toAdminSourceFile(sourceFile))
        },
        202
      );
    }
  );
}

async function readAdminSourceFileWithGraphSummary(input: {
  repositories: AdminRepositories;
  knowledgeBaseId: string;
  sourceFile: SourceFileRecord;
  generatedOutput?: GeneratedSourceFileOutputRecord | null;
}) {
  if (!input.repositories.graph?.getGraphSummary) {
    return toAdminSourceFile(input.sourceFile, null, input.generatedOutput ?? null);
  }

  const summary = await input.repositories.graph.getGraphSummary({
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.sourceFile.id,
    limit: 3
  });

  return toAdminSourceFile(input.sourceFile, summary, input.generatedOutput ?? null);
}

async function readGeneratedObjectText(
  storage: StorageAdapter,
  objectKey: string,
  config: RuntimeConfig
): Promise<string | null | Response> {
  try {
    return await storage.getObjectText(objectKey, {
      maxBytes: config.pagination.generatedContentMaxBytes
    });
  } catch (error) {
    if (error instanceof StorageObjectTooLargeError) {
      return new Response(
        JSON.stringify({
          error: {
            code: "GENERATED_CONTENT_TOO_LARGE"
          }
        }),
        {
          status: 413,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    throw error;
  }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = (await request.json()) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function missingRepositoryBackend(context: Parameters<MiddlewareHandler>[0]): Response {
  return context.json(
    {
      error: {
        code: "DATABASE_REPOSITORY_UNAVAILABLE"
      }
    },
    503
  );
}

function invalidPagination(context: Parameters<MiddlewareHandler>[0]): Response {
  return context.json(
    {
      error: {
        code: "INVALID_PAGINATION"
      }
    },
    400
  );
}

function invalidSourceFileFilter(
  context: Parameters<MiddlewareHandler>[0],
  code: SourceFileListFilterErrorCode = "INVALID_SOURCE_FILE_FILTER"
): Response {
  return context.json(
    {
      error: {
        code
      }
    },
    400
  );
}

function readSourceFileRefreshAfterMs(sourceFiles: SourceFileRecord[]): number {
  return sourceFiles.some(
    (file) =>
      file.processingStatus === "queued" ||
      file.processingStatus === "running" ||
      file.generatedOutputStatus === "pending"
  )
    ? 2_000
    : 30_000;
}

function containsCredentialQuery(rawUrl: string): boolean {
  const searchParams = new URL(rawUrl).searchParams;
  return (
    searchParams.has("token") ||
    searchParams.has("username") ||
    searchParams.has("password")
  );
}

function readKnowledgeBaseCreateInput(
  body: Record<string, unknown>
): { name: string; description: string | null } | null {
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!name) {
    return null;
  }

  const description =
    typeof body.description === "string" && body.description.trim()
      ? body.description.trim()
      : null;

  return {
    name,
    description
  };
}

async function writeOpaqueCursor(options: {
  redis: RedisCoordinator;
  scope: string;
  cursor: string | null;
  ttlSeconds: number;
}): Promise<string | null> {
  if (!options.cursor) {
    return null;
  }

  const cursorId = `cursor-${randomUUID()}`;
  await options.redis.setPaginationCursor(
    options.scope,
    cursorId,
    options.cursor,
    options.ttlSeconds
  );
  return cursorId;
}

function notFound(context: Parameters<MiddlewareHandler>[0]): Response {
  return context.json(
    {
      error: {
        code: "NOT_FOUND"
      }
    },
    404
  );
}

function fileNotDeletable(context: Parameters<MiddlewareHandler>[0]): Response {
  return context.json(
    {
      error: {
        code: "FILE_NOT_DELETABLE",
        messageKey: "errors.fileNotDeletable"
      }
    },
    400
  );
}

function queueBackpressure(
  context: Parameters<MiddlewareHandler>[0],
  error: WorkerQueueBackpressureError
): Response {
  return context.json(
    {
      error: {
        code: error.code,
        messageKey: "errors.queueBackpressure",
        details: {
          activeJobCount: error.activeJobCount,
          limit: error.limit,
          knowledgeBaseActiveJobCount: error.knowledgeBaseActiveJobCount,
          knowledgeBaseLimit: error.knowledgeBaseLimit,
          oldestQueuedAgeSeconds: error.oldestQueuedAgeSeconds,
          maxQueuedAgeSeconds: error.maxQueuedAgeSeconds,
          retryAfterSeconds: error.retryAfterSeconds
        }
      }
    },
    503
  );
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
