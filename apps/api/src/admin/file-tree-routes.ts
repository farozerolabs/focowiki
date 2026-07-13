import { Hono, type MiddlewareHandler } from "hono";
import type { RuntimeConfig } from "../config.js";
import type { AdminRepositories } from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import {
  createBundleTreeCursorScope,
  createBundleTreeSnapshotCursorScope,
  readTreeEntryTypeFilter
} from "../tree-entry-filters.js";
import { readTreePageLimit } from "./pagination.js";
import {
  createPageResponseCacheId,
  readPageResponseCache,
  writePageResponseCache
} from "../page-response-cache.js";
import { toAdminBundleTreeEntry } from "./serializers.js";
import {
  resolveReleaseSnapshotPage,
  writeReleaseSnapshotCursor
} from "./release-snapshot-pagination.js";

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
      const paginationScope = createBundleTreeSnapshotCursorScope({
        knowledgeBaseId: knowledgeBase.id,
        parentPath,
        entryType,
        scopePrefix: "file-tree"
      });
      const snapshot = await resolveReleaseSnapshotPage({
        redis,
        scope: paginationScope,
        cursorToken,
        activeReleaseId: knowledgeBase.activeReleaseId
      });

      if (!snapshot) {
        return invalidPagination(context);
      }

      const cacheScope = createBundleTreeCursorScope({
        knowledgeBaseId: knowledgeBase.id,
        releaseId: snapshot.releaseId,
        parentPath,
        entryType,
        scopePrefix: "file-tree"
      });

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
        scope: cacheScope,
        cacheId,
        invalidationScopes: [`file-tree:${knowledgeBase.id}:${snapshot.releaseId}`]
      });

      if (cachedResponse) {
        return context.json(cachedResponse);
      }

      const page = await repositories.files.listBundleTreeEntries({
        knowledgeBaseId: knowledgeBase.id,
        releaseId: snapshot.releaseId,
        parentPath,
        entryType,
        limit,
        cursor: snapshot.repositoryCursor
      });
      const nextCursor = await writeReleaseSnapshotCursor({
        redis,
        scope: paginationScope,
        releaseId: snapshot.releaseId,
        repositoryCursor: page.nextCursor,
        ttlSeconds: config.pagination.cursorTtlSeconds
      });

      const responseBody = {
        items: page.items.map(toAdminBundleTreeEntry),
        nextCursor
      };

      await writePageResponseCache({
        redis,
        scope: cacheScope,
        cacheId,
        value: responseBody
      });

      return context.json(responseBody);
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
