import { Hono, type MiddlewareHandler } from "hono";
import type { RuntimeConfig } from "../config.js";
import type { StorageVnextAdminReadApplication } from "../storage-vnext/api/admin-read-application.js";
import type { StorageVnextAdminKnowledgeBase } from "../storage-vnext/api/admin-ports.js";
import { readPageLimit } from "./pagination.js";
import {
  readKnowledgeBaseSearchQueryFromQuery,
  type KnowledgeBaseSearchErrorCode
} from "./knowledge-base-search.js";

type AdminKnowledgeBaseListRouteServices = {
  config: RuntimeConfig;
  application: StorageVnextAdminReadApplication;
};

type AdminKnowledgeBaseListRouteMiddleware = {
  requireAuth: MiddlewareHandler;
};

export function registerAdminKnowledgeBaseListRoutes(
  app: Hono,
  services: AdminKnowledgeBaseListRouteServices,
  middleware: AdminKnowledgeBaseListRouteMiddleware
): void {
  const { config, application } = services;
  const { requireAuth } = middleware;

  app.get("/admin/api/knowledge-bases", requireAuth, async (context) => {
    const limit = readPageLimit(context.req.query("limit"), config);

    if (!limit) {
      return invalidPagination(context);
    }

    const searchQuery = readKnowledgeBaseSearchQueryFromQuery((name) => context.req.query(name));

    if (!searchQuery.ok) {
      return invalidKnowledgeBaseSearchQuery(context, searchQuery.code);
    }

    const requestedCursor = context.req.query("cursor") ?? null;
    const result = await application.listKnowledgeBases({
      limit,
      cursor: requestedCursor,
      query: searchQuery.query
    });
    if (!result.ok) return applicationError(context, result.code);

    return context.json({
      items: result.value.items.map(toReleasedKnowledgeBase),
      nextCursor: result.value.nextCursor
    });
  });
}

function invalidPagination(context: Parameters<MiddlewareHandler>[0]): Response {
  return context.json(
    {
      error: {
        code: "INVALID_PAGINATION"
      }
    },
    400
  );
}

function applicationError(
  context: Parameters<MiddlewareHandler>[0],
  code: "DATABASE_REPOSITORY_UNAVAILABLE" | "INVALID_PAGINATION" | "NOT_FOUND"
): Response {
  return context.json(
    { error: { code } },
    code === "DATABASE_REPOSITORY_UNAVAILABLE"
      ? 503
      : code === "NOT_FOUND"
        ? 404
        : 400
  );
}

function toReleasedKnowledgeBase(knowledgeBase: StorageVnextAdminKnowledgeBase) {
  return {
    id: knowledgeBase.id,
    name: knowledgeBase.name,
    description: knowledgeBase.description,
    activeContentRevision: knowledgeBase.catalogVersion,
    ...(knowledgeBase.resourceRevision === undefined
      ? {}
      : { resourceRevision: knowledgeBase.resourceRevision }),
    createdAt: knowledgeBase.createdAt,
    updatedAt: knowledgeBase.updatedAt
  };
}

function invalidKnowledgeBaseSearchQuery(
  context: Parameters<MiddlewareHandler>[0],
  code: KnowledgeBaseSearchErrorCode = "INVALID_KNOWLEDGE_BASE_SEARCH_QUERY"
): Response {
  return context.json(
    {
      error: {
        code
      }
    },
    400
  );
}
