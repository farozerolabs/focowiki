import { Hono, type MiddlewareHandler } from "hono";
import type { StorageVnextAdminSourceApplication } from "../storage-vnext/api/admin-source-application.js";

export function registerAdminSourceFileRetryRoutes(
  app: Hono,
  services: {
    application: StorageVnextAdminSourceApplication;
  },
  middlewares: {
    requireAuth: MiddlewareHandler;
    requireWriteProtection: MiddlewareHandler;
  }
): void {
  app.post(
    "/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/retry",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) => {
      const result = await services.application.retrySourceFile({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        sourceFileId: context.req.param("sourceFileId")
      });
      if (result.ok) return context.json(result.value, 202);
      if (result.code === "NOT_FOUND") return notFound(context);
      if (result.code === "DATABASE_REPOSITORY_UNAVAILABLE") {
        return missingRepositoryBackend(context);
      }
      return context.json(
        {
          error: {
            code: result.code,
            messageKey: retryErrorMessageKey(result.code)
          }
        },
        409
      );
    }
  );
}

function retryErrorMessageKey(code: string): string {
  if (code === "SOURCE_FILE_RETRY_ALREADY_RUNNING") {
    return "errors.sourceFileRetryAlreadyRunning";
  }
  if (code === "SOURCE_FILE_RETRY_NOT_ALLOWED") {
    return "errors.sourceFileRetryNotAllowed";
  }
  return "errors.sourceFileRetryConflict";
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
