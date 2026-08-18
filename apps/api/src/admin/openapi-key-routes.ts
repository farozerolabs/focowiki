import { Hono, type MiddlewareHandler } from "hono";
import type { RuntimeConfig } from "../config.js";
import type { StorageVnextAdminAuditApplication } from "../storage-vnext/api/admin-audit-application.js";
import type { StorageVnextAdminOpenApiKeyApplication } from "../storage-vnext/api/admin-openapi-key-application.js";

type AdminOpenApiKeyRouteServices = {
  config: RuntimeConfig;
  application: StorageVnextAdminOpenApiKeyApplication;
  audit: StorageVnextAdminAuditApplication;
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
  const { config, application, audit } = services;
  const { requireAuth, requireWriteProtection } = middleware;

  app.get("/admin/api/openapi-keys", requireAuth, async (context) => {
    const limit = readPageLimit(context.req.query("limit"), config);

    if (!limit) {
      return invalidPagination(context);
    }

    const result = await application.listKeys({
      limit,
      cursor: context.req.query("cursor") ?? null
    });
    if (!result.ok) {
      return result.code === "INVALID_PAGINATION"
        ? invalidPagination(context)
        : missingRepositoryBackend(context);
    }
    const page = result.value;

    return context.json({
      items: page.items,
      nextCursor: page.nextCursor
    });
  });

  app.post("/admin/api/openapi-keys", requireAuth, requireWriteProtection, async (context) => {
    const input = readOpenApiKeyCreateInput(await readJsonBody(context.req.raw));
    if (!input) {
      return context.json({
        error: { code: "VALIDATION_ERROR", messageKey: "errors.openapiKeyFailed" }
      }, 422);
    }
    const result = await application.createKey(input);
    if (!result.ok) return missingRepositoryBackend(context);
    const created = result.value;

    await audit.record({
      context,
      eventType: "public_openapi_key_create",
      result: "success",
      targetKind: "public_openapi_key",
      targetPublicId: created.key.id
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
      const result = await application.deleteKey({ keyId: context.req.param("keyId") });
      if (!result.ok) return result.code === "NOT_FOUND"
        ? notFound(context)
        : missingRepositoryBackend(context);

      await audit.record({
        context,
        eventType: "public_openapi_key_delete",
        result: "success",
        targetKind: "public_openapi_key",
        targetPublicId: context.req.param("keyId")
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

function readOpenApiKeyCreateInput(body: Record<string, unknown>): { name?: string } | null {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length > 80) return null;
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
