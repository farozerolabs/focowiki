import { randomUUID } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import type { RuntimeConfig } from "../config.js";
import type { AdminRepositories } from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import { readPageLimit } from "./pagination.js";
import { createKnowledgeBaseCursorScope } from "./knowledge-base-search-signature.js";
import {
  readKnowledgeBaseSearchQueryFromQuery,
  type KnowledgeBaseSearchErrorCode
} from "./knowledge-base-search.js";

type AdminKnowledgeBaseListRouteServices = {
  config: RuntimeConfig;
  redis: RedisCoordinator | null;
  repositories: AdminRepositories | null;
};

type AdminKnowledgeBaseListRouteMiddleware = {
  requireAuth: MiddlewareHandler;
};

export function registerAdminKnowledgeBaseListRoutes(
  app: Hono,
  services: AdminKnowledgeBaseListRouteServices,
  middleware: AdminKnowledgeBaseListRouteMiddleware
): void {
  const { config, redis, repositories } = services;
  const { requireAuth } = middleware;

  app.get("/admin/api/knowledge-bases", requireAuth, async (context) => {
    if (!repositories || !redis) {
      return missingRepositoryBackend(context);
    }

    const limit = readPageLimit(context.req.query("limit"), config);

    if (!limit) {
      return invalidPagination(context);
    }

    const searchQuery = readKnowledgeBaseSearchQueryFromQuery((name) => context.req.query(name));

    if (!searchQuery.ok) {
      return invalidKnowledgeBaseSearchQuery(context, searchQuery.code);
    }

    const requestedCursor = context.req.query("cursor") ?? null;
    const cursorScope = createKnowledgeBaseCursorScope(searchQuery.query);
    const repositoryCursor = requestedCursor
      ? await redis.getPaginationCursor<string>(cursorScope, requestedCursor)
      : null;

    if (requestedCursor && !repositoryCursor) {
      return invalidPagination(context);
    }

    const page = await repositories.knowledgeBases.listKnowledgeBases({
      limit,
      cursor: repositoryCursor,
      query: searchQuery.query
    });
    const nextCursor = page.nextCursor ? `cursor-${randomUUID()}` : null;

    if (nextCursor && page.nextCursor) {
      await redis.setPaginationCursor(
        cursorScope,
        nextCursor,
        page.nextCursor,
        config.pagination.cursorTtlSeconds
      );
    }

    await redis.setPageCache(
      cursorScope,
      `page-${randomUUID()}`,
      {
        cursor: requestedCursor,
        query: searchQuery.query,
        itemIds: page.items.map((item) => item.id)
      },
      config.pagination.cursorTtlSeconds
    );

    return context.json({
      items: page.items,
      nextCursor
    });
  });
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
