import type {
  StorageReconciliationStatus
} from "../application/ports/storage-reconciliation-repository.js";
import type {
  ObjectProtectionMaintenanceStatus
} from "../application/ports/object-protection-repository.js";
import type { RuntimeLogger } from "../logger.js";
import type {
  ObjectProtectionMaintenanceResult
} from "./object-protection-maintenance.js";
import type {
  StorageReconciliationSliceResult
} from "./storage-reconciliation.js";

type SafeReconciliationStatus = Pick<
  StorageReconciliationStatus,
  | "retryCount"
  | "recentObjectsPerSecond"
  | "rollingBatchLatencyMs"
  | "heartbeatAt"
  | "lastProgressAt"
  | "lastErrorCode"
>;

type SafeProtectionStatus = Pick<
  ObjectProtectionMaintenanceStatus,
  | "readiness"
  | "retryCount"
  | "recentObjectsPerSecond"
  | "rollingBatchLatencyMs"
  | "heartbeatAt"
  | "lastProgressAt"
  | "lastErrorCode"
>;

export function createMaintenanceReconciliationTelemetry(logger: RuntimeLogger) {
  let reconciliationPhase: string | null = null;
  let protectionPhase: string | null = null;
  let reconciliationRetrySignature: string | null = null;
  let protectionRetrySignature: string | null = null;
  let reconciliationFailureSignature: string | null = null;
  let protectionFailureSignature: string | null = null;

  return {
    record(input: {
      reconciliation: {
        result: StorageReconciliationSliceResult;
        status: SafeReconciliationStatus | null;
      };
      protection: {
        result: ObjectProtectionMaintenanceResult;
        status: SafeProtectionStatus | null;
      };
    }): void {
      if (input.reconciliation.result.phase !== reconciliationPhase) {
        reconciliationPhase = input.reconciliation.result.phase;
        logger.info("Storage reconciliation phase changed", {
          phase: reconciliationPhase
        });
      }
      if (input.protection.result.phase !== protectionPhase) {
        protectionPhase = input.protection.result.phase;
        logger.info("Object protection phase changed", {
          phase: protectionPhase,
          readiness: input.protection.status?.readiness ?? "pending"
        });
      }

      const reconciliationFailed =
        input.reconciliation.result.phase === "failed";
      const protectionFailed =
        input.protection.status?.readiness === "failed";
      if (reconciliationFailed) {
        logReconciliationFailure(input.reconciliation.status);
      } else {
        reconciliationFailureSignature = null;
        logReconciliationRetry(input.reconciliation.status);
      }
      if (protectionFailed) {
        logProtectionFailure(input.protection.status);
      } else {
        protectionFailureSignature = null;
        logProtectionRetry(input.protection.status);
      }

      if (input.reconciliation.result.claimed) {
        logger.debug("Storage reconciliation progress", {
          phase: input.reconciliation.result.phase,
          scanned: input.reconciliation.result.scanned,
          verified: input.reconciliation.result.verified,
          deleted: input.reconciliation.result.deleted,
          failed: input.reconciliation.result.failed,
          recentObjectsPerSecond:
            input.reconciliation.status?.recentObjectsPerSecond ?? null,
          rollingBatchLatencyMs:
            input.reconciliation.status?.rollingBatchLatencyMs ?? null,
          heartbeatAt: input.reconciliation.status?.heartbeatAt ?? null,
          lastProgressAt: input.reconciliation.status?.lastProgressAt ?? null
        });
      }
      if (input.protection.result.claimed) {
        logger.debug("Object protection progress", {
          phase: input.protection.result.phase,
          readiness: input.protection.status?.readiness ?? "pending",
          processed: input.protection.result.processed,
          completed: input.protection.result.completed,
          recentObjectsPerSecond:
            input.protection.status?.recentObjectsPerSecond ?? null,
          rollingBatchLatencyMs:
            input.protection.status?.rollingBatchLatencyMs ?? null,
          heartbeatAt: input.protection.status?.heartbeatAt ?? null,
          lastProgressAt: input.protection.status?.lastProgressAt ?? null
        });
      }
    }
  };

  function logReconciliationRetry(status: SafeReconciliationStatus | null): void {
    const signature = retrySignature(status);
    if (signature === reconciliationRetrySignature) return;
    reconciliationRetrySignature = signature;
    if (!signature || !status) return;
    logger.warn("Storage reconciliation will retry", {
      code: status.lastErrorCode,
      retryCount: status.retryCount
    });
  }

  function logProtectionRetry(status: SafeProtectionStatus | null): void {
    const signature = retrySignature(status);
    if (signature === protectionRetrySignature) return;
    protectionRetrySignature = signature;
    if (!signature || !status) return;
    logger.warn("Object protection maintenance will retry", {
      code: status.lastErrorCode,
      retryCount: status.retryCount,
      readiness: status.readiness
    });
  }

  function logReconciliationFailure(
    status: SafeReconciliationStatus | null
  ): void {
    const signature = failureSignature(status);
    if (signature === reconciliationFailureSignature) return;
    reconciliationFailureSignature = signature;
    logger.error("Storage reconciliation failed", {
      code: status?.lastErrorCode ?? "STORAGE_RECONCILIATION_FAILED",
      retryCount: status?.retryCount ?? 0
    });
  }

  function logProtectionFailure(status: SafeProtectionStatus | null): void {
    const signature = failureSignature(status);
    if (signature === protectionFailureSignature) return;
    protectionFailureSignature = signature;
    logger.error("Object protection maintenance failed", {
      code: status?.lastErrorCode ?? "OBJECT_PROTECTION_MAINTENANCE_FAILED",
      retryCount: status?.retryCount ?? 0
    });
  }
}

function retrySignature(status: {
  retryCount: number;
  lastErrorCode: string | null;
} | null): string | null {
  return status?.lastErrorCode && status.retryCount > 0
    ? `${status.retryCount}:${status.lastErrorCode}`
    : null;
}

function failureSignature(status: {
  retryCount: number;
  lastErrorCode: string | null;
} | null): string {
  return `${status?.retryCount ?? 0}:${
    status?.lastErrorCode ?? "UNKNOWN"
  }`;
}
