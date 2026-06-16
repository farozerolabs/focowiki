import { randomUUID } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import type { RuntimeConfig } from "../config.js";
import type { AdminRepositories } from "../db/admin-repositories.js";
import { createPublicOpenApiKeyService } from "../public-openapi/keys.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import { recordAdminAudit } from "./security.js";

type AdminOpenApiKeyRouteServices = {
  config: RuntimeConfig;
  redis: RedisCoordinator | null;
  repositories: AdminRepositories | null;
};

type AdminOpenApiKeyRouteMiddleware = {
  requireAuth: MiddlewareHandler;
  requireWriteProtection: MiddlewareHandler;
};

export function registerAdminOpenApiKeyRoutes(
  app: Hono,
  services: AdminOpenApiKeyRouteServices,
  middleware: AdminOpenApiKeyRouteMiddleware
): void {
  const { config, redis, repositories } = services;
  const { requireAuth, requireWriteProtection } = middleware;

  app.get("/admin/api/openapi-keys", requireAuth, async (context) => {
    if (!repositories?.publicApiKeys || !redis) {
      return missingRepositoryBackend(context);
    }

    const limit = readPageLimit(context.req.query("limit"), config);

    if (!limit) {
      return invalidPagination(context);
    }

    const cursorToken = context.req.query("cursor") ?? null;
    const cursorScope = "public-openapi-keys";
    const repositoryCursor = cursorToken
      ? await redis.getPaginationCursor<string>(cursorScope, cursorToken)
      : null;

    if (cursorToken && !repositoryCursor) {
      return invalidPagination(context);
    }

    const service = createPublicOpenApiKeyService({
      repository: repositories.publicApiKeys,
      redis
    });
    const page = await service.listKeysWithBootstrap({
      limit,
      cursor: repositoryCursor
    });
    const nextCursor = await writeOpaqueCursor({
      redis,
      scope: cursorScope,
      cursor: page.nextCursor,
      ttlSeconds: config.pagination.cursorTtlSeconds
    });

    if (page.oneTimeKey) {
      await recordAdminAudit({
        repositories,
        config,
        context,
        eventType: "public_openapi_key_bootstrap",
        result: "success"
      });
    }

    return context.json({
      items: page.items,
      nextCursor,
      oneTimeKey: page.oneTimeKey
    });
  });

  app.post("/admin/api/openapi-keys", requireAuth, requireWriteProtection, async (context) => {
    if (!repositories?.publicApiKeys || !redis) {
      return missingRepositoryBackend(context);
    }

    const input = readOpenApiKeyCreateInput(await readJsonBody(context.req.raw));
    const service = createPublicOpenApiKeyService({
      repository: repositories.publicApiKeys,
      redis
    });
    const created = await service.createKey(input);

    await recordAdminAudit({
      repositories,
      config,
      context,
      eventType: "public_openapi_key_create",
      result: "success"
    });

    return context.json(
      {
        key: created.key,
        oneTimeKey: {
          id: created.key.id,
          rawKey: created.rawKey
        }
      },
      201
    );
  });

  app.delete(
    "/admin/api/openapi-keys/:keyId",
    requireAuth,
    requireWriteProtection,
    async (context) => {
      if (!repositories?.publicApiKeys || !redis) {
        return missingRepositoryBackend(context);
      }

      const service = createPublicOpenApiKeyService({
        repository: repositories.publicApiKeys,
        redis
      });
      const deleted = await service.deleteKey(context.req.param("keyId"));

      if (!deleted) {
        return notFound(context);
      }

      await recordAdminAudit({
        repositories,
        config,
        context,
        eventType: "public_openapi_key_delete",
        result: "success"
      });

      return context.json({ deleted: true });
    }
  );
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = (await request.json()) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readOpenApiKeyCreateInput(body: Record<string, unknown>): { name?: string } {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  return name ? { name } : {};
}

function readPageLimit(rawLimit: string | undefined, config: RuntimeConfig): number | null {
  if (!rawLimit) {
    return config.pagination.defaultPageSize;
  }

  const limit = Number(rawLimit);

  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    limit > config.pagination.maxPageSize
  ) {
    return null;
  }

  return limit;
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
