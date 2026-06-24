import { Hono, type MiddlewareHandler } from "hono";
import type { RuntimeConfig } from "../config.js";
import type { AdminRepositories } from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import {
  assertSourceFileQueueCapacity,
  enqueueSourceFileProcessingJobs,
  WorkerQueueBackpressureError
} from "../worker/source-file-jobs.js";
import { toAdminSourceFile } from "./serializers.js";
import { limitAdminUploadRequest } from "./security.js";

export function registerAdminSourceFileRetryRoutes(
  app: Hono,
  services: {
    config: RuntimeConfig;
    redis: RedisCoordinator | null;
    repositories: AdminRepositories | null;
  },
  middlewares: {
    requireAuth: MiddlewareHandler;
    requireWriteProtection: MiddlewareHandler;
  }
): void {
  const { config, redis, repositories } = services;

  app.post(
    "/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/retry",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) => {
      const files = repositories?.files;
      const getSourceFile = files?.getSourceFile;
      const createSourceFileRetryAttempt = files?.createSourceFileRetryAttempt;

      if (
        !repositories ||
        !getSourceFile ||
        !createSourceFileRetryAttempt ||
        !repositories.workerJobs ||
        !redis
      ) {
        return missingRepositoryBackend(context);
      }
      const repo = repositories;

      const knowledgeBase = await repo.knowledgeBases.getKnowledgeBase(
        context.req.param("knowledgeBaseId")
      );

      if (!knowledgeBase) {
        return notFound(context);
      }

      const uploadLimited = await limitAdminUploadRequest({
        config,
        redis,
        repositories: repo,
        context
      });

      if (uploadLimited) {
        return uploadLimited;
      }

      const sourceFile = await getSourceFile({
        knowledgeBaseId: knowledgeBase.id,
        sourceFileId: context.req.param("sourceFileId")
      });

      if (!sourceFile) {
        return notFound(context);
      }

      if (sourceFile.processingStatus !== "failed") {
        return context.json(
          {
            error: {
              code: "SOURCE_FILE_RETRY_NOT_ALLOWED",
              messageKey: "errors.sourceFileRetryNotAllowed"
            }
          },
          409
        );
      }

      try {
        await assertSourceFileQueueCapacity({
          repositories: repo,
          knowledgeBaseId: knowledgeBase.id,
          config
        });
      } catch (error) {
        if (error instanceof WorkerQueueBackpressureError) {
          return queueBackpressure(context, error);
        }

        throw error;
      }

      const startedAt = new Date().toISOString();
      await createSourceFileRetryAttempt({
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
        config
      });

      return context.json(
        {
          file: toAdminSourceFile(sourceFile)
        },
        202
      );
    }
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
