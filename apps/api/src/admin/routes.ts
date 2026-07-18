import type { OpenAIModelClient } from "@focowiki/okf";
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
import type { RuntimeSettingsService } from "../runtime-settings/service.js";
import {
  StorageObjectTooLargeError,
  type StorageAdapter
} from "../storage/s3.js";
import { createDeletionService } from "./deletion-service.js";
import { readGeneratedOutputsForSourceFilesSafely } from "./source-file-generated-output.js";
import {
  adminUnauthorized,
  createAdminAuthMiddleware,
  createAdminWriteProtectionMiddleware,
  limitAdminLoginRequest,
  missingSessionBackend,
  recordAdminAudit,
  registerAdminSecurityMiddlewares
} from "./security.js";
import {
  toAdminSourceFile,
  toAdminSourceFileEvent
} from "./serializers.js";
import {
  toAdminActiveFile,
  toAdminActiveRelationship
} from "./active-generation-serializers.js";
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
import { registerAdminRuntimeSettingsRoutes } from "./runtime-settings-routes.js";
import { registerAdminSourceFileRetryRoutes } from "./source-file-retry-routes.js";
import { registerAdminSourceFileTaskDeletionRoutes } from "./source-file-task-deletion-routes.js";
import { createSourceFileCursorScope } from "./source-file-list-filter-signature.js";
import {
  readSourceFileListFiltersFromQuery,
  type SourceFileListFilterErrorCode
} from "./source-file-list-filters.js";
import { registerAdminUploadSessionRoutes } from "./upload-session-routes.js";
import { registerAdminSourceResourceEditingRoutes } from "./source-resource-editing-routes.js";
import type { ApplicationRuntime } from "../application/ports/runtime.js";
import type { UploadSessionStoragePort } from "../application/ports/upload-session-storage.js";
import type { RuntimeLogger } from "../logger.js";
import { readGeneratedContentWithMetrics } from "../application/generated-content-read.js";
import { reportGeneratedContentRead } from "../app/generated-content-read-logger.js";
import type { ActiveGenerationReadRepository } from "../application/ports/active-generation-read-repository.js";
import type { RoleJobRepository } from "../application/ports/role-job-repository.js";
import type { PublicationGenerationRepository } from "../application/ports/publication-generation-repository.js";
import type { SourceDispatchRepository } from "../application/ports/source-dispatch-repository.js";
import type { SourceFileRetryRepository } from "../application/ports/source-file-retry-repository.js";
import type { SourceFileTaskDeletionRepository } from "../application/ports/source-file-task-deletion-repository.js";

export type AdminApiServices = {
  config: RuntimeConfig;
  storage: StorageAdapter;
  modelClient: OpenAIModelClient | null;
  sessionManager: AdminSessionManager | null;
  redis: RedisCoordinator | null;
  repositories: AdminRepositories | null;
  runtimeSettings: RuntimeSettingsService | null;
  applicationRuntime: ApplicationRuntime;
  uploadSessionStorage: UploadSessionStoragePort;
  logger?: RuntimeLogger;
  activeGenerationReads: ActiveGenerationReadRepository | null;
  roleJobs: RoleJobRepository | null;
  publicationGenerations: PublicationGenerationRepository | null;
  sourceDispatch: SourceDispatchRepository | null;
  sourceFileRetries: SourceFileRetryRepository | null;
  sourceFileTaskDeletions: SourceFileTaskDeletionRepository | null;
};

export function registerAdminApiRoutes(app: Hono, services: AdminApiServices): void {
  const { config, storage, sessionManager, redis, repositories, runtimeSettings } = services;
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
    repositories,
    runtimeSettings
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
  registerAdminRuntimeSettingsRoutes(
    app,
    { runtimeSettings },
    {
      requireAuth,
      requireWriteProtection
    }
  );
  registerAdminSourceFileRetryRoutes(
    app,
    {
      config,
      redis,
      repositories,
      runtimeSettings,
      sourceFileRetries: services.sourceFileRetries
    },
    {
      requireAuth,
      requireWriteProtection
    }
  );
  registerAdminSourceFileTaskDeletionRoutes(
    app,
    {
      config,
      redis,
      repositories,
      runtimeSettings,
      sourceFileTaskDeletions: services.sourceFileTaskDeletions
    },
    {
      requireAuth,
      requireWriteProtection
    }
  );
  registerAdminFileTreeRoutes(
    app,
    {
      config,
      redis,
      repositories,
      activeGenerationReads: services.activeGenerationReads
    },
    {
      requireAuth
    }
  );
  registerAdminFileTreeSearchRoutes(
    app,
    {
      config,
      redis,
      repositories,
      activeGenerationReads: services.activeGenerationReads
    },
    { requireAuth }
  );
  registerAdminSourceResourceEditingRoutes(
    app,
    {
      config,
      repositories,
      redis,
      runtimeSettings,
      storage,
      roleJobs: services.roleJobs,
      publicationGenerations: services.publicationGenerations,
      applicationRuntime: services.applicationRuntime
    },
    { requireAuth, requireWriteProtection }
  );
  registerAdminProcessingSummaryRoutes(
    app,
    {
      repositories,
      roleJobs: services.roleJobs,
      publicationGenerations: services.publicationGenerations,
      sourceDispatch: services.sourceDispatch
    },
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
  registerAdminUploadSessionRoutes(
    app,
    {
      config,
      redis,
      repositories,
      runtimeSettings,
      applicationRuntime: services.applicationRuntime,
      uploadSessionStorage: services.uploadSessionStorage
    },
    { requireAuth, requireWriteProtection }
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
      runtimeSettings,
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

      const runtimeSnapshot = runtimeSettings ? await runtimeSettings.getSnapshot() : null;
      if (!services.activeGenerationReads || !services.roleJobs || !services.publicationGenerations) {
        return missingRepositoryBackend(context);
      }
      const deletionService = createDeletionService({
        repositories,
        activeGenerationReads: services.activeGenerationReads,
        roleJobs: services.roleJobs,
        publicationGenerations: services.publicationGenerations,
        storage,
        redis,
        runtime: services.applicationRuntime,
        publicationSettingsSnapshot: {
          publication: runtimeSnapshot?.publication ?? {},
          graph: runtimeSnapshot?.graph ?? {},
          worker: runtimeSnapshot?.worker ?? {}
        }
      });

      if (!deletionService) {
        return missingRepositoryBackend(context);
      }

      const deleted = await deletionService.deleteKnowledgeBase({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        maxAttempts: runtimeSnapshot?.worker.hardDeleteMaxAttempts ?? 3
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
      if (!services.activeGenerationReads) {
        return missingRepositoryBackend(context);
      }

      const logicalPath = context.req.query("path");

      if (!logicalPath) {
        return notFound(context);
      }
      const includeRelationships = context.req.query("includeRelationships") === "1";

      const result = await readGeneratedContentWithMetrics({
        resolve: () => services.activeGenerationReads!.withActiveGeneration(
          context.req.param("knowledgeBaseId"),
          async (scope) => {
            const file = await scope.findFileByPath(logicalPath);
            if (!file) return null;
            const relationships = includeRelationships && file.sourceFileId
              ? (await scope.listRelated({
                  sourceFileId: file.sourceFileId,
                  limit: 8,
                  cursor: null
                })).items
              : [];
            return { file, relationships };
          }
        ),
        read: ({ file }) => readGeneratedObjectText(storage, file.objectKey, config),
        now: () => performance.now(),
        onComplete: (metrics) => reportGeneratedContentRead(services.logger, "admin", metrics)
      });
      const content = result.content;

      if (content instanceof Response) {
        return content;
      }

      if (!result.descriptor || content === null) {
        return notFound(context);
      }
      const { file, relationships } = result.descriptor;

      return context.json({
        file: toAdminActiveFile(file),
        relationships: relationships.map(toAdminActiveRelationship),
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
      if (!repositories?.sourceResources || !redis) {
        return missingRepositoryBackend(context);
      }

      const logicalPath = context.req.query("path");

      if (!logicalPath) {
        return notFound(context);
      }

      const runtimeSnapshot = runtimeSettings ? await runtimeSettings.getSnapshot() : null;
      if (!services.activeGenerationReads || !services.roleJobs || !services.publicationGenerations) {
        return missingRepositoryBackend(context);
      }
      const deletionService = createDeletionService({
        repositories,
        activeGenerationReads: services.activeGenerationReads,
        roleJobs: services.roleJobs,
        publicationGenerations: services.publicationGenerations,
        storage,
        redis,
        runtime: services.applicationRuntime,
        publicationSettingsSnapshot: {
          publication: runtimeSnapshot?.publication ?? {},
          graph: runtimeSnapshot?.graph ?? {},
          worker: runtimeSnapshot?.worker ?? {}
        }
      });

      if (!deletionService) {
        return missingRepositoryBackend(context);
      }

      const result = await deletionService.deleteSourcePage({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        logicalPath,
        maxAttempts: runtimeSnapshot?.worker.hardDeleteMaxAttempts ?? 3
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
        activeGenerationReads: services.activeGenerationReads,
        knowledgeBaseId: knowledgeBase.id,
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
                activeGenerationReads: services.activeGenerationReads,
                knowledgeBaseId: knowledgeBase.id,
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
