import { createOpenAIModelClient } from "@focowiki/okf";
import { Hono } from "hono";
import { resolveSecurityConfig } from "./config.js";
import {
  createAdminSessionManager
} from "./auth/session.js";
import { createBaseApp } from "./app/base.js";
import type { ApiAppOptions } from "./app/api-app-options.js";
import { registerAdminApiRoutes } from "./admin/routes.js";
import { registerDeveloperOpenApiRoutes } from "./developer-openapi/routes.js";
import { createS3StorageAdapter } from "./storage/s3.js";
import {
  createRuntimeSettingsService
} from "./runtime-settings/service.js";
import { systemApplicationRuntime } from "./infrastructure/runtime/system-runtime.js";
import { createUploadSessionStoragePort } from "./infrastructure/storage/upload-session-storage.js";
import { createRuntimeLogger } from "./logger.js";
export type { ApiAppOptions } from "./app/api-app-options.js";
export function createAdminApiApp(options: ApiAppOptions): Hono {
  const services = resolveApiAppServices(options);
  const app = createBaseApp(services.config, services.logger);
  registerAdminApiRoutes(app, services);

  return app;
}
export function createPublicOpenApiApp(options: ApiAppOptions): Hono {
  const services = resolveApiAppServices(options);
  const app = createBaseApp(services.config, services.logger);

  registerDeveloperOpenApiRoutes(app, services);

  return app;
}

export function createApiApp(options: ApiAppOptions): Hono {
  const services = resolveApiAppServices(options);
  const app = createBaseApp(services.config, services.logger);

  registerAdminApiRoutes(app, services);
  registerDeveloperOpenApiRoutes(app, services);

  return app;
}

function resolveApiAppServices(options: ApiAppOptions) {
  const repositories = options.repositories ?? null;
  const storage = options.storage ?? createS3StorageAdapter(options.config.storage);
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
    storage,
    modelClient:
      options.modelClient ??
      (options.config.model.enabled
        ? createOpenAIModelClient({
            apiMode: "responses",
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
    runtimeSettings,
    applicationRuntime: systemApplicationRuntime,
    uploadSessionStorage: createUploadSessionStoragePort(storage),
    logger: options.logger ?? createRuntimeLogger(options.config),
    activeGenerationReads: options.activeGenerationReads ?? null,
    roleJobs: options.roleJobs ?? null,
    publicationGenerations: options.publicationGenerations ?? null,
    sourceDispatch: options.sourceDispatch ?? null,
    sourceFileRetries: options.sourceFileRetries ?? null,
    sourceFileTaskDeletions: options.sourceFileTaskDeletions ?? null,
    storageReconciliation: options.storageReconciliation ?? null,
    objectProtection: options.objectProtection ?? null,
    maintenanceProgress: options.maintenanceProgress ?? null,
    knowledgeBaseIndexMaintenance: options.knowledgeBaseIndexMaintenance ?? null
  };
}
