import { timingSafeEqual } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import type { RuntimeConfig } from "../config.js";
import type { AdminRepositories } from "../db/admin-repositories.js";
import type { StorageAdapter } from "../storage/s3.js";

export type PublicOpenApiRouteServices = {
  config: RuntimeConfig;
  storage: StorageAdapter;
  repositories: AdminRepositories | null;
};

export function registerPublicOpenApiRoutes(
  app: Hono,
  services: PublicOpenApiRouteServices
): void {
  const { config, storage, repositories } = services;

  app.get("/kb/:knowledgeBaseId/tasks/latest", requirePublicAuth(config), async (context) =>
    servePublicLatestTaskStatus(context, repositories)
  );
  app.get("/kb/:knowledgeBaseId/index.md", requirePublicAuth(config), async (context) =>
    serveScopedPublicFile(context, repositories, storage, "index.md", config)
  );
  app.get("/kb/:knowledgeBaseId/schema.md", requirePublicAuth(config), async (context) =>
    serveScopedPublicFile(context, repositories, storage, "schema.md", config)
  );
  app.get("/kb/:knowledgeBaseId/pages/*", requirePublicAuth(config), async (context) =>
    serveScopedPublicFile(context, repositories, storage, scopedPublicPathFromRequest(context), config)
  );
  app.get("/kb/:knowledgeBaseId/sources/*", requirePublicAuth(config), async (context) =>
    serveScopedPublicFile(context, repositories, storage, scopedPublicPathFromRequest(context), config)
  );
  app.get("/kb/:knowledgeBaseId/_index/*", requirePublicAuth(config), async (context) =>
    serveScopedPublicFile(context, repositories, storage, scopedPublicPathFromRequest(context), config)
  );
}

function requirePublicAuth(config: RuntimeConfig): MiddlewareHandler {
  return async (context, next) => {
    if (!config.publicApi.authRequired) {
      await next();
      return;
    }

    const token = readBearerToken(context.req.header("authorization"));

    if (!token || !config.publicApi.apiKey || !secureTokenEquals(token, config.publicApi.apiKey)) {
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

  if (!knowledgeBaseId) {
    return notFound(context);
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

function publicResponseHeaders(
  path: string,
  context: Parameters<MiddlewareHandler>[0],
  config: RuntimeConfig
): Headers {
  const headers = new Headers({
    "content-type": contentTypeForPath(path)
  });
  const origin = context.req.header("origin");

  if (origin && config.corsOrigins.includes(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
  }

  return headers;
}

function contentTypeForPath(path: string): string {
  return path.endsWith(".json")
    ? "application/json; charset=utf-8"
    : "text/markdown; charset=utf-8";
}

function readBearerToken(authorization: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
  return match?.[1] ?? null;
}

function secureTokenEquals(value: string, expected: string): boolean {
  const valueBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);

  if (valueBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(valueBuffer, expectedBuffer);
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
