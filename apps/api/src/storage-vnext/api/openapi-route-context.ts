import type { RuntimeConfig } from "../../config.js";
import {
  createDeveloperOpenApiKeyService,
  requireDeveloperOpenApiAuth
} from "../../developer-openapi/security.js";
import type { RuntimeLogger } from "../../logger.js";
import type { RedisCoordinator } from "../../redis/coordination.js";
import type { RuntimeSettingsService } from "../../runtime-settings/service.js";
import type { StorageVnextAuditPort } from "../audit/ports.js";
import type { PublicOpenApiKeyRepository } from "../../public-openapi/keys.js";
import { createDeveloperOpenApiService, type DeveloperOpenApiApplication } from "./openapi-application.js";
import type { StorageVnextAdminUploadApplication } from "./admin-upload-application.js";
import { createStorageVnextOpenApiAuditApplication } from "./openapi-audit-application.js";
import type { StorageVnextAdminMutationApplication } from "./admin-mutation-application.js";

export type StorageVnextOpenApiRouteDependencies = {
  config: RuntimeConfig;
  redis: RedisCoordinator | null;
  runtimeSettings: RuntimeSettingsService | null;
  logger: RuntimeLogger;
  audit: Pick<StorageVnextAuditPort, "append"> | null;
  apiKeys: PublicOpenApiKeyRepository | null;
  uploadApplication: StorageVnextAdminUploadApplication;
  sourceApplication: StorageVnextAdminMutationApplication;
  openApiApplication: DeveloperOpenApiApplication;
};

export function createStorageVnextOpenApiRouteContext(
  dependencies: StorageVnextOpenApiRouteDependencies
) {
  const auditApplication = createStorageVnextOpenApiAuditApplication({
    config: dependencies.config,
    audit: dependencies.audit,
    logger: dependencies.logger
  });
  const security = { ...dependencies, auditApplication };
  const keyService = createDeveloperOpenApiKeyService(security);
  return {
    ...dependencies,
    api: createDeveloperOpenApiService({ backend: dependencies.openApiApplication }),
    uploadApplication: dependencies.uploadApplication,
    sourceApplication: dependencies.sourceApplication,
    auditApplication,
    requireAuth: requireDeveloperOpenApiAuth(security, keyService)
  };
}

export type StorageVnextOpenApiRouteContext = ReturnType<
  typeof createStorageVnextOpenApiRouteContext
>;
