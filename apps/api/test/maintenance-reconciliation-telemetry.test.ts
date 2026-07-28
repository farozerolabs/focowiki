import { describe, expect, it, vi } from "vitest";
import {
  createMaintenanceReconciliationTelemetry
} from "../src/maintenance/reconciliation-telemetry.js";

describe("maintenance reconciliation telemetry", () => {
  it("logs safe phase transitions, bounded progress, retries, and failures", () => {
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn()
    };
    const telemetry = createMaintenanceReconciliationTelemetry(logger);

    telemetry.record({
      reconciliation: {
        result: {
          claimed: true,
          phase: "scanning",
          scanned: 100,
          deleted: 0,
          verified: 0,
          failed: 0
        },
        status: {
          retryCount: 1,
          recentObjectsPerSecond: 50,
          rollingBatchLatencyMs: 20,
          heartbeatAt: "2026-07-27T10:00:00.000Z",
          lastProgressAt: "2026-07-27T10:00:00.000Z",
          lastErrorCode: "STORAGE_RECONCILIATION_RETRYABLE_TIMEOUT"
        }
      },
      protection: {
        result: {
          claimed: true,
          phase: "source_files",
          processed: 500,
          completed: false,
          failed: false
        },
        status: {
          readiness: "backfilling",
          retryCount: 0,
          recentObjectsPerSecond: 80,
          rollingBatchLatencyMs: 25,
          heartbeatAt: "2026-07-27T10:00:00.000Z",
          lastProgressAt: "2026-07-27T10:00:00.000Z",
          lastErrorCode: null
        }
      }
    });

    expect(logger.info).toHaveBeenCalledWith(
      "Storage reconciliation phase changed",
      expect.objectContaining({ phase: "scanning" })
    );
    expect(logger.info).toHaveBeenCalledWith(
      "Object protection phase changed",
      expect.objectContaining({
        phase: "source_files",
        readiness: "backfilling"
      })
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "Storage reconciliation will retry",
      expect.objectContaining({
        code: "STORAGE_RECONCILIATION_RETRYABLE_TIMEOUT",
        retryCount: 1
      })
    );
    expect(logger.debug).toHaveBeenCalledWith(
      "Object protection progress",
      expect.objectContaining({
        processed: 500,
        recentObjectsPerSecond: 80,
        rollingBatchLatencyMs: 25
      })
    );

    telemetry.record({
      reconciliation: {
        result: {
          claimed: true,
          phase: "failed",
          scanned: 0,
          deleted: 0,
          verified: 0,
          failed: 1
        },
        status: {
          retryCount: 3,
          recentObjectsPerSecond: null,
          rollingBatchLatencyMs: null,
          heartbeatAt: "2026-07-27T10:01:00.000Z",
          lastProgressAt: "2026-07-27T10:01:00.000Z",
          lastErrorCode: "STORAGE_RECONCILIATION_FAILED"
        }
      },
      protection: {
        result: {
          claimed: false,
          phase: "ready",
          processed: 0,
          completed: false,
          failed: true
        },
        status: {
          readiness: "failed",
          retryCount: 4,
          recentObjectsPerSecond: null,
          rollingBatchLatencyMs: null,
          heartbeatAt: "2026-07-27T10:01:00.000Z",
          lastProgressAt: "2026-07-27T10:01:00.000Z",
          lastErrorCode: "OBJECT_PROTECTION_MAINTENANCE_FAILED"
        }
      }
    });

    expect(logger.error).toHaveBeenCalledWith(
      "Storage reconciliation failed",
      {
        code: "STORAGE_RECONCILIATION_FAILED",
        retryCount: 3
      }
    );
    expect(logger.error).toHaveBeenCalledWith(
      "Object protection maintenance failed",
      {
        code: "OBJECT_PROTECTION_MAINTENANCE_FAILED",
        retryCount: 4
      }
    );

    const serialized = JSON.stringify({
      error: logger.error.mock.calls,
      info: logger.info.mock.calls,
      warn: logger.warn.mock.calls,
      debug: logger.debug.mock.calls
    });
    for (const forbidden of [
      "objectKey",
      "checksum",
      "cursor",
      "lease",
      "workerId",
      "SELECT ",
      "secret"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
