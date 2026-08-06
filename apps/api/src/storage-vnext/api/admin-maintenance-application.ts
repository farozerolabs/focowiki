import { randomUUID } from "node:crypto";
import type { RuntimeSettingsService } from "../../runtime-settings/service.js";
import type { StorageVnextCatalogReadPort } from "../catalog/ports.js";
import type { createStorageVnextMaintenanceRequestService } from "../maintenance/maintenance-coordinator.js";
import type { StorageVnextMaintenanceRepository } from "../maintenance/ports.js";

const MAINTENANCE_RESULT_RETENTION_MS = 24 * 60 * 60 * 1_000;

export type StorageVnextAdminMaintenanceApplication = {
  requestMaintenance(request: {
    knowledgeBaseId: string;
    idempotencyKey: string;
  }): Promise<
    | { available: false }
    | { available: true; result: { outcome: "not_found" | "deleted" } }
    | {
        available: true;
        result: {
          outcome: "accepted" | "already_active";
          request: {
            id: string | null;
            state: string;
            trigger: "manual" | "automatic" | null;
            stage: string | null;
            completedCount: number;
            expectedCount: number;
            retryCount: number;
            lastProgressAt: string | null;
            completedAt: string | null;
            lastErrorCode: string | null;
            lastErrorMessage: string | null;
          };
        };
      }
  >;
};

function createStorageVnextAdminMaintenanceBackend(input: {
  catalog: StorageVnextCatalogReadPort | null;
  requests: ReturnType<typeof createStorageVnextMaintenanceRequestService> | null;
  status: Pick<StorageVnextMaintenanceRepository, "getStatus"> | null;
  runtimeSettings: RuntimeSettingsService | null;
}): StorageVnextAdminMaintenanceApplication {
  return {
    async requestMaintenance(request: {
      knowledgeBaseId: string;
      idempotencyKey: string;
    }) {
      if (!input.catalog || !input.requests || !input.status || !input.runtimeSettings) {
        return { available: false as const };
      }
      const knowledgeBase = await input.catalog.getKnowledgeBase({
        knowledgeBaseId: request.knowledgeBaseId,
        visibility: "all"
      });
      if (!knowledgeBase) {
        return { available: true as const, result: { outcome: "not_found" as const } };
      }
      if (knowledgeBase.visibility === "deleted") {
        return { available: true as const, result: { outcome: "deleted" as const } };
      }
      const now = new Date();
      const settings = await input.runtimeSettings.getSnapshot();
      const settingsRevision = await input.runtimeSettings.getCurrentRevision();
      const accepted = await input.requests.requestMaintenance({
        knowledgeBaseId: request.knowledgeBaseId,
        operationPublicId: `maintenance-${randomUUID()}`,
        trigger: "manual",
        idempotencyKey: request.idempotencyKey,
        expectedResourceRevision: knowledgeBase.revision,
        settingsRevisionPublicId: settingsRevision.publicId,
        requestedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + MAINTENANCE_RESULT_RETENTION_MS).toISOString(),
        maxAttempts: settings.maintenance.maxAttempts
      });
      const status = await input.status.getStatus({
        knowledgeBaseId: request.knowledgeBaseId
      });
      return {
        available: true as const,
        result: {
          outcome: accepted.outcome === "queued" ? "accepted" as const : "already_active" as const,
          request: {
            id: status.requestId,
            state: status.state,
            trigger: status.trigger,
            stage: status.stage,
            completedCount: status.completedCount,
            expectedCount: status.expectedCount,
            retryCount: status.retryCount,
            lastProgressAt: status.lastProgressAt,
            completedAt: status.lastCompletedAt,
            lastErrorCode: status.safeErrorCode,
            lastErrorMessage: status.safeErrorMessage
          }
        }
      };
    }
  };
}

export function createStorageVnextAdminMaintenanceApplication(input: {
  backend?: StorageVnextAdminMaintenanceApplication | null;
  catalog: StorageVnextCatalogReadPort | null;
  requests: ReturnType<typeof createStorageVnextMaintenanceRequestService> | null;
  status: Pick<StorageVnextMaintenanceRepository, "getStatus"> | null;
  runtimeSettings: RuntimeSettingsService | null;
}): StorageVnextAdminMaintenanceApplication {
  return input.backend ?? createStorageVnextAdminMaintenanceBackend(input);
}
