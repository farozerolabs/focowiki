import { Hono, type MiddlewareHandler } from "hono";
import type { RuntimeConfig } from "../config.js";
import type { AdminRepositories } from "../db/admin-repositories.js";
import { buildPublicFileUrl } from "../public-url.js";

export function registerAdminPublicUrlRoutes(
  app: Hono,
  services: {
    config: RuntimeConfig;
    repositories: AdminRepositories | null;
  },
  middlewares: {
    requireAuth: MiddlewareHandler;
  }
): void {
  const { config, repositories } = services;

  app.get(
    "/admin/api/knowledge-bases/:knowledgeBaseId/public-urls",
    middlewares.requireAuth,
    async (context) => {
      if (!repositories) {
        return missingRepositoryBackend(context);
      }

      const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(
        context.req.param("knowledgeBaseId")
      );

      if (!knowledgeBase?.activeGenerationId) {
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
