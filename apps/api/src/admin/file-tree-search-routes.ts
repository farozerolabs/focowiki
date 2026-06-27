import { randomUUID } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import type { RuntimeConfig } from "../config.js";
import type { AdminRepositories } from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import {
  createPageResponseCacheId,
  readPageResponseCache,
  writePageResponseCache
} from "../page-response-cache.js";
import { readTreePageLimit } from "./pagination.js";
import { readFileTreeSearchQuery } from "./file-tree-search-filters.js";
import { createFileTreeSearchCursorScope } from "./file-tree-search-signature.js";
import { toAdminBundleTreeSearchResult } from "./serializers.js";

export function registerAdminFileTreeSearchRoutes(
  app: Hono,
  services: {
    config: RuntimeConfig;
    redis: RedisCoordinator | null;
    repositories: AdminRepositories | null;
  },
  middlewares: {
    requireAuth: MiddlewareHandler;
  }
): void {
  const { config, redis, repositories } = services;

  app.get(
    "/admin/api/knowledge-bases/:knowledgeBaseId/files/tree/search",
    middlewares.requireAuth,
    async (context) => {
      if (!repositories?.files?.searchBundleTreeEntries || !redis) {
        return missingRepositoryBackend(context);
      }

      const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(
        context.req.param("knowledgeBaseId")
      );

      if (!knowledgeBase) {
        return notFound(context);
      }

      if (!knowledgeBase.activeReleaseId) {
        return context.json({ items: [], nextCursor: null });
      }

      const searchQuery = readFileTreeSearchQuery(context.req.query("query"));

      if (!searchQuery.ok) {
        return invalidSearch(context, searchQuery.code);
      }

      const limit = readTreePageLimit(context.req.query("limit"), config);

      if (!limit) {
        return invalidPagination(context);
      }

      const cursorToken = context.req.query("cursor") ?? null;
      const cursorScope = createFileTreeSearchCursorScope({
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        query: searchQuery.query,
        limit
      });
      const repositoryCursor = cursorToken
        ? await redis.getPaginationCursor<string>(cursorScope, cursorToken)
        : null;

      if (cursorToken && !repositoryCursor) {
        return invalidPagination(context);
      }

      const cacheId = createPageResponseCacheId({
        cursorToken,
        limit,
        extra: searchQuery.query
      });
      const cachedResponse = await readPageResponseCache<{
        items: ReturnType<typeof toAdminBundleTreeSearchResult>[];
        nextCursor: string | null;
      }>({
        redis,
        scope: cursorScope,
        cacheId,
        invalidationScopes: [`file-tree:${knowledgeBase.id}:${knowledgeBase.activeReleaseId}`]
      });

      if (cachedResponse) {
        return context.json(cachedResponse);
      }

      const page = await repositories.files.searchBundleTreeEntries({
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        query: searchQuery.query,
        limit,
        cursor: repositoryCursor
      });
      const nextCursor = await writeOpaqueCursor({
        redis,
        scope: cursorScope,
        cursor: page.nextCursor,
        ttlSeconds: config.pagination.cursorTtlSeconds
      });
      const responseBody = {
        items: page.items.map(toAdminBundleTreeSearchResult),
        nextCursor
      };

      await writePageResponseCache({
        redis,
        scope: cursorScope,
        cacheId,
        value: responseBody
      });

      return context.json(responseBody);
    }
  );
}

async function writeOpaqueCursor(options: {
  redis: RedisCoordinator;
  scope: string;
  cursor: string | null;
  ttlSeconds: number;
}): Promise<string | null> {
  if (!options.cursor) {
    return null;
  }

  const cursorId = `cursor-${randomUUID()}`;
  await options.redis.setPaginationCursor(
    options.scope,
    cursorId,
    options.cursor,
    options.ttlSeconds
  );
  return cursorId;
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

function invalidSearch(
  context: Parameters<MiddlewareHandler>[0],
  code: string
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
