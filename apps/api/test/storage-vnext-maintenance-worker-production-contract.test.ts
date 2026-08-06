import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  shouldWaitForStorageVnextMaintenancePoll,
  storageVnextStagingRetentionCutoff
} from "../src/storage-vnext/maintenance/production-runtime.js";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const runtimePath = "apps/api/src/storage-vnext/maintenance/production-runtime.ts";

describe("storage vNext maintenance worker production contract", () => {
  it("boots one maintenance role without obsolete lexical or projection workers", () => {
    const main = read("apps/api/src/maintenance-worker-main.ts");
    expect(main).toContain(
      '"./storage-vnext/maintenance/production-runtime.js"'
    );
    expect(main).toContain("runStorageVnextMaintenanceWorker");
    expect(existsSync(resolve(
      workspaceRoot,
      "apps/api/src/lexical-rebuild-worker-main.ts"
    ))).toBe(false);
    expect(existsSync(resolve(
      workspaceRoot,
      "apps/api/src/projection-repair-worker-main.ts"
    ))).toBe(false);
  });

  it("wires durable maintenance phases, current facts, unified search, S3, and cleanup", () => {
    expect(existsSync(resolve(workspaceRoot, runtimePath)), runtimePath).toBe(true);
    if (!existsSync(resolve(workspaceRoot, runtimePath))) return;
    const runtime = read(runtimePath);
    for (const dependency of [
      "createPostgresStorageVnextMaintenanceRepository",
      "createStorageVnextMaintenanceCoordinator",
      "createStorageVnextMaintenanceProductionPlanner",
      "createStorageVnextMaintenanceProductionPhases",
      "createStorageVnextProductionPublicationPipeline",
      "createStorageVnextMaintenanceObjectReconciliation",
      "createStorageVnextMaintenanceCandidateObjectCleanup",
      "createStorageVnextCandidateObjectCleanupWorker",
      "createPostgresStorageVnextCandidateObjectCleanupActionRepository",
      "createPostgresStorageVnextCleanupActionRepository",
      "createStorageVnextZeroOwnerCleanup",
      "createS3StorageVnextObjectInventory",
      "createStorageVnextMaintenanceProductionCleanup",
      "createStorageVnextSearchCleanup",
      "createStorageVnextMaintenanceResourceGate",
      "createStorageVnextAutomaticMaintenanceScheduler",
      "createStorageVnextDeletionWorker",
      "createStorageVnextDeletionProductionRelease",
      "createStorageVnextUnifiedSearchDeletion",
      "runStorageVnextRetentionSlice"
    ]) expect(runtime, dependency).toContain(dependency);
    expect(runtime).toContain("zeroOwnerCleanup.runBatch");
    expect(runtime).toContain("candidateObjectCleanupWorker.runBatch");
    expect(runtime).toContain("searchCleanup.cleanupFailedCandidate");
    expect(runtime).toContain("searchCleanup.cleanupOrphanIndexes");
    expect(runtime).not.toMatch(
      /LexicalRebuild|ProjectionRepairWork|PublicationGeneration|OptimizationMigration/u
    );
  });

  it("continues durable page progress without an idle poll delay", () => {
    expect(shouldWaitForStorageVnextMaintenancePoll([
      { outcome: "progress" }
    ])).toBe(false);
    expect(shouldWaitForStorageVnextMaintenancePoll([
      { outcome: "phase_completed" }
    ])).toBe(false);
    expect(shouldWaitForStorageVnextMaintenancePoll([
      { outcome: "idle" },
      { outcome: "progress" }
    ])).toBe(false);
    expect(shouldWaitForStorageVnextMaintenancePoll([
      { outcome: "idle" }
    ])).toBe(true);
    expect(shouldWaitForStorageVnextMaintenancePoll([
      { outcome: "retry" }
    ])).toBe(true);
    expect(shouldWaitForStorageVnextMaintenancePoll(
      [{ outcome: "idle" }],
      { outcome: "progress" }
    )).toBe(false);
    expect(shouldWaitForStorageVnextMaintenancePoll(
      [{ outcome: "idle" }],
      { outcome: "idle" },
      { outcome: "progress" }
    )).toBe(false);
  });

  it("applies the live staging-retention setting to search cleanup cutoffs", () => {
    expect(storageVnextStagingRetentionCutoff(
      "2026-08-06T12:00:00.000Z",
      24
    )).toBe("2026-08-05T12:00:00.000Z");
    expect(read(runtimePath)).toContain("snapshot.search.stagingRetentionHours");
  });
});

function read(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
}
