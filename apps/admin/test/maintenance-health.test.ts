import { describe, expect, it } from "vitest";
import {
  deriveMaintenanceHealth,
  deriveObjectProtectionProgress
} from "../src/lib/maintenance-health";
import type { MaintenanceHealthInput } from "../src/lib/maintenance-health";

const now = Date.parse("2026-07-27T10:05:00.000Z");

describe("deriveMaintenanceHealth", () => {
  it("distinguishes active, slow, retrying, blocked, failed, and completed states", () => {
    expect(deriveMaintenanceHealth({
      reconciliation: reconciliation({ state: "scanning" }),
      protection: protection({ readiness: "ready" }),
      now
    })).toBe("active");

    expect(deriveMaintenanceHealth({
      reconciliation: reconciliation({
        state: "scanning",
        lastProgressAt: "2026-07-27T09:55:00.000Z",
        heartbeatAt: "2026-07-27T09:55:00.000Z"
      }),
      protection: protection({ readiness: "ready" }),
      now
    })).toBe("slow");

    expect(deriveMaintenanceHealth({
      reconciliation: reconciliation({
        state: "idle",
        retryCount: 1,
        lastErrorCode: "STORAGE_RECONCILIATION_RETRY"
      }),
      protection: protection({ readiness: "ready" }),
      now
    })).toBe("retrying");

    expect(deriveMaintenanceHealth({
      reconciliation: reconciliation({ state: "idle" }),
      protection: protection({
        readiness: "pending",
        heartbeatAt: null,
        lastProgressAt: null
      }),
      now
    })).toBe("blocked");

    expect(deriveMaintenanceHealth({
      reconciliation: reconciliation({
        state: "failed",
        retryCount: 1,
        lastErrorCode: "STORAGE_RECONCILIATION_FAILED"
      }),
      protection: protection({ readiness: "ready" }),
      now
    })).toBe("failed");

    expect(deriveMaintenanceHealth({
      reconciliation: reconciliation({ state: "idle" }),
      protection: protection({
        readiness: "failed",
        retryCount: 3,
        lastErrorCode: "OBJECT_PROTECTION_MAINTENANCE_FAILED"
      }),
      now
    })).toBe("failed");

    expect(deriveMaintenanceHealth({
      reconciliation: reconciliation({
        state: "idle",
        lastScanCompletedAt: "2026-07-27T09:00:00.000Z"
      }),
      protection: protection({ readiness: "ready" }),
      now
    })).toBe("completed");
  });

  it("uses verification progress and converges completed readiness", () => {
    expect(deriveObjectProtectionProgress(protection({
      readiness: "verifying",
      phase: "verify_source_files",
      processedCount: 1_000,
      verifiedCount: 400,
      expectedCount: 1_000
    }))).toEqual({
      completed: 400,
      expected: 1_000
    });
    expect(deriveObjectProtectionProgress(protection({
      readiness: "ready",
      phase: "ready",
      processedCount: 900,
      verifiedCount: 1_000,
      expectedCount: 1_000
    }))).toEqual({
      completed: 1_000,
      expected: 1_000
    });
  });
});

function reconciliation(
  overrides: Partial<NonNullable<MaintenanceHealthInput["reconciliation"]>>
): NonNullable<MaintenanceHealthInput["reconciliation"]> {
  return {
    state: "idle" as const,
    lastScanStartedAt: null,
    lastScanCompletedAt: null,
    listedCount: 0,
    quarantinedCount: 0,
    deletedCount: 0,
    missingCount: 0,
    retryCount: 0,
    lastErrorCode: null,
    lastErrorMessage: null,
    resolvedCount: 0,
    pendingCount: 0,
    databaseChunkSize: null,
    recentObjectsPerSecond: null,
    rollingBatchLatencyMs: null,
    heartbeatAt: "2026-07-27T10:04:30.000Z",
    lastProgressAt: "2026-07-27T10:04:30.000Z",
    ...overrides
  };
}

function protection(
  overrides: Partial<NonNullable<MaintenanceHealthInput["protection"]>>
): NonNullable<MaintenanceHealthInput["protection"]> {
  return {
    readiness: "ready" as const,
    retryCount: 0,
    lastErrorCode: null,
    heartbeatAt: "2026-07-27T10:04:30.000Z",
    lastProgressAt: "2026-07-27T10:04:30.000Z",
    dirtyCount: 0,
    phase: "ready" as const,
    processedCount: 0,
    expectedCount: 0,
    verifiedCount: 0,
    recentObjectsPerSecond: null,
    rollingBatchLatencyMs: null,
    estimatedCompletionAt: null,
    lastErrorMessage: null,
    ...overrides
  };
}
