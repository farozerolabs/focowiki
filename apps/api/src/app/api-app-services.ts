import { createAdminSessionManager } from "../auth/session.js";
import { resolveSecurityConfig } from "../config.js";
import { createRuntimeLogger } from "../logger.js";
import { createStorageVnextAdminAuditApplication } from "../storage-vnext/api/admin-audit-application.js";
import { createStorageVnextAdminCoreApplication } from "../storage-vnext/api/admin-core-application.js";
import { createStorageVnextAdminMaintenanceApplication } from "../storage-vnext/api/admin-maintenance-application.js";
import { createStorageVnextAdminMutationApplication } from "../storage-vnext/api/admin-mutation-application.js";
import { createStorageVnextAdminOpenApiKeyApplication } from "../storage-vnext/api/admin-openapi-key-application.js";
import { createStorageVnextAdminProcessingApplication } from "../storage-vnext/api/admin-processing-application.js";
import { createStorageVnextAdminReadApplication } from "../storage-vnext/api/admin-read-application.js";
import { createStorageVnextAdminSecurityApplication } from "../storage-vnext/api/admin-security-application.js";
import { createStorageVnextAdminSourceApplication } from "../storage-vnext/api/admin-source-application.js";
import { createStorageVnextAdminUploadApplication } from "../storage-vnext/api/admin-upload-application.js";
import { createStorageVnextOpenApiRouteContext } from "../storage-vnext/api/openapi-route-context.js";
import { createDeveloperOpenApiService } from "../storage-vnext/api/openapi-application.js";
import type { ApiAppOptions } from "./api-app-options.js";

export function resolveApiAppServices(options: ApiAppOptions) {
  const storageVnextAudit = options.storageVnextAudit ?? null;
  const storageVnextAdminRead = options.storageVnextAdminRead ?? null;
  const storageVnextAdminProcessing = options.storageVnextAdminProcessing ?? null;
  const runtimeSettings = options.runtimeSettings ?? null;
  const storageVnextAdminSource = options.storageVnextAdminSource ?? null;
  const logger = options.logger ?? createRuntimeLogger(options.config);
  const notifyWorker = async (
    kind: "document" | "deletion" | "maintenance"
  ): Promise<void> => {
    try {
      await options.redis?.notifyWorkerWork(kind);
    } catch {
      logger.warn("worker.wakeup_publish_failed", { kind });
    }
  };
  const sessionManager = options.redis
    ? createAdminSessionManager(
        options.config.admin,
        options.redis,
        resolveSecurityConfig(options.config).session
      )
    : null;
  const storageVnextAdminUpload = options.storageVnextAdminUpload ?? null;
  const storageVnextAdminMutation = options.storageVnextAdminMutation ?? null;
  const storageVnextAdminCore = options.storageVnextAdminCore ?? null;
  const uploadApplication = createStorageVnextAdminUploadApplication({
    backend: storageVnextAdminUpload,
    onWorkAccepted: () => notifyWorker("document")
  });
  const sourceApplication = createStorageVnextAdminSourceApplication({
    backend: storageVnextAdminSource,
    onDocumentWorkAccepted: () => notifyWorker("document"),
    onDeletionWorkAccepted: () => notifyWorker("deletion")
  });
  const mutationApplication = createStorageVnextAdminMutationApplication({
    backend: storageVnextAdminMutation,
    onDocumentWorkAccepted: () => notifyWorker("document"),
    onDeletionWorkAccepted: () => notifyWorker("deletion")
  });
  const adminAuditApplication = createStorageVnextAdminAuditApplication({
    config: options.config,
    audit: storageVnextAudit,
    logger
  });
  const storageVnextOpenApi = options.storageVnextOpenApi ?? null;
  const developerOpenApiContext = createStorageVnextOpenApiRouteContext({
    config: options.config,
    redis: options.redis ?? null,
    runtimeSettings,
    logger,
    audit: storageVnextAudit,
    apiKeys: options.storageVnextApiKeys ?? null,
    uploadApplication,
    sourceApplication: mutationApplication,
    openApiApplication: createDeveloperOpenApiService({
      backend: storageVnextOpenApi
    })
  });

  return {
    developerOpenApiContext,
    adminAuditApplication,
    adminSecurityApplication: createStorageVnextAdminSecurityApplication({
      config: options.config,
      sessionManager,
      redis: options.redis ?? null,
      audit: adminAuditApplication,
      runtimeSettings
    }),
    adminApplication: createStorageVnextAdminReadApplication({
      backend: storageVnextAdminRead
    }),
    adminProcessingApplication: createStorageVnextAdminProcessingApplication({
      backend: storageVnextAdminProcessing
    }),
    adminSourceApplication: sourceApplication,
    adminMaintenanceApplication: createStorageVnextAdminMaintenanceApplication({
      backend: options.storageVnextAdminMaintenance ?? null,
      catalog: options.storageVnextCatalog ?? null,
      requests: options.storageVnextMaintenanceRequests ?? null,
      status: options.storageVnextMaintenanceStatus ?? null,
      runtimeSettings,
      semanticAdoption: options.semanticAdoption ?? null,
      semanticCancellation: options.semanticCancellation ?? null,
      cancellationCleanup: options.maintenanceCancellationCleanup ?? null,
      onWorkAccepted: () => notifyWorker("maintenance")
    }),
    adminUploadApplication: uploadApplication,
    adminOpenApiKeyApplication: createStorageVnextAdminOpenApiKeyApplication({
      config: options.config,
      repository: options.storageVnextApiKeys ?? null,
      redis: options.redis ?? null
    }),
    adminMutationApplication: mutationApplication,
    adminCoreApplication: createStorageVnextAdminCoreApplication({
      backend: storageVnextAdminCore
    }),
    config: options.config,
    sessionManager,
    redis: options.redis ?? null,
    runtimeSettings,
    embeddingConfigurations: options.embeddingConfigurations ?? null,
    rerankerConfigurations: options.rerankerConfigurations ?? null,
    logger
  };
}
