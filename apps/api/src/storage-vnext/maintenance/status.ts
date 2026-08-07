import type {
  StorageVnextMaintenanceCheckpoint,
  StorageVnextMaintenanceStatus
} from "./ports.js";

export type StorageVnextMaintenanceLiveStatusInput = {
  operationPublicId: string;
  workState: "queued" | "running" | "retry";
  retryCount: number;
  safeErrorCode: string | null;
  checkpoint: StorageVnextMaintenanceCheckpoint;
};

export type StorageVnextMaintenanceTerminalStatusInput = {
  operationPublicId: string;
  terminalState: "completed" | "failed" | "superseded";
  resultCode: string;
  completedAt: string;
  summary: unknown;
};

export function createStorageVnextMaintenanceStatusMapper() {
  return {
    mapLive(input: StorageVnextMaintenanceLiveStatusInput): StorageVnextMaintenanceStatus {
      return {
        requestId: input.operationPublicId,
        state: liveState(input.workState, input.checkpoint),
        trigger: input.checkpoint.trigger,
        stage: input.checkpoint.phase,
        active: true,
        completedCount: input.checkpoint.completedCount,
        expectedCount: input.checkpoint.expectedCount,
        retryCount: input.retryCount,
        lastProgressAt: input.checkpoint.lastProgressAt,
        lastCompletedAt: null,
        maintenanceRequired: true,
        safeErrorCode: input.safeErrorCode,
        safeErrorMessage: null,
        throughputPerSecond: input.checkpoint.throughputPerSecond,
        estimatedCompletionAt: input.checkpoint.estimatedCompletionAt
      };
    },

    mapTerminal(
      input: StorageVnextMaintenanceTerminalStatusInput
    ): StorageVnextMaintenanceStatus {
      const summary = boundedSummary(input.summary);
      return {
        requestId: input.operationPublicId,
        state: input.terminalState,
        trigger: trigger(summary.trigger),
        stage: phase(summary.phase),
        active: false,
        completedCount: nonnegativeInteger(summary.completedCount),
        expectedCount: nonnegativeInteger(summary.expectedCount),
        retryCount: nonnegativeInteger(summary.retryCount),
        lastProgressAt: timestampOrNull(summary.lastProgressAt),
        lastCompletedAt: requiredTimestamp(input.completedAt),
        maintenanceRequired: input.terminalState !== "completed",
        safeErrorCode: input.terminalState === "completed" ? null : input.resultCode,
        safeErrorMessage: null,
        throughputPerSecond: nonnegativeNumber(summary.throughputPerSecond),
        estimatedCompletionAt: timestampOrNull(summary.estimatedCompletionAt)
      };
    },

    mapIdle(maintenanceRequired = false): StorageVnextMaintenanceStatus {
      return {
        requestId: null,
        state: "idle",
        trigger: null,
        stage: null,
        active: false,
        completedCount: 0,
        expectedCount: 0,
        retryCount: 0,
        lastProgressAt: null,
        lastCompletedAt: null,
        maintenanceRequired,
        safeErrorCode: null,
        safeErrorMessage: null,
        throughputPerSecond: 0,
        estimatedCompletionAt: null
      };
    }
  };
}

function liveState(
  workState: StorageVnextMaintenanceLiveStatusInput["workState"],
  checkpoint: StorageVnextMaintenanceCheckpoint
): StorageVnextMaintenanceStatus["state"] {
  if (checkpoint.phase === "planning") {
    if (
      workState === "queued"
      && checkpoint.cursor === null
      && checkpoint.batchOrdinal === 0
      && checkpoint.completedCount === 0
    ) return "queued";
    return "planning";
  }
  if (checkpoint.phase === "validation") return "validating";
  return "running";
}

function boundedSummary(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function trigger(value: unknown): StorageVnextMaintenanceStatus["trigger"] {
  return value === "manual" || value === "automatic" ? value : null;
}

function phase(value: unknown): StorageVnextMaintenanceStatus["stage"] {
  return [
    "planning", "search_rebuild", "projection_repair", "object_reconciliation",
    "catch_up", "validation", "activation", "cleanup"
  ].includes(String(value))
    ? value as StorageVnextMaintenanceStatus["stage"]
    : null;
}

function nonnegativeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function nonnegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function timestampOrNull(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function requiredTimestamp(value: string): string {
  const result = timestampOrNull(value);
  if (!result) throw statusError("invalid_timestamp");
  return result;
}

function statusError(code: string): Error {
  return Object.assign(new Error(`Storage vNext maintenance status error: ${code}`), {
    code
  });
}
