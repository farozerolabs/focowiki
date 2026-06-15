import type { OpenAIResponsesClient } from "@focowiki/okf";
import { randomUUID } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { type RuntimeConfig } from "../config.js";
import type { AdminSessionManager } from "../auth/session.js";
import type {
  AdminRepositories,
  BundleFileRecord,
  BundleTreeEntryRecord,
  ReleaseRecord,
  SourceFileRecord,
  UploadTaskEventRecord,
  UploadTaskRecord
} from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import {
  createUploadProcessor,
  readBoundedUploadFiles
} from "./upload-processor.js";
import {
  hasDuplicateUploadFileNames,
  hasExistingSourceFileName,
  isUploadFile
} from "./upload-input.js";
import { buildPublicFileUrl } from "../public-url.js";
import { type StorageAdapter } from "../storage/s3.js";
import { createBoundedTaskRunner } from "../runtime/task-runner.js";

export type AdminApiServices = {
  config: RuntimeConfig;
  storage: StorageAdapter;
  modelClient: OpenAIResponsesClient | null;
  sessionManager: AdminSessionManager | null;
  redis: RedisCoordinator | null;
  repositories: AdminRepositories | null;
};

export function registerAdminApiRoutes(app: Hono, services: AdminApiServices): void {
  const { config, storage, modelClient, sessionManager, redis, repositories } = services;
  const uploadTaskRunner = createBoundedTaskRunner(config.upload.taskConcurrency);

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

    if (!sessionManager.authenticate({ username, password })) {
      return unauthorized(context);
    }

    context.header("set-cookie", await sessionManager.createSessionCookie(username));
    return context.json({ authenticated: true });
  });

  app.get("/admin/api/session", requireAdminAuth(sessionManager), (context) =>
    context.json({ authenticated: true })
  );

  app.post("/admin/api/logout", async (context) => {
    if (!sessionManager) {
      return missingSessionBackend(context);
    }

    await sessionManager.clearSessionFromCookieHeader(context.req.header("cookie"));
    context.header("set-cookie", sessionManager.createClearedSessionCookie());
    return context.json({ authenticated: false });
  });

  app.get("/admin/api/knowledge-bases", requireAdminAuth(sessionManager), async (context) => {
    if (!repositories || !redis) {
      return missingRepositoryBackend(context);
    }

    const limit = readPageLimit(context.req.query("limit"), config);

    if (!limit) {
      return invalidPagination(context);
    }

    const requestedCursor = context.req.query("cursor") ?? null;
    const repositoryCursor = requestedCursor
      ? await redis.getPaginationCursor<string>("knowledge-bases", requestedCursor)
      : null;

    if (requestedCursor && !repositoryCursor) {
      return invalidPagination(context);
    }

    const page = await repositories.knowledgeBases.listKnowledgeBases({
      limit,
      cursor: repositoryCursor
    });
    const nextCursor = page.nextCursor
      ? `cursor-${randomUUID()}`
      : null;

    if (nextCursor && page.nextCursor) {
      await redis.setPaginationCursor(
        "knowledge-bases",
        nextCursor,
        page.nextCursor,
        config.pagination.cursorTtlSeconds
      );
    }

    await redis.setPageCache(
      "knowledge-bases",
      `page-${randomUUID()}`,
      {
        cursor: requestedCursor,
        itemIds: page.items.map((item) => item.id)
      },
      config.pagination.cursorTtlSeconds
    );

    return context.json({
      items: page.items,
      nextCursor
    });
  });

  app.post("/admin/api/knowledge-bases", requireAdminAuth(sessionManager), async (context) => {
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
    requireAdminAuth(sessionManager),
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

  app.get(
    "/admin/api/knowledge-bases/:knowledgeBaseId/files/tree",
    requireAdminAuth(sessionManager),
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

      if (!knowledgeBase.activeReleaseId) {
        return context.json({ items: [], nextCursor: null });
      }

      const limit = readPageLimit(context.req.query("limit"), config);

      if (!limit) {
        return invalidPagination(context);
      }

      const parentPath = context.req.query("parentPath") ?? "";
      const cursorToken = context.req.query("cursor") ?? null;
      const cursorScope = `file-tree:${knowledgeBase.id}:${knowledgeBase.activeReleaseId}:${parentPath || "root"}`;
      const repositoryCursor = cursorToken
        ? await redis.getPaginationCursor<string>(cursorScope, cursorToken)
        : null;

      if (cursorToken && !repositoryCursor) {
        return invalidPagination(context);
      }

      const page = await repositories.files.listBundleTreeEntries({
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        parentPath,
        limit,
        cursor: repositoryCursor
      });
      const nextCursor = await writeOpaqueCursor({
        redis,
        scope: cursorScope,
        cursor: page.nextCursor,
        ttlSeconds: config.pagination.cursorTtlSeconds
      });

      await redis.setPageCache(
        cursorScope,
        `page-${randomUUID()}`,
        {
          cursor: cursorToken,
          itemIds: page.items.map((item) => item.id)
        },
        config.pagination.cursorTtlSeconds
      );

      return context.json({
        items: page.items.map(toAdminBundleTreeEntry),
        nextCursor
      });
    }
  );

  app.get(
    "/admin/api/knowledge-bases/:knowledgeBaseId/files/detail",
    requireAdminAuth(sessionManager),
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

      const content = await storage.getObjectText(file.objectKey);

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

  app.get(
    "/admin/api/knowledge-bases/:knowledgeBaseId/public-urls",
    requireAdminAuth(sessionManager),
    async (context) => {
      if (!repositories) {
        return missingRepositoryBackend(context);
      }

      const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(
        context.req.param("knowledgeBaseId")
      );

      if (!knowledgeBase?.activeReleaseId) {
        return notFound(context);
      }

      return context.json({
        publicUrls: {
          index: buildPublicFileUrl(config.publicApi.baseUrl, knowledgeBase.id, "index.md"),
          search: buildPublicFileUrl(
            config.publicApi.baseUrl,
            knowledgeBase.id,
            "_index/search.json"
          ),
          links: buildPublicFileUrl(
            config.publicApi.baseUrl,
            knowledgeBase.id,
            "_index/links.json"
          )
        }
      });
    }
  );

  app.get(
    "/admin/api/knowledge-bases/:knowledgeBaseId/releases",
    requireAdminAuth(sessionManager),
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
    requireAdminAuth(sessionManager),
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
    "/admin/api/knowledge-bases/:knowledgeBaseId/tasks",
    requireAdminAuth(sessionManager),
    async (context) => {
      if (!repositories?.tasks?.listUploadTasks || !redis) {
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

      const cursorToken = context.req.query("cursor") ?? null;
      const cursorScope = `upload-tasks:${knowledgeBase.id}`;
      const repositoryCursor = cursorToken
        ? await redis.getPaginationCursor<string>(cursorScope, cursorToken)
        : null;

      if (cursorToken && !repositoryCursor) {
        return invalidPagination(context);
      }

      const page = await repositories.tasks.listUploadTasks({
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

      await redis.setPageCache(
        cursorScope,
        `page-${randomUUID()}`,
        {
          cursor: cursorToken,
          itemIds: page.items.map((item) => item.id)
        },
        config.pagination.cursorTtlSeconds
      );

      return context.json({
        items: page.items.map(toUploadTaskLifecycle),
        nextCursor
      });
    }
  );

  app.get(
    "/admin/api/knowledge-bases/:knowledgeBaseId/tasks/:taskId",
    requireAdminAuth(sessionManager),
    async (context) => {
      if (
        !repositories?.tasks?.getUploadTask ||
        !repositories.tasks.listUploadTaskEvents ||
        !repositories.files?.listSourceFilesForTask ||
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

      const task = await repositories.tasks.getUploadTask({
        knowledgeBaseId: knowledgeBase.id,
        taskId: context.req.param("taskId")
      });

      if (!task) {
        return notFound(context);
      }

      const limit = readPageLimit(context.req.query("limit"), config);

      if (!limit) {
        return invalidPagination(context);
      }

      const cursorToken = context.req.query("cursor") ?? null;
      const cursorScope = `upload-task-events:${knowledgeBase.id}:${task.id}`;
      const repositoryCursor = cursorToken
        ? await redis.getPaginationCursor<string>(cursorScope, cursorToken)
        : null;

      if (cursorToken && !repositoryCursor) {
        return invalidPagination(context);
      }

      const phaseDetails = await repositories.tasks.listUploadTaskEvents({
        knowledgeBaseId: knowledgeBase.id,
        taskId: task.id,
        limit,
        cursor: repositoryCursor
      });
      const sourceFiles = await repositories.files.listSourceFilesForTask({
        knowledgeBaseId: knowledgeBase.id,
        taskId: task.id,
        limit,
        cursor: null
      });
      const nextCursor = await writeOpaqueCursor({
        redis,
        scope: cursorScope,
        cursor: phaseDetails.nextCursor,
        ttlSeconds: config.pagination.cursorTtlSeconds
      });
      const sourceFilesNextCursor = await writeOpaqueCursor({
        redis,
        scope: `upload-task-source-files:${knowledgeBase.id}:${task.id}`,
        cursor: sourceFiles.nextCursor,
        ttlSeconds: config.pagination.cursorTtlSeconds
      });

      await redis.setPageCache(
        cursorScope,
        `page-${randomUUID()}`,
        {
          cursor: cursorToken,
          itemIds: phaseDetails.items.map((item) => item.id)
        },
        config.pagination.cursorTtlSeconds
      );
      await redis.setPageCache(
        `upload-task-source-files:${knowledgeBase.id}:${task.id}`,
        `page-${randomUUID()}`,
        {
          cursor: null,
          itemIds: sourceFiles.items.map((item) => item.id)
        },
        config.pagination.cursorTtlSeconds
      );

      return context.json({
        task: toUploadTaskLifecycle(task),
        phaseDetails: {
          items: phaseDetails.items.map(toAdminUploadTaskEvent),
          nextCursor
        },
        sourceFiles: {
          items: sourceFiles.items.map(toAdminSourceFile),
          nextCursor: sourceFilesNextCursor
        }
      });
    }
  );

  app.post(
    "/admin/api/knowledge-bases/:knowledgeBaseId/uploads",
    requireAdminAuth(sessionManager),
    async (context) => {
      if (!repositories?.tasks || !repositories.files || !redis) {
        return missingRepositoryBackend(context);
      }

      const uploadProcessor = createUploadProcessor(
        repositories,
        storage,
        redis,
        modelClient && config.model.enabled
          ? {
              client: modelClient,
              modelName: config.model.modelName,
              contextWindowTokens: config.model.contextWindowTokens,
              receiveTimeouts: {
                maxMs: config.model.requestMaxTimeoutMs,
                idleMs: config.model.requestIdleTimeoutMs
              },
              suggestionConcurrency: config.model.suggestionConcurrency
            }
          : null
      );

      if (!uploadProcessor) {
        return missingRepositoryBackend(context);
      }

      const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(
        context.req.param("knowledgeBaseId")
      );

      if (!knowledgeBase) {
        return notFound(context);
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

      if (files.some((file) => !file.name.toLowerCase().endsWith(".md"))) {
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

      const task = await repositories.tasks.createUploadTask({
        knowledgeBaseId: knowledgeBase.id,
        sourceCount: files.length
      });

      void uploadTaskRunner
        .run(() =>
          uploadProcessor.process({
            knowledgeBaseId: knowledgeBase.id,
            task,
            files: loadedFiles,
            generatedAt: new Date().toISOString(),
            batchSize: config.upload.generationBatchSize,
            cursorTtlSeconds: config.pagination.cursorTtlSeconds,
            fileProcessingConcurrency: config.upload.fileProcessingConcurrency
          })
        )
        .catch(() => undefined);

      return context.json(
        {
          task: toUploadTaskLifecycle(task)
        },
        202
      );
    }
  );
}

function requireAdminAuth(sessionManager: AdminSessionManager | null): MiddlewareHandler {
  return async (context, next) => {
    if (containsCredentialQuery(context.req.raw.url)) {
      return unauthorized(context);
    }

    if (!sessionManager) {
      return missingSessionBackend(context);
    }

    if (!(await sessionManager.verifyCookieHeader(context.req.header("cookie")))) {
      return unauthorized(context);
    }

    await next();
  };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = (await request.json()) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function unauthorized(context: Parameters<MiddlewareHandler>[0]): Response {
  return context.json(
    {
      error: {
        code: "UNAUTHORIZED"
      }
    },
    401
  );
}

function missingSessionBackend(context: Parameters<MiddlewareHandler>[0]): Response {
  return context.json(
    {
      error: {
        code: "SESSION_BACKEND_UNAVAILABLE"
      }
    },
    503
  );
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

function containsCredentialQuery(rawUrl: string): boolean {
  const searchParams = new URL(rawUrl).searchParams;
  return (
    searchParams.has("token") ||
    searchParams.has("username") ||
    searchParams.has("password")
  );
}

function readPageLimit(rawLimit: string | undefined, config: RuntimeConfig): number | null {
  if (!rawLimit) {
    return config.pagination.defaultPageSize;
  }

  const limit = Number(rawLimit);

  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    limit > config.pagination.maxPageSize
  ) {
    return null;
  }

  return limit;
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

function toAdminBundleTreeEntry(entry: BundleTreeEntryRecord) {
  return {
    id: entry.id,
    parentPath: entry.parentPath,
    name: entry.name,
    logicalPath: entry.logicalPath,
    entryType: entry.entryType,
    bundleFileId: entry.bundleFileId
  };
}

function toAdminBundleFile(file: BundleFileRecord) {
  return {
    id: file.id,
    logicalPath: file.logicalPath,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    checksumSha256: file.checksumSha256,
    okfType: file.okfType,
    title: file.title,
    description: file.description,
    tags: file.tags,
    frontmatter: file.frontmatter
  };
}

function toAdminSourceFile(file: SourceFileRecord) {
  return {
    id: file.id,
    taskId: file.taskId,
    originalName: file.originalName,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    checksumSha256: file.checksumSha256,
    metadata: file.metadata,
    createdAt: file.createdAt
  };
}

function toAdminRelease(release: ReleaseRecord) {
  return {
    id: release.id,
    taskId: release.taskId,
    generatedAt: release.generatedAt,
    publishedAt: release.publishedAt,
    fileCount: release.fileCount,
    manifestChecksumSha256: release.manifestChecksumSha256,
    createdAt: release.createdAt
  };
}

function toUploadTaskLifecycle(task: UploadTaskRecord) {
  return {
    id: task.id,
    knowledgeBaseId: task.knowledgeBaseId,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    lifecycle: task.endedAt ? "ended" : "running",
    sourceCount: task.sourceCount,
    resultReleaseId: task.resultReleaseId
  };
}

function toAdminUploadTaskEvent(event: UploadTaskEventRecord) {
  return {
    id: event.id,
    taskId: event.taskId,
    phaseKey: event.phaseKey,
    messageKey: event.messageKey,
    startedAt: event.startedAt,
    endedAt: event.endedAt,
    severity: event.severity,
    createdAt: event.createdAt
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
