import {
  createOpenAIResponsesClient,
  type OpenAIResponsesClient
} from "@focowiki/okf";
import { Hono } from "hono";
import { resolveSecurityConfig, type RuntimeConfig } from "./config.js";
import {
  createAdminSessionManager,
  type AdminSessionManager
} from "./auth/session.js";
import type { AdminRepositories } from "./db/admin-repositories.js";
import type { RedisCoordinator } from "./redis/coordination.js";
import { registerAdminApiRoutes } from "./admin/routes.js";
import { registerPublicOpenApiRoutes } from "./public-openapi/routes.js";
import { createS3StorageAdapter, type StorageAdapter } from "./storage/s3.js";
import { applySecurityHeaders } from "./security/headers.js";

export type ApiAppOptions = {
  config: RuntimeConfig;
  storage?: StorageAdapter;
  modelClient?: OpenAIResponsesClient;
  redis?: RedisCoordinator;
  repositories?: AdminRepositories;
};

type ApiAppServices = {
  config: RuntimeConfig;
  storage: StorageAdapter;
  modelClient: OpenAIResponsesClient | null;
  sessionManager: AdminSessionManager | null;
  redis: RedisCoordinator | null;
  repositories: AdminRepositories | null;
};

export function createAdminApiApp(options: ApiAppOptions): Hono {
  const services = resolveApiAppServices(options);
  const app = createBaseApp(services.config);

  registerAdminApiRoutes(app, services);

  return app;
}

export function createPublicOpenApiApp(options: ApiAppOptions): Hono {
  const services = resolveApiAppServices(options);
  const app = createBaseApp(services.config);

  registerPublicOpenApiRoutes(app, services);

  return app;
}

export function createApiApp(options: ApiAppOptions): Hono {
  const services = resolveApiAppServices(options);
  const app = createBaseApp(services.config);

  registerAdminApiRoutes(app, services);
  registerPublicOpenApiRoutes(app, services);

  return app;
}

function resolveApiAppServices(options: ApiAppOptions): ApiAppServices {
  return {
    config: options.config,
    storage: options.storage ?? createS3StorageAdapter(options.config.storage),
    modelClient:
      options.modelClient ??
      (options.config.model.enabled
        ? createOpenAIResponsesClient({
            apiKey: options.config.model.apiKey,
            baseUrl: options.config.model.baseUrl,
            requestTimeoutMs: options.config.model.requestMaxTimeoutMs
          })
        : null),
    sessionManager: options.redis
      ? createAdminSessionManager(
          options.config.admin,
          options.redis,
          resolveSecurityConfig(options.config).session
        )
      : null,
    redis: options.redis ?? null,
    repositories: options.repositories ?? null
  };
}

function createBaseApp(config: RuntimeConfig): Hono {
  const app = new Hono();

  app.use("*", applySecurityHeaders(config));
  app.use("*", async (context, next) => {
    if (containsTraversal(context.req.raw.url)) {
      return context.json(
        {
          error: {
            code: "INVALID_PATH"
          }
        },
        400
      );
    }

    await next();
  });
  app.notFound((context) =>
    context.json(
      {
        error: {
          code: "NOT_FOUND"
        }
      },
      404
    )
  );

  return app;
}


function containsTraversal(rawUrl: string): boolean {
  const path = rawUrl.replace(/^[a-z]+:\/\/[^/]+/i, "").split("?")[0] ?? "";
  let decoded = path;

  for (let index = 0; index < 3; index += 1) {
    try {
      const next = decodeURIComponent(decoded);

      if (next === decoded) {
        break;
      }

      decoded = next;
    } catch {
      return true;
    }
  }

  return decoded
    .split("/")
    .some((segment) => segment === ".." || segment.includes("\\"));
}
