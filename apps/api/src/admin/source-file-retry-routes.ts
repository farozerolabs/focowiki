import { Hono, type MiddlewareHandler } from "hono";
import type { RuntimeConfig } from "../config.js";
import type { AdminRepositories } from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { RuntimeSettingsService } from "../runtime-settings/service.js";
import {
  retrySourceFile,
  SourceFileRetryServiceError
} from "../application/source-file-retry.js";
import { toAdminSourceFile } from "./serializers.js";
import type { SourceFileRetryRepository } from "../application/ports/source-file-retry-repository.js";

export function registerAdminSourceFileRetryRoutes(
  app: Hono,
  services: {
    config: RuntimeConfig;
    redis: RedisCoordinator | null;
    repositories: AdminRepositories | null;
    runtimeSettings?: RuntimeSettingsService | null | undefined;
    sourceFileRetries: SourceFileRetryRepository | null;
  },
  middlewares: {
    requireAuth: MiddlewareHandler;
    requireWriteProtection: MiddlewareHandler;
  }
): void {
  const { config, redis, repositories, runtimeSettings, sourceFileRetries } = services;

  app.post(
    "/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/retry",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) => {
      if (!repositories || !redis) {
        return missingRepositoryBackend(context);
      }
      const repo = repositories;

      const knowledgeBase = await repo.knowledgeBases.getKnowledgeBase(
        context.req.param("knowledgeBaseId")
      );

      if (!knowledgeBase) {
        return notFound(context);
      }

      try {
        const result = await retrySourceFile({
          repositories: repo,
          retries: sourceFileRetries,
          knowledgeBaseId: knowledgeBase.id,
          sourceFileId: context.req.param("sourceFileId"),
          config,
          worker: (await runtimeSettings?.getSnapshot())?.worker
        });
        return context.json(
          {
            file: toAdminSourceFile(result.file),
            retry: {
              kind: result.kind,
              scope: result.scope,
              coalesced: result.coalesced
            }
          },
          202
        );
      } catch (error) {
        if (error instanceof SourceFileRetryServiceError) {
          if (error.code === "SOURCE_FILE_NOT_FOUND") return notFound(context);
          if (error.code === "SOURCE_FILE_RETRY_BACKEND_UNAVAILABLE") {
            return missingRepositoryBackend(context);
          }
          return context.json(
            {
              error: {
                code: error.code,
                messageKey: error.code === "SOURCE_FILE_RETRY_NOT_ALLOWED"
                  ? "errors.sourceFileRetryNotAllowed"
                  : "errors.sourceFileRetryConflict"
              }
            },
            409
          );
        }
        throw error;
      }
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
