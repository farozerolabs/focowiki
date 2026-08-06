import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  createStorageVnextRuntimeFlowObserver,
  type StorageVnextRuntimeFlowName
} from "../src/storage-vnext/runtime/flow-observer.js";
import { createStorageVnextRuntimeResourceController } from
  "../src/storage-vnext/runtime/resource-controller.js";

const maximumPerFlowIdleRssGrowthBytes = 8 * 1_024 * 1_024;
const maximumSuiteIdleRssGrowthBytes = 16 * 1_024 * 1_024;

describe("storage vNext bounded high-volume runtime measurements", () => {
  it("records peak and idle metrics after every runtime flow", async () => {
    let activeController: ReturnType<
      typeof createStorageVnextRuntimeResourceController
    > | null = null;
    const observer = createStorageVnextRuntimeFlowObserver({
      sampleIntervalMs: 1,
      maximumSamples: 10_000,
      async sampleDatabaseConnections() {
        return Number(activeController?.snapshot().databaseConnectionsInUse ?? 0);
      }
    });
    const flows: StorageVnextRuntimeFlowName[] = [
      "api",
      "source",
      "publication",
      "search_rebuild",
      "projection_repair",
      "maintenance",
      "cleanup"
    ];

    for (const flow of flows) {
      const controller = createController();
      activeController = controller;
      const workClass = flow === "api"
        ? "foreground"
        : flow === "maintenance"
          ? "maintenance"
          : flow === "cleanup"
            ? "cleanup"
            : "background";
      const concurrency = workClass === "maintenance" || workClass === "cleanup"
        ? 2 : 4;
      const boundedBuffers = Array.from(
        { length: concurrency },
        (_, ordinal) => Buffer.alloc(32_768, ordinal)
      );
      const report = await observer.measureFlow({
        flow,
        async run(metrics) {
          for (let wave = 0; wave < 64; wave += 1) {
            const results = await Promise.all(Array.from(
              { length: concurrency },
              async (_, ordinal) => {
                const queuedAt = performance.now();
                return controller.runSlice({
                  workClass,
                  batch: {
                    itemCount: 16,
                    uncompressedBytes: 32_768,
                    compressedBytes: 8_192,
                    databaseConnections: 1,
                    searchTasks: 1,
                    objectRequests: 1,
                    memoryBytes: 32_768
                  },
                  timeoutMs: 1_000,
                  async claim() {
                    metrics.recordQueueLatency(performance.now() - queuedAt);
                    return { publicId: `${flow}-${wave}-${ordinal}` };
                  },
                  async run() {
                    const providerStartedAt = performance.now();
                    await delay(2);
                    metrics.recordProviderLatency(
                      performance.now() - providerStartedAt
                    );
                    return boundedBuffers[ordinal]?.[0] ?? 0;
                  }
                });
              }
            ));
            expect(results.every((result) => result.outcome === "completed")).toBe(true);
          }
          metrics.startCleanup();
          controller.beginShutdown();
          await controller.drain();
          metrics.completeCleanup();
        },
        async settle() { await delay(8); }
      });
      expect(report).toMatchObject({
        flow,
        outcome: "completed",
        idleDatabaseConnections: 0
      });
      expect(report.peakDatabaseConnections).toBeGreaterThan(0);
      expect(report.idleActiveResources).toBeLessThanOrEqual(
        report.peakActiveResources
      );
      expect(report.idleActiveResourceDelta).toBeLessThanOrEqual(0);
      expect(report.idleRssDeltaBytes).toBeLessThanOrEqual(
        maximumPerFlowIdleRssGrowthBytes
      );
    }

    const reports = observer.reports();
    expect(reports).toHaveLength(flows.length);
    const firstReport = reports[0];
    const lastReport = reports.at(-1);
    expect(firstReport).toBeDefined();
    expect(lastReport).toBeDefined();
    expect(
      Number(lastReport?.idleRssBytes) - Number(firstReport?.baselineRssBytes)
    ).toBeLessThanOrEqual(maximumSuiteIdleRssGrowthBytes);
    console.info(
      "STORAGE_VNEXT_RUNTIME_FLOW_EVIDENCE " + JSON.stringify(reports)
    );
  }, 30_000);
});

function createController() {
  return createStorageVnextRuntimeResourceController({
    database: {
      connectionLimit: 64,
      reservedConnections: 4,
      pools: {
        api: 10,
        source: 6,
        publication: 4,
        projectionRepair: 8,
        searchRebuild: 8,
        maintenance: 2
      }
    },
    workerConcurrency: {
      foreground: 4,
      background: 4,
      maintenance: 2,
      cleanup: 2
    },
    batchLimits: {
      maximumItems: 100,
      maximumUncompressedBytes: 65_536,
      maximumCompressedBytes: 16_384
    },
    resources: {
      databaseConnections: 12,
      reservedForegroundDatabaseConnections: 4,
      searchTasks: 8,
      reservedForegroundSearchTasks: 2,
      objectRequests: 8,
      reservedForegroundObjectRequests: 2,
      memoryBytes: 8 * 1_024 * 1_024,
      reservedForegroundMemoryBytes: 1 * 1_024 * 1_024
    }
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
