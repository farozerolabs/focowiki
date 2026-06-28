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
import { createBaseApp } from "./app/base.js";
import type { AdminRepositories } from "./db/admin-repositories.js";
import type { RedisCoordinator } from "./redis/coordination.js";
import { registerAdminApiRoutes } from "./admin/routes.js";
import { registerDeveloperOpenApiRoutes } from "./developer-openapi/routes.js";
import { createS3StorageAdapter, type StorageAdapter } from "./storage/s3.js";
import {
  createRuntimeSettingsService,
  type RuntimeSettingsService
} from "./runtime-settings/service.js";

export type ApiAppOptions = {
  config: RuntimeConfig;
  storage?: StorageAdapter;
  modelClient?: OpenAIResponsesClient;
  redis?: RedisCoordinator;
  repositories?: AdminRepositories;
  runtimeSettings?: RuntimeSettingsService;
};

type ApiAppServices = {
  config: RuntimeConfig;
  storage: StorageAdapter;
  modelClient: OpenAIResponsesClient | null;
  sessionManager: AdminSessionManager | null;
  redis: RedisCoordinator | null;
  repositories: AdminRepositories | null;
  runtimeSettings: RuntimeSettingsService | null;
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

  registerDeveloperOpenApiRoutes(app, services);

  return app;
}

export function createApiApp(options: ApiAppOptions): Hono {
  const services = resolveApiAppServices(options);
  const app = createBaseApp(services.config);

  registerAdminApiRoutes(app, services);
  registerDeveloperOpenApiRoutes(app, services);

  return app;
}

function resolveApiAppServices(options: ApiAppOptions): ApiAppServices {
  const repositories = options.repositories ?? null;
  const runtimeSettings =
    options.runtimeSettings ??
    (repositories?.runtimeSettings
      ? createRuntimeSettingsService({
          config: options.config,
          repository: repositories.runtimeSettings,
          redis: options.redis ?? null
        })
      : null);

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
    repositories,
    runtimeSettings
  };
}
