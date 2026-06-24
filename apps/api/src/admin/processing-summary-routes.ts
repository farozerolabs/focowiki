import { Hono, type MiddlewareHandler } from "hono";
import type { AdminRepositories } from "../db/admin-repositories.js";

export function registerAdminProcessingSummaryRoutes(
  app: Hono,
  services: {
    repositories: AdminRepositories | null;
  },
  middlewares: {
    requireAuth: MiddlewareHandler;
  }
): void {
  const { repositories } = services;

  app.get(
    "/admin/api/knowledge-bases/:knowledgeBaseId/processing-summary",
    middlewares.requireAuth,
    async (context) => {
      if (!repositories?.files?.countDirtySourceFiles || !repositories.workerJobs) {
        return missingRepositoryBackend(context);
      }

      const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(
        context.req.param("knowledgeBaseId")
      );

      if (!knowledgeBase) {
        return notFound(context);
      }

      const now = new Date().toISOString();
      const [sourceFileJobs, publicationJobs, dirtySourceFiles] = await Promise.all([
        repositories.workerJobs.getWorkerQueueSummary({
          kinds: ["source_file_processing"],
          knowledgeBaseId: knowledgeBase.id,
          now
        }),
        repositories.workerJobs.getWorkerQueueSummary({
          kinds: ["publication"],
          knowledgeBaseId: knowledgeBase.id,
          now
        }),
        repositories.files.countDirtySourceFiles({
          knowledgeBaseId: knowledgeBase.id
        })
      ]);

      return context.json({
        sourceFileJobs,
        publicationJobs,
        dirtySourceFiles
      });
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
