import { randomUUID } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import type { RuntimeConfig } from "../config.js";
import type { AdminRepositories } from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import {
  createBundleTreeCursorScope,
  readTreeEntryTypeFilter
} from "../tree-entry-filters.js";
import { readTreePageLimit } from "./pagination.js";
import {
  createPageResponseCacheId,
  readPageResponseCache,
  writePageResponseCache
} from "../page-response-cache.js";
import { toAdminBundleTreeEntry } from "./serializers.js";

export function registerAdminFileTreeRoutes(
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
    "/admin/api/knowledge-bases/:knowledgeBaseId/files/tree",
    middlewares.requireAuth,
    async (context) => {
      if (!repositories?.files || !redis) {
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

      const limit = readTreePageLimit(context.req.query("limit"), config);

      if (!limit) {
        return invalidPagination(context);
      }

      const parentPath = context.req.query("parentPath") ?? "";
      const entryType = readTreeEntryTypeFilter(context.req.query("entryType"));

      if (entryType === undefined) {
        return invalidTreeFilter(context);
      }

      const cursorToken = context.req.query("cursor") ?? null;
      const cursorScope = createBundleTreeCursorScope({
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        parentPath,
        entryType,
        scopePrefix: "file-tree"
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
        extra: parentPath
      });
      const cachedResponse = await readPageResponseCache<{
        items: ReturnType<typeof toAdminBundleTreeEntry>[];
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

      const page = await repositories.files.listBundleTreeEntries({
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        parentPath,
        entryType,
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
        items: page.items.map(toAdminBundleTreeEntry),
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

function invalidTreeFilter(context: Parameters<MiddlewareHandler>[0]): Response {
  return context.json(
    {
      error: {
        code: "INVALID_TREE_FILTER"
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
