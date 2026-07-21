import type { RuntimeLogger } from "../logger.js";

export async function runMaintenanceBackground(input: {
  runSweep: () => Promise<{
    repairPhase: string;
    recovered: number;
    reconciliationPhase: string;
    reconciliationScanned: number;
    reconciliationDeleted: number;
    reconciliationVerified: number;
    reconciliationFailed: number;
    migrationPhase: string;
    migrationProcessed: number;
    migrationCompleted: boolean;
    migrationFailed: boolean;
    statisticsClaimed: boolean;
    statisticsChanged: boolean;
    statisticsFailed: boolean;
    pressureReconciled: boolean;
    compactionDiscovered: number;
    compactionClaimed: number;
    compactionCompleted: number;
    compactionSuperseded: number;
    compactionFailed: number;
    garbageCollectionExpired: number;
    garbageCollectionDeleted: number;
    garbageCollectionPending: boolean;
  }>;
  pollIntervalMs: () => Promise<number>;
  logger: RuntimeLogger;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}, signal: AbortSignal): Promise<void> {
  const sleep = input.sleep ?? abortableSleep;
  while (!signal.aborted) {
    try {
      const result = await input.runSweep();
      input.logger.debug("Maintenance sweep completed", result);
    } catch {
      input.logger.warn("Maintenance sweep failed", { code: "MAINTENANCE_SWEEP_FAILED" });
    }
    if (signal.aborted) break;
    await sleep(Math.max(1_000, await input.pollIntervalMs()), signal);
  }
}

async function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    const onAbort = () => done();
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
