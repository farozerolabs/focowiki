import { Hono, type MiddlewareHandler } from "hono";
import type { AdminRepositories } from "../db/admin-repositories.js";
import type { PublicationGenerationRepository } from "../application/ports/publication-generation-repository.js";
import type { RoleJobRepository } from "../application/ports/role-job-repository.js";
import type { SourceDispatchRepository } from "../application/ports/source-dispatch-repository.js";
import type { MaintenanceProgressRepository } from "../application/ports/maintenance-progress-repository.js";

export function registerAdminProcessingSummaryRoutes(
  app: Hono,
  services: {
    repositories: AdminRepositories | null;
    roleJobs: RoleJobRepository | null;
    publicationGenerations: PublicationGenerationRepository | null;
    sourceDispatch: SourceDispatchRepository | null;
    maintenanceProgress: MaintenanceProgressRepository | null;
  },
  middlewares: {
    requireAuth: MiddlewareHandler;
  }
): void {
  const {
    repositories,
    roleJobs,
    publicationGenerations,
    sourceDispatch,
    maintenanceProgress
  } = services;

  app.get(
    "/admin/api/knowledge-bases/:knowledgeBaseId/processing-summary",
    middlewares.requireAuth,
    async (context) => {
      if (
        !repositories ||
        !roleJobs ||
        !publicationGenerations ||
        !sourceDispatch ||
        !maintenanceProgress
      ) {
        return missingRepositoryBackend(context);
      }

      const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(
        context.req.param("knowledgeBaseId")
      );

      if (!knowledgeBase) {
        return notFound(context);
      }

      const now = new Date().toISOString();
      const [
        sourceFileJobs,
        publicationJobs,
        pendingDispatch,
        publicationProgress,
        maintenanceProgressSummary
      ] = await Promise.all([
        roleJobs.getQueueSummary({
          role: "source",
          knowledgeBaseId: knowledgeBase.id,
          now
        }),
        roleJobs.getQueueSummary({
          role: "publication",
          knowledgeBaseId: knowledgeBase.id,
          now
        }),
        sourceDispatch.getSummary({ knowledgeBaseId: knowledgeBase.id }),
        publicationGenerations.getProgressSummary({ knowledgeBaseId: knowledgeBase.id }),
        maintenanceProgress.getSummary({ knowledgeBaseId: knowledgeBase.id })
      ]);

      return context.json({
        activeGenerationId: knowledgeBase.activeGenerationId,
        pendingDispatch,
        sourceFileJobs,
        publicationJobs,
        publicationProgress,
        maintenanceProgress: maintenanceProgressSummary,
        dirtySourceFiles: {
          count: Math.max(
            0,
            publicationProgress.totalImpactCount - publicationProgress.processedImpactCount
          ),
          oldestDirtyAt: publicationProgress.oldestDirtyAt
        }
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
