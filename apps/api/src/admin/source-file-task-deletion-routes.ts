import { Hono, type MiddlewareHandler } from "hono";
import type { RuntimeConfig } from "../config.js";
import type { AdminRepositories } from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { StorageAdapter } from "../storage/s3.js";
import { readSourceFileTaskDeletionRequest } from "./source-file-task-deletion-request.js";
import { createSourceFileTaskDeletionService } from "./source-file-task-deletion-service.js";

export function registerAdminSourceFileTaskDeletionRoutes(
  app: Hono,
  services: {
    config: RuntimeConfig;
    storage: StorageAdapter;
    redis: RedisCoordinator | null;
    repositories: AdminRepositories | null;
  },
  middlewares: {
    requireAuth: MiddlewareHandler;
    requireWriteProtection: MiddlewareHandler;
  }
): void {
  const { config, storage, redis, repositories } = services;

  app.post(
    "/admin/api/knowledge-bases/:knowledgeBaseId/source-files/task-deletions",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) => {
      if (!repositories || !redis) {
        return missingRepositoryBackend(context);
      }

      const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(
        context.req.param("knowledgeBaseId")
      );

      if (!knowledgeBase) {
        return notFound(context);
      }

      const request = readSourceFileTaskDeletionRequest(await readJsonBody(context.req.raw), {
        maxSourceFileIds: config.pagination.maxPageSize
      });

      if (!request.ok) {
        return context.json(
          {
            error: {
              code: request.code,
              messageKey: request.messageKey
            }
          },
          400
        );
      }

      const service = createSourceFileTaskDeletionService(repositories, storage, redis);

      if (!service) {
        return missingRepositoryBackend(context);
      }

      const result = await service.deleteTasks({
        knowledgeBaseId: knowledgeBase.id,
        sourceFileIds: request.sourceFileIds,
        deletedAt: new Date().toISOString(),
        cursorTtlSeconds: config.pagination.cursorTtlSeconds
      });

      if (!result) {
        return notFound(context);
      }

      return context.json(result);
    }
  );
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
