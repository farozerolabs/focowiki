import type { RuntimeSettingsResponse } from "@/lib/admin-api";

export type MaintenanceHealthState =
  | "notRun"
  | "active"
  | "slow"
  | "retrying"
  | "blocked"
  | "failed"
  | "completed";

export type MaintenanceHealthInput = {
  reconciliation: RuntimeSettingsResponse["maintenanceStatus"];
  protection: RuntimeSettingsResponse["objectProtectionStatus"];
  now?: number;
};

export type MaintenanceProgress = {
  completed: number;
  expected: number;
};

const SLOW_PROGRESS_THRESHOLD_MS = 5 * 60 * 1_000;

export function deriveMaintenanceHealth(
  input: MaintenanceHealthInput
): MaintenanceHealthState {
  const { reconciliation, protection } = input;
  const now = input.now ?? Date.now();

  if (protection?.readiness === "failed") {
    return "failed";
  }
  if (reconciliation?.state === "failed") {
    return "failed";
  }
  if (
    protection?.readiness === "retrying"
    || hasRetryingError(reconciliation)
    || hasRetryingError(protection)
  ) {
    return "retrying";
  }

  const reconciliationActive = reconciliation?.state === "scanning"
    || reconciliation?.state === "verifying";
  const protectionActive = protection?.readiness === "backfilling"
    || protection?.readiness === "verifying"
    || (protection?.phase === "dirty_refresh" && protection.dirtyCount > 0);
  const active = reconciliationActive || protectionActive;
  if (active) {
    const latestActivity = latestTimestamp([
      ...(reconciliationActive
        ? [reconciliation?.lastProgressAt, reconciliation?.heartbeatAt]
        : []),
      ...(protectionActive
        ? [protection?.lastProgressAt, protection?.heartbeatAt]
        : [])
    ]);
    if (latestActivity === null) {
      return "blocked";
    }
    return now - latestActivity > SLOW_PROGRESS_THRESHOLD_MS ? "slow" : "active";
  }

  if (
    protection
    && protection.readiness !== "ready"
  ) {
    return "blocked";
  }
  if (reconciliation?.lastScanCompletedAt && protection?.readiness === "ready") {
    return "completed";
  }
  return "notRun";
}

export function deriveObjectProtectionProgress(
  status: RuntimeSettingsResponse["objectProtectionStatus"]
): MaintenanceProgress {
  if (!status) return { completed: 0, expected: 0 };
  const verifying = status.phase.startsWith("verify_");
  const completed = status.readiness === "ready"
    ? status.expectedCount
    : verifying ? status.verifiedCount : status.processedCount;
  return {
    completed,
    expected: Math.max(status.expectedCount, completed)
  };
}

function hasRetryingError(input: {
  retryCount: number;
  lastErrorCode: string | null;
} | null): boolean {
  return Boolean(input && input.retryCount > 0 && input.lastErrorCode);
}

function latestTimestamp(values: Array<string | null | undefined>): number | null {
  let latest: number | null = null;
  for (const value of values) {
    if (!value) continue;
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) continue;
    latest = latest === null ? timestamp : Math.max(latest, timestamp);
  }
  return latest;
}
