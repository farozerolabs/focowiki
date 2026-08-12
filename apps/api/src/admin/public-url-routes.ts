import { Hono, type MiddlewareHandler } from "hono";
import type { RuntimeConfig } from "../config.js";
import { buildPublicFileUrl } from "../public-url.js";
import type { StorageVnextAdminReadApplication } from "../storage-vnext/api/admin-read-application.js";

export function registerAdminPublicUrlRoutes(
  app: Hono,
  services: {
    config: RuntimeConfig;
    application: StorageVnextAdminReadApplication;
  },
  middlewares: {
    requireAuth: MiddlewareHandler;
  }
): void {
  const { config, application } = services;

  app.get(
    "/admin/api/knowledge-bases/:knowledgeBaseId/public-urls",
    middlewares.requireAuth,
    async (context) => {
      const result = await application.getKnowledgeBase({
        knowledgeBaseId: context.req.param("knowledgeBaseId")
      });
      if (!result.ok) {
        return result.code === "DATABASE_REPOSITORY_UNAVAILABLE"
          ? missingRepositoryBackend(context)
          : notFound(context);
      }
      const knowledgeBase = result.value;

      if (!knowledgeBase) return notFound(context);

      if (!knowledgeBase.activeVersionId) {
        return context.json({ publicUrls: null });
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
