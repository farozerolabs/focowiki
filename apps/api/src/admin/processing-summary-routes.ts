import { Hono, type MiddlewareHandler } from "hono";
import type { StorageVnextAdminProcessingApplication } from "../storage-vnext/api/admin-processing-application.js";

export function registerAdminProcessingSummaryRoutes(
  app: Hono,
  services: {
    application: StorageVnextAdminProcessingApplication;
  },
  middlewares: {
    requireAuth: MiddlewareHandler;
  }
): void {
  app.get(
    "/admin/api/knowledge-bases/:knowledgeBaseId/processing-summary",
    middlewares.requireAuth,
    async (context) => {
      const result = await services.application.getProcessingSummary({
        knowledgeBaseId: context.req.param("knowledgeBaseId")
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
