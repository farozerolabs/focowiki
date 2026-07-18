import { describe, expect, it, vi } from "vitest";
import { runMaintenanceBackground } from "../src/maintenance/runtime.js";

describe("maintenance runtime", () => {
  it("logs bounded aggregate results without object identities", async () => {
    const abort = new AbortController();
    const debug = vi.fn();
    const runSweep = vi.fn(async () => {
      abort.abort();
      return {
        repairPhase: "tree",
        recovered: 2,
        reconciliationPhase: "deleting",
        reconciliationScanned: 500,
        reconciliationDeleted: 4,
        reconciliationVerified: 20,
        reconciliationFailed: 1
      };
    });

    await runMaintenanceBackground({
      runSweep,
      pollIntervalMs: vi.fn(async () => 1_000),
      logger: {
        debug,
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      }
    }, abort.signal);

    expect(debug).toHaveBeenCalledWith("Maintenance sweep completed", {
      repairPhase: "tree",
      recovered: 2,
      reconciliationPhase: "deleting",
      reconciliationScanned: 500,
      reconciliationDeleted: 4,
      reconciliationVerified: 20,
      reconciliationFailed: 1
    });
    expect(JSON.stringify(debug.mock.calls)).not.toContain("objectKey");
    expect(JSON.stringify(debug.mock.calls)).not.toContain("checksum");
  });
});
