import { Hono, type MiddlewareHandler } from "hono";
import type { RuntimeConfig } from "../config.js";
import { readTreeEntryTypeFilter } from "../tree-entry-filters.js";
import { readTreePageLimit } from "./pagination.js";
import type { StorageVnextAdminReadApplication } from "../storage-vnext/api/admin-read-application.js";

export function registerAdminFileTreeRoutes(
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
    "/admin/api/knowledge-bases/:knowledgeBaseId/files/tree",
    middlewares.requireAuth,
    async (context) => {
      const limit = readTreePageLimit(context.req.query("limit"), config);

      if (!limit) {
        return invalidPagination(context);
      }

      const parentPath = context.req.query("parentPath") ?? "";
      const entryType = readTreeEntryTypeFilter(context.req.query("entryType"));

      if (entryType === undefined) {
        return invalidTreeFilter(context);
      }

      const result = await application.listTree({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        parentPath,
        entryType,
        limit,
        cursor: context.req.query("cursor") ?? null
      });
      if (!result.ok) return applicationError(context, result.code);
      return context.json(result.value);
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

function applicationError(
  context: Parameters<MiddlewareHandler>[0],
  code: "DATABASE_REPOSITORY_UNAVAILABLE" | "INVALID_PAGINATION" | "NOT_FOUND"
): Response {
  if (code === "DATABASE_REPOSITORY_UNAVAILABLE") return missingRepositoryBackend(context);
  if (code === "INVALID_PAGINATION") return invalidPagination(context);
  return notFound(context);
}
