import { Hono, type MiddlewareHandler } from "hono";
import type { RuntimeConfig } from "../config.js";
import { readSourceFileTaskDeletionRequest } from "./source-file-task-deletion-request.js";
import type { StorageVnextAdminSourceApplication } from "../storage-vnext/api/admin-source-application.js";

export function registerAdminSourceFileTaskDeletionRoutes(
  app: Hono,
  services: {
    config: RuntimeConfig;
    application: StorageVnextAdminSourceApplication;
  },
  middlewares: {
    requireAuth: MiddlewareHandler;
    requireWriteProtection: MiddlewareHandler;
  }
): void {
  const { config, application } = services;

  app.post(
    "/admin/api/knowledge-bases/:knowledgeBaseId/source-files/task-deletions",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) => {
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

      const result = await application.deleteSourceFileTasks({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        sourceFileIds: request.sourceFileIds
      });
      if (!result.ok) {
        return result.code === "NOT_FOUND"
          ? notFound(context)
          : missingRepositoryBackend(context);
      }
      return context.json(result.value);
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
