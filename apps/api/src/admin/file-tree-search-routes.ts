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
import { toAdminActiveTreeEntry } from "./active-generation-serializers.js";
import type { ActiveGenerationReadRepository } from "../application/ports/active-generation-read-repository.js";
import { readGenerationCursor, writeGenerationCursor } from "./generation-pagination.js";

export function registerAdminFileTreeSearchRoutes(
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
    "/admin/api/knowledge-bases/:knowledgeBaseId/files/tree/search",
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

      const searchQuery = readFileTreeSearchQuery(context.req.query("query"));

      if (!searchQuery.ok) {
        return invalidSearch(context, searchQuery.code);
      }

      const limit = readTreePageLimit(context.req.query("limit"), config);

      if (!limit) {
        return invalidPagination(context);
      }

      const cursorToken = context.req.query("cursor") ?? null;
      const paginationScope = createFileTreeSearchCursorScope({
        knowledgeBaseId: knowledgeBase.id,
        generationId: null,
        query: searchQuery.query,
        limit
      });
      const storedCursor = await readGenerationCursor<{
        sortKey: string;
        recordId: string;
      }>({ redis, scope: paginationScope, token: cursorToken });
      if (storedCursor === undefined) {
        return invalidPagination(context);
      }
      const result = await activeGenerationReads.withActiveGeneration(
        knowledgeBase.id,
        async (scope) => {
          if (storedCursor && storedCursor.generationId !== scope.generationId) {
            return { invalidCursor: true as const };
          }
          const cacheScope = createFileTreeSearchCursorScope({
            knowledgeBaseId: knowledgeBase.id,
            generationId: scope.generationId,
            query: searchQuery.query,
            limit
          });
          const cacheId = createPageResponseCacheId({
            cursorToken,
            limit,
            extra: searchQuery.query
          });
          const cached = await readPageResponseCache<{
            items: Array<{
              entry: ReturnType<typeof toAdminActiveTreeEntry>;
              ancestors: ReturnType<typeof toAdminActiveTreeEntry>[];
            }>;
            nextCursor: string | null;
          }>({ redis, scope: cacheScope, cacheId });
          if (cached) return { invalidCursor: false as const, response: cached };
          const page = await scope.listTree({
            parentPath: "",
            entryType: null,
            query: searchQuery.query,
            limit,
            cursor: storedCursor?.value ?? null
          });
          const paths = page.items
            .map((item) => item.path)
            .filter((path): path is string => Boolean(path));
          const ancestors = await scope.listTreeAncestors(paths);
          const nextCursor = await writeGenerationCursor({
            redis,
            scope: paginationScope,
            generationId: scope.generationId,
            value: page.nextCursor,
            ttlSeconds: config.pagination.cursorTtlSeconds
          });
          const response = {
            items: page.items.map((item) => ({
              entry: toAdminActiveTreeEntry(item),
              ancestors: (item.path ? ancestors.get(item.path) : [])?.map(toAdminActiveTreeEntry) ?? []
            })),
            nextCursor
          };
          await writePageResponseCache({ redis, scope: cacheScope, cacheId, value: response });
          return { invalidCursor: false as const, response };
        }
      );
      if (result?.invalidCursor) return invalidPagination(context);
      if (!result) return context.json({ items: [], nextCursor: null });
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
