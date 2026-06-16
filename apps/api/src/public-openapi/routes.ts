import { Hono, type MiddlewareHandler } from "hono";
import type { RuntimeConfig } from "../config.js";
import type { AdminRepositories } from "../db/admin-repositories.js";
import type { StorageAdapter } from "../storage/s3.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import { recordSecurityAudit } from "../security/audit.js";
import { requireRateLimit } from "../security/rate-limit.js";
import {
  applyPublicCors,
  invalidPath,
  isAllowedPublicLogicalPath,
  publicResponseHeaders,
  unsupportedPublicMethod
} from "./security.js";
import {
  createPublicOpenApiKeyService,
  type PublicOpenApiKeyService
} from "./keys.js";

export type PublicOpenApiRouteServices = {
  config: RuntimeConfig;
  storage: StorageAdapter;
  repositories: AdminRepositories | null;
  redis: RedisCoordinator | null;
};

export function registerPublicOpenApiRoutes(
  app: Hono,
  services: PublicOpenApiRouteServices
): void {
  const { config, storage, repositories, redis } = services;
  const keyService = repositories?.publicApiKeys
    ? createPublicOpenApiKeyService({
        repository: repositories.publicApiKeys,
        redis
      })
    : null;
  const requireManagedKey = requirePublicAuth({
    keyService,
    repositories,
    config
  });

  app.use("/kb/*", applyPublicCors(config));
  app.use("/kb/*", async (context, next) => {
    const limited = await requireRateLimit({
      config,
      redis,
      context,
      scope: "public-openapi",
      limit: config.security?.rateLimits.publicOpenApi ?? {
        max: 1_200,
        windowSeconds: 60
      }
    });

    if (limited) {
      await recordSecurityAudit({
        repositories,
        config,
        context,
        eventType: "public_openapi_rate_limited",
        result: "blocked",
        errorCode: "RATE_LIMITED"
      });
      return limited;
    }

    await next();
  });

  app.get("/kb/:knowledgeBaseId/tasks/latest", requireManagedKey, async (context) =>
    servePublicLatestTaskStatus(context, repositories)
  );
  app.get("/kb/:knowledgeBaseId/index.md", requireManagedKey, async (context) =>
    serveScopedPublicFile(context, repositories, storage, "index.md", config)
  );
  app.get("/kb/:knowledgeBaseId/log.md", requireManagedKey, async (context) =>
    serveScopedPublicFile(context, repositories, storage, "log.md", config)
  );
  app.get("/kb/:knowledgeBaseId/schema.md", requireManagedKey, async (context) =>
    serveScopedPublicFile(context, repositories, storage, "schema.md", config)
  );
  app.get("/kb/:knowledgeBaseId/pages/*", requireManagedKey, async (context) =>
    serveScopedPublicFile(context, repositories, storage, scopedPublicPathFromRequest(context), config)
  );
  app.get("/kb/:knowledgeBaseId/_index/*", requireManagedKey, async (context) =>
    serveScopedPublicFile(context, repositories, storage, scopedPublicPathFromRequest(context), config)
  );
  app.on(["POST", "PUT", "PATCH", "DELETE"], "/kb/:knowledgeBaseId/*", (context) =>
    unsupportedPublicMethod(context)
  );
}

function requirePublicAuth(options: {
  keyService: PublicOpenApiKeyService | null;
  repositories: AdminRepositories | null;
  config: RuntimeConfig;
}): MiddlewareHandler {
  return async (context, next) => {
    if (!options.keyService) {
      return context.json(
        {
          error: {
            code: "DATABASE_REPOSITORY_UNAVAILABLE"
          }
        },
        503
      );
    }

    const token = readBearerToken(context.req.header("authorization"));

    if (!token || !(await options.keyService.authorize(token)).authorized) {
      await recordSecurityAudit({
        repositories: options.repositories,
        config: options.config,
        context,
        eventType: "public_openapi_auth",
        result: "failure",
        errorCode: "UNAUTHORIZED"
      });
      return unauthorized(context);
    }

    await next();
  };
}

async function serveScopedPublicFile(
  context: Parameters<MiddlewareHandler>[0],
  repositories: AdminRepositories | null,
  storage: StorageAdapter,
  logicalPath: string,
  config: RuntimeConfig
): Promise<Response> {
  if (!repositories?.files) {
    return context.json(
      {
        error: {
          code: "DATABASE_REPOSITORY_UNAVAILABLE"
        }
      },
      503
    );
  }

  const knowledgeBaseId = context.req.param("knowledgeBaseId");

  if (!knowledgeBaseId || !isAllowedPublicLogicalPath(logicalPath)) {
    return invalidPath(context);
  }

  const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(knowledgeBaseId);

  if (!knowledgeBase?.activeReleaseId) {
    return notFound(context);
  }

  const file = await repositories.files.getBundleFile({
    knowledgeBaseId: knowledgeBase.id,
    releaseId: knowledgeBase.activeReleaseId,
    logicalPath
  });

  if (!file) {
    return notFound(context);
  }

  const content = storage.getObjectBody
    ? await storage.getObjectBody(file.objectKey)
    : await storage.getObjectText(file.objectKey);

  if (content === null) {
    return notFound(context);
  }

  return new Response(content, {
    headers: publicResponseHeaders(file.logicalPath, context, config)
  });
}

async function servePublicLatestTaskStatus(
  context: Parameters<MiddlewareHandler>[0],
  repositories: AdminRepositories | null
): Promise<Response> {
  if (!repositories?.tasks?.getLatestUploadTask) {
    return context.json(
      {
        error: {
          code: "DATABASE_REPOSITORY_UNAVAILABLE"
        }
      },
      503
    );
  }

  const knowledgeBaseId = context.req.param("knowledgeBaseId");

  if (!knowledgeBaseId) {
    return notFound(context);
  }

  const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(knowledgeBaseId);

  if (!knowledgeBase) {
    return notFound(context);
  }

  const task = await repositories.tasks.getLatestUploadTask(knowledgeBase.id);

  if (!task) {
    return notFound(context);
  }

  return context.json({
    knowledgeBaseId: task.knowledgeBaseId,
    taskId: task.id,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    lifecycle: task.endedAt ? "ended" : "running"
  });
}

function scopedPublicPathFromRequest(context: Parameters<MiddlewareHandler>[0]): string {
  const knowledgeBaseId = context.req.param("knowledgeBaseId");
  const pathname = new URL(context.req.raw.url).pathname;
  const prefix = `/kb/${knowledgeBaseId}/`;
  const scopedPath = pathname.startsWith(prefix)
    ? pathname.slice(prefix.length)
    : pathname.replace(/^\/+/, "");

  return decodeScopedPublicPath(scopedPath);
}

function decodeScopedPublicPath(path: string): string {
  let decoded = path;

  for (let index = 0; index < 3; index += 1) {
    try {
      const next = decodeURIComponent(decoded);

      if (next === decoded) {
        break;
      }

      decoded = next;
    } catch {
      break;
    }
  }

  return decoded;
}

function readBearerToken(authorization: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
  return match?.[1] ?? null;
}

function unauthorized(context: Parameters<MiddlewareHandler>[0]): Response {
  return context.json(
    {
      error: {
        code: "UNAUTHORIZED"
      }
    },
    401
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
