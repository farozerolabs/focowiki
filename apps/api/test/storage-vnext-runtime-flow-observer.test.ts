import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

type FlowName =
  | "api"
  | "source"
  | "publication"
  | "search_rebuild"
  | "projection_repair"
  | "maintenance"
  | "cleanup";

type FlowObserverFactory = (input: Record<string, unknown>) => {
  measureFlow(input: {
    flow: FlowName;
    run(metrics: {
      recordQueueLatency(milliseconds: number): void;
      recordProviderLatency(milliseconds: number): void;
      startCleanup(): void;
      completeCleanup(): void;
    }): Promise<void>;
    settle(): Promise<void>;
  }): Promise<Record<string, unknown>>;
  reports(): Array<Record<string, unknown>>;
};

let createObserver: FlowObserverFactory | undefined;

beforeAll(async () => {
  const modulePath = resolve(
    import.meta.dirname,
    "../src/storage-vnext/runtime/flow-observer.ts"
  );
  const loaded = await import(
    /* @vite-ignore */ pathToFileURL(modulePath).href
  ).catch(() => ({})) as Record<string, unknown>;
  createObserver = loaded.createStorageVnextRuntimeFlowObserver as
    FlowObserverFactory | undefined;
});

describe("storage vNext runtime flow observer", () => {
  it("measures peak and idle resources for every high-volume flow", async () => {
    expect(createObserver).toBeTypeOf("function");
    if (!createObserver) return;
    let connections = 1;
    const observer = createObserver({
      sampleIntervalMs: 2,
      maximumSamples: 1_000,
      sampleDatabaseConnections: async () => connections
    });
    const flows: FlowName[] = [
      "api",
      "source",
      "publication",
      "search_rebuild",
      "projection_repair",
      "maintenance",
      "cleanup"
    ];

    for (const flow of flows) {
      const report = await observer.measureFlow({
        flow,
        async run(metrics) {
          connections = 4;
          metrics.recordQueueLatency(3);
          metrics.recordProviderLatency(5);
          metrics.startCleanup();
          await delay(12);
          metrics.completeCleanup();
          connections = 1;
        },
        async settle() { await delay(8); }
      });
      expect(report).toMatchObject({
        flow,
        baselineRssBytes: expect.any(Number),
        peakRssBytes: expect.any(Number),
        idleRssBytes: expect.any(Number),
        idleRssDeltaBytes: expect.any(Number),
        cpuMicros: expect.any(Number),
        idleCpuMicros: expect.any(Number),
        eventLoopDelayP95Ms: expect.any(Number),
        peakActiveResources: expect.any(Number),
        baselineActiveResources: expect.any(Number),
        idleActiveResources: expect.any(Number),
        idleActiveResourceDelta: expect.any(Number),
        peakDatabaseConnections: 4,
        idleDatabaseConnections: 1,
        maximumQueueLatencyMs: 3,
        maximumProviderLatencyMs: 5,
        cleanupLagMs: expect.any(Number)
      });
      expect(Number(report.cleanupLagMs)).toBeGreaterThanOrEqual(0);
      expect(Number(report.sampleCount)).toBeGreaterThan(0);
      expect(Number(report.idleActiveResources)).toBeLessThanOrEqual(
        Number(report.peakActiveResources)
      );
      expect(Number(report.idleActiveResourceDelta)).toBeLessThanOrEqual(0);
    }
    expect(observer.reports().map((report) => report.flow)).toEqual(flows);
  });

  it("rejects duplicate flows and unsafe latency samples", async () => {
    expect(createObserver).toBeTypeOf("function");
    if (!createObserver) return;
    const observer = createObserver({
      sampleIntervalMs: 2,
      maximumSamples: 100,
      sampleDatabaseConnections: async () => 0
    });
    await observer.measureFlow({
      flow: "api",
      async run(metrics) {
        expect(() => metrics.recordQueueLatency(-1)).toThrowError(
          expect.objectContaining({ code: "invalid_metric" })
        );
      },
      async settle() {}
    });
    await expect(observer.measureFlow({
      flow: "api",
      async run() {},
      async settle() {}
    })).rejects.toMatchObject({ code: "duplicate_flow" });
  });
});

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
