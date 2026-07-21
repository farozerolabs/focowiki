import { Hono, type MiddlewareHandler } from "hono";
import type { RuntimeConfig } from "../config.js";
import type { AdminRepositories } from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import {
  createGeneratedTreeCursorScope,
  readTreeEntryTypeFilter
} from "../tree-entry-filters.js";
import { readTreePageLimit } from "./pagination.js";
import { readPageResponseCache, writePageResponseCache } from "../page-response-cache.js";
import {
  createActiveReadCacheScope,
  createActiveReadPageCacheId
} from "../active-read-cache-scope.js";
import { toAdminActiveTreeEntry } from "./active-generation-serializers.js";
import {
  readGenerationCursor,
  writeGenerationCursor
} from "./generation-pagination.js";
import type { ActiveGenerationReadRepository } from "../application/ports/active-generation-read-repository.js";

export function registerAdminFileTreeRoutes(
  app: Hono,
  services: {
    config: RuntimeConfig;
    redis: RedisCoordinator | null;
    repositories: AdminRepositories | null;
    activeGenerationReads: ActiveGenerationReadRepository | null;
  },
  middlewares: {
    requireAuth: MiddlewareHandler;
  }
): void {
  const { config, redis, repositories, activeGenerationReads } = services;

  app.get(
    "/admin/api/knowledge-bases/:knowledgeBaseId/files/tree",
    middlewares.requireAuth,
    async (context) => {
      if (!repositories || !redis || !activeGenerationReads) {
        return missingRepositoryBackend(context);
      }

      const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(
        context.req.param("knowledgeBaseId")
      );

      if (!knowledgeBase) {
        return notFound(context);
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
      const paginationScope = createGeneratedTreeCursorScope({
        knowledgeBaseId: knowledgeBase.id,
        generationId: null,
        parentPath,
        entryType,
        scopePrefix: "file-tree"
      });
      const storedCursor = await readGenerationCursor<{
        sortKey: string;
        recordId: string;
      }>({
        redis,
        scope: paginationScope,
        token: cursorToken
      });
      if (storedCursor === undefined) {
        return invalidPagination(context);
      }
      const result = await activeGenerationReads.withActiveGeneration(
        knowledgeBase.id,
        async (scope) => {
          if (storedCursor && storedCursor.generationId !== scope.generationId) {
            return { invalidCursor: true as const };
          }
          const cacheScope = createActiveReadCacheScope({
            authorizationScope: "admin",
            operation: "tree",
            knowledgeBaseId: knowledgeBase.id,
            generationId: scope.generationId,
            filters: { parentPath, entryType }
          });
          const cacheId = createActiveReadPageCacheId({
            cursorToken,
            limit,
            input: { parentPath, entryType }
          });
          const cached = await readPageResponseCache<{
            items: ReturnType<typeof toAdminActiveTreeEntry>[];
            nextCursor: string | null;
          }>({ redis, scope: cacheScope, cacheId });
          if (cached) return { invalidCursor: false as const, response: cached };
          const page = await scope.listTree({
            parentPath,
            entryType,
            query: null,
            limit,
            cursor: storedCursor?.value ?? null
          });
          const nextCursor = await writeGenerationCursor({
            redis,
            scope: paginationScope,
            generationId: scope.generationId,
            value: page.nextCursor,
            ttlSeconds: config.pagination.cursorTtlSeconds
          });
          const response = {
            items: page.items.map(toAdminActiveTreeEntry),
            nextCursor
          };
          await writePageResponseCache({ redis, scope: cacheScope, cacheId, value: response });
          return { invalidCursor: false as const, response };
        }
      );
      if (result?.invalidCursor) {
        return invalidPagination(context);
      }
      if (!result) {
        return context.json({ items: [], nextCursor: null });
      }
      return context.json(result.response);
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
