import type { OpenAIResponsesClient } from "@focowiki/okf";
import { Hono, type MiddlewareHandler } from "hono";
import type { RuntimeConfig } from "../config.js";
import type { AdminRepositories } from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { BoundedTaskRunner } from "../runtime/task-runner.js";
import type { StorageAdapter } from "../storage/s3.js";
import { createSourceFileQueueProcessor } from "./source-file-processor.js";
import { toAdminSourceFile } from "./serializers.js";
import { limitAdminUploadRequest } from "./security.js";

export function registerAdminSourceFileRetryRoutes(
  app: Hono,
  services: {
    config: RuntimeConfig;
    storage: StorageAdapter;
    modelClient: OpenAIResponsesClient | null;
    redis: RedisCoordinator | null;
    repositories: AdminRepositories | null;
    taskRunner: BoundedTaskRunner;
  },
  middlewares: {
    requireAuth: MiddlewareHandler;
    requireWriteProtection: MiddlewareHandler;
  }
): void {
  const { config, storage, modelClient, redis, repositories, taskRunner } = services;

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
        !redis
      ) {
        return missingRepositoryBackend(context);
      }
      const repo = repositories;

      const sourceFileProcessor = createSourceFileQueueProcessor(
        repo,
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

      if (!sourceFileProcessor) {
        return missingRepositoryBackend(context);
      }

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

      const startedAt = new Date().toISOString();
      await createSourceFileRetryAttempt({
        knowledgeBaseId: knowledgeBase.id,
        sourceFileId: sourceFile.id,
        status: "running",
        startedAt,
        endedAt: null,
        errorCode: null
      });

      void taskRunner
        .run(() =>
          sourceFileProcessor.processFile({
            knowledgeBaseId: knowledgeBase.id,
            knowledgeBaseName: knowledgeBase.name,
            sourceFileId: sourceFile.id,
            generatedAt: startedAt,
            batchSize: config.upload.generationBatchSize,
            cursorTtlSeconds: config.pagination.cursorTtlSeconds,
            fileProcessingConcurrency: config.upload.fileProcessingConcurrency,
            okfLog: config.okf?.log
          })
        )
        .catch(() => undefined);

      return context.json(
        {
          file: toAdminSourceFile(sourceFile)
        },
        202
      );
    }
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
