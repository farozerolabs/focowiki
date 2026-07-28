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
        reconciliationFailed: 1,
        objectProtectionPhase: "backfilling",
        objectProtectionProcessed: 500,
        objectProtectionCompleted: false,
        objectProtectionFailed: false,
        migrationPhase: "source_terms",
        migrationProcessed: 100,
        migrationCompleted: false,
        migrationFailed: false,
        lexicalRebuildPhase: "documents",
        lexicalRebuildProcessed: 50,
        lexicalRebuildCompleted: false,
        lexicalRebuildFailed: false,
        statisticsClaimed: true,
        statisticsChanged: true,
        statisticsFailed: false,
        pressureReconciled: true,
        compactionDiscovered: 3,
        compactionClaimed: 2,
        compactionCompleted: 1,
        compactionSuperseded: 1,
        compactionFailed: 0,
        garbageCollectionExpired: 3,
        garbageCollectionDeleted: 4,
        garbageCollectionPending: true,
        uploadSessionsExpired: 2,
        uploadSessionObjectsDeleted: 5
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
      reconciliationFailed: 1,
      objectProtectionPhase: "backfilling",
      objectProtectionProcessed: 500,
      objectProtectionCompleted: false,
      objectProtectionFailed: false,
      migrationPhase: "source_terms",
      migrationProcessed: 100,
      migrationCompleted: false,
      migrationFailed: false,
      lexicalRebuildPhase: "documents",
      lexicalRebuildProcessed: 50,
      lexicalRebuildCompleted: false,
      lexicalRebuildFailed: false,
      statisticsClaimed: true,
      statisticsChanged: true,
      statisticsFailed: false,
      pressureReconciled: true,
      compactionDiscovered: 3,
      compactionClaimed: 2,
      compactionCompleted: 1,
      compactionSuperseded: 1,
      compactionFailed: 0,
      garbageCollectionExpired: 3,
      garbageCollectionDeleted: 4,
      garbageCollectionPending: true,
      uploadSessionsExpired: 2,
      uploadSessionObjectsDeleted: 5
    });
    expect(JSON.stringify(debug.mock.calls)).not.toContain("objectKey");
    expect(JSON.stringify(debug.mock.calls)).not.toContain("checksum");
  });
});
