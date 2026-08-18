import { randomUUID } from "node:crypto";
import type { RuntimeSettingsService } from "../../runtime-settings/service.js";
import type { StorageVnextCatalogReadPort } from "../catalog/ports.js";
import type { createStorageVnextMaintenanceRequestService } from "../maintenance/maintenance-coordinator.js";
import type { StorageVnextMaintenanceRepository } from "../maintenance/ports.js";
import type { StorageVnextSemanticAdoptionSnapshot } from
  "../maintenance/ports.js";

const MAINTENANCE_RESULT_RETENTION_MS = 24 * 60 * 60 * 1_000;

export type StorageVnextAdminMaintenanceApplication = {
  getMaintenanceStatus(request: {
    knowledgeBaseId: string;
  }): Promise<
    | { available: false }
    | { available: true; status: Awaited<ReturnType<StorageVnextMaintenanceRepository["getStatus"]>> }
  >;
  requestMaintenance(request: {
    knowledgeBaseId: string;
    idempotencyKey: string;
  }): Promise<
    | { available: false }
    | { available: true; result: {
        outcome: "not_found" | "deleted" | "configuration_required";
        safeCode?: string;
      } }
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
  cancelMaintenance(request: {
    knowledgeBaseId: string;
  }): Promise<
    | { available: false }
    | { available: true; outcome: "cancelled" | "not_active" }
  >;
};

function createStorageVnextAdminMaintenanceBackend(input: {
  catalog: StorageVnextCatalogReadPort | null;
  requests: ReturnType<typeof createStorageVnextMaintenanceRequestService> | null;
  status: Pick<StorageVnextMaintenanceRepository, "getStatus" | "cancel"> | null;
  runtimeSettings: RuntimeSettingsService | null;
  semanticAdoption: {
    resolve(input: {
      knowledgeBaseId: string;
      settingsRevisionPublicId: string;
    }): Promise<
      | { available: true; snapshot: StorageVnextSemanticAdoptionSnapshot | null }
      | { available: false; safeCode: string }
    >;
  } | null;
  semanticCancellation: {
    cancel(input: {
      knowledgeBaseId: string;
      operationPublicId: string;
      requestedAt: string;
    }): Promise<unknown>;
  } | null;
  cancellationCleanup: {
    terminate(input: {
      knowledgeBaseId: string;
      operationPublicId: string;
      cancelledAt: string;
    }): Promise<unknown>;
  } | null;
  onWorkAccepted: (() => Promise<void>) | null;
}): StorageVnextAdminMaintenanceApplication {
  return {
    async getMaintenanceStatus(request) {
      if (!input.status) return { available: false as const };
      return {
        available: true as const,
        status: await input.status.getStatus(request)
      };
    },
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
      const semanticAdoption = input.semanticAdoption
        ? await input.semanticAdoption.resolve({
            knowledgeBaseId: request.knowledgeBaseId,
            settingsRevisionPublicId: settingsRevision.publicId
          })
        : { available: true as const, snapshot: null };
      if (!semanticAdoption.available) {
        return {
          available: true as const,
          result: {
            outcome: "configuration_required" as const,
            safeCode: semanticAdoption.safeCode
          }
        };
      }
      const accepted = await input.requests.requestMaintenance({
        knowledgeBaseId: request.knowledgeBaseId,
        operationPublicId: `maintenance-${randomUUID()}`,
        trigger: "manual",
        idempotencyKey: request.idempotencyKey,
        expectedResourceRevision: knowledgeBase.revision,
        settingsRevisionPublicId: settingsRevision.publicId,
        requestedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + MAINTENANCE_RESULT_RETENTION_MS).toISOString(),
        maxAttempts: settings.maintenance.maxAttempts,
        semanticAdoption: semanticAdoption.snapshot
      });
      const status = await input.status.getStatus({
        knowledgeBaseId: request.knowledgeBaseId
      });
      if (accepted.outcome === "queued") await input.onWorkAccepted?.();
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
    },

    async cancelMaintenance(request) {
      if (!input.status) return { available: false as const };
      const current = await input.status.getStatus({
        knowledgeBaseId: request.knowledgeBaseId
      });
      if (!current.requestId) {
        return { available: true as const, outcome: "not_active" as const };
      }
      const requestedAt = new Date().toISOString();
      if (!current.active) {
        if (
          current.safeErrorCode === "MAINTENANCE_CANCELLED"
          && input.cancellationCleanup
        ) {
          await input.cancellationCleanup.terminate({
            knowledgeBaseId: request.knowledgeBaseId,
            operationPublicId: current.requestId,
            cancelledAt: requestedAt
          });
        }
        return { available: true as const, outcome: "not_active" as const };
      }
      const outcome = await input.status.cancel({
        knowledgeBaseId: request.knowledgeBaseId,
        operationPublicId: current.requestId,
        canceledAt: requestedAt
      });
      if (outcome === "cancelled" && input.semanticCancellation) {
        try {
          await input.semanticCancellation.cancel({
            knowledgeBaseId: request.knowledgeBaseId,
            operationPublicId: current.requestId,
            requestedAt
          });
        } catch (error) {
          if (!isMissingSemanticCandidate(error)) throw error;
        }
      }
      if (outcome === "cancelled" && input.cancellationCleanup) {
        await input.cancellationCleanup.terminate({
          knowledgeBaseId: request.knowledgeBaseId,
          operationPublicId: current.requestId,
          cancelledAt: requestedAt
        });
      }
      return { available: true as const, outcome };
    }
  };
}

export function createStorageVnextAdminMaintenanceApplication(input: {
  backend?: StorageVnextAdminMaintenanceApplication | null;
  catalog: StorageVnextCatalogReadPort | null;
  requests: ReturnType<typeof createStorageVnextMaintenanceRequestService> | null;
  status: Pick<StorageVnextMaintenanceRepository, "getStatus" | "cancel"> | null;
  runtimeSettings: RuntimeSettingsService | null;
  semanticAdoption?: Parameters<typeof createStorageVnextAdminMaintenanceBackend>[0]["semanticAdoption"];
  semanticCancellation?: Parameters<typeof createStorageVnextAdminMaintenanceBackend>[0]["semanticCancellation"];
  cancellationCleanup?: Parameters<typeof createStorageVnextAdminMaintenanceBackend>[0]["cancellationCleanup"];
  onWorkAccepted?: () => Promise<void>;
}): StorageVnextAdminMaintenanceApplication {
  return input.backend ?? createStorageVnextAdminMaintenanceBackend({
    ...input,
    semanticAdoption: input.semanticAdoption ?? null,
    semanticCancellation: input.semanticCancellation ?? null,
    cancellationCleanup: input.cancellationCleanup ?? null,
    onWorkAccepted: input.onWorkAccepted ?? null
  });
}

function isMissingSemanticCandidate(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && error.code === "semantic_adoption_candidate_missing";
}
