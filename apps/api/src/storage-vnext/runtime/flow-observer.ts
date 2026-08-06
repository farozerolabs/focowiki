import { monitorEventLoopDelay, performance } from "node:perf_hooks";

export type StorageVnextRuntimeFlowName =
  | "api"
  | "source"
  | "publication"
  | "search_rebuild"
  | "projection_repair"
  | "maintenance"
  | "cleanup";

export type StorageVnextRuntimeFlowReport = {
  flow: StorageVnextRuntimeFlowName;
  outcome: "completed" | "failed";
  baselineRssBytes: number;
  peakRssBytes: number;
  idleRssBytes: number;
  idleRssDeltaBytes: number;
  cpuMicros: number;
  idleCpuMicros: number;
  eventLoopDelayP95Ms: number;
  baselineActiveResources: number;
  peakActiveResources: number;
  idleActiveResources: number;
  idleActiveResourceDelta: number;
  peakDatabaseConnections: number;
  idleDatabaseConnections: number;
  maximumQueueLatencyMs: number;
  maximumProviderLatencyMs: number;
  cleanupLagMs: number;
  sampleCount: number;
};

type MetricRecorder = {
  recordQueueLatency(milliseconds: number): void;
  recordProviderLatency(milliseconds: number): void;
  startCleanup(): void;
  completeCleanup(): void;
};

const FLOW_NAMES: readonly StorageVnextRuntimeFlowName[] = [
  "api",
  "source",
  "publication",
  "search_rebuild",
  "projection_repair",
  "maintenance",
  "cleanup"
];

export function createStorageVnextRuntimeFlowObserver(input: {
  sampleIntervalMs: number;
  maximumSamples: number;
  sampleDatabaseConnections(): Promise<number>;
}) {
  positive(input.sampleIntervalMs, "invalid_configuration");
  positive(input.maximumSamples, "invalid_configuration");
  const observed = new Set<StorageVnextRuntimeFlowName>();
  const completedReports: StorageVnextRuntimeFlowReport[] = [];

  return {
    async measureFlow(request: {
      flow: StorageVnextRuntimeFlowName;
      run(metrics: MetricRecorder): Promise<void>;
      settle(): Promise<void>;
    }): Promise<StorageVnextRuntimeFlowReport> {
      if (!FLOW_NAMES.includes(request.flow)) throw observerError("invalid_flow");
      if (observed.has(request.flow)) throw observerError("duplicate_flow");
      observed.add(request.flow);
      return measure(request);
    },

    reports(): StorageVnextRuntimeFlowReport[] {
      return completedReports.map((report) => ({ ...report }));
    }
  };

  async function measure(request: {
    flow: StorageVnextRuntimeFlowName;
    run(metrics: MetricRecorder): Promise<void>;
    settle(): Promise<void>;
  }): Promise<StorageVnextRuntimeFlowReport> {
    const baselineRssBytes = process.memoryUsage().rss;
    const baselineActiveResources = activeResourceCount();
    let peakRssBytes = baselineRssBytes;
    let peakActiveResources = baselineActiveResources;
    let peakDatabaseConnections = 0;
    let sampleCount = 0;
    let sampling: Promise<void> | null = null;
    let sampleError: unknown = null;
    let maximumQueueLatencyMs = 0;
    let maximumProviderLatencyMs = 0;
    let cleanupStartedAt: number | null = null;
    let cleanupLagMs = 0;
    let runError: unknown = null;
    let settleError: unknown = null;
    const histogram = monitorEventLoopDelay({ resolution: 10 });
    const flowCpuStart = process.cpuUsage();
    const metrics: MetricRecorder = {
      recordQueueLatency(milliseconds) {
        metric(milliseconds);
        maximumQueueLatencyMs = Math.max(maximumQueueLatencyMs, milliseconds);
      },
      recordProviderLatency(milliseconds) {
        metric(milliseconds);
        maximumProviderLatencyMs = Math.max(maximumProviderLatencyMs, milliseconds);
      },
      startCleanup() {
        if (cleanupStartedAt !== null) throw observerError("invalid_metric");
        cleanupStartedAt = performance.now();
      },
      completeCleanup() {
        if (cleanupStartedAt === null) throw observerError("invalid_metric");
        cleanupLagMs = round(performance.now() - cleanupStartedAt);
        cleanupStartedAt = null;
      }
    };

    const sample = async () => {
      if (sampleCount >= input.maximumSamples) return;
      sampleCount += 1;
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      peakActiveResources = Math.max(peakActiveResources, activeResourceCount());
      const connections = await input.sampleDatabaseConnections();
      nonnegative(connections, "invalid_metric");
      peakDatabaseConnections = Math.max(peakDatabaseConnections, connections);
    };
    const scheduleSample = () => {
      if (sampling || sampleCount >= input.maximumSamples) return;
      sampling = sample().catch((error) => {
        sampleError = error;
      }).finally(() => {
        sampling = null;
      });
    };

    await sample();
    histogram.enable();
    const timer = setInterval(scheduleSample, input.sampleIntervalMs);
    timer.unref();
    try {
      await request.run(metrics);
    } catch (error) {
      runError = error;
    } finally {
      clearInterval(timer);
      if (sampling) await sampling;
      histogram.disable();
    }

    const flowCpu = process.cpuUsage(flowCpuStart);
    const idleCpuStart = process.cpuUsage();
    try {
      await request.settle();
    } catch (error) {
      settleError = error;
    }
    const idleCpu = process.cpuUsage(idleCpuStart);
    const idleDatabaseConnections = await input.sampleDatabaseConnections();
    nonnegative(idleDatabaseConnections, "invalid_metric");
    const idleRssBytes = process.memoryUsage().rss;
    const idleActiveResources = activeResourceCount();
    peakRssBytes = Math.max(peakRssBytes, idleRssBytes);
    peakActiveResources = Math.max(peakActiveResources, idleActiveResources);
    const report: StorageVnextRuntimeFlowReport = {
      flow: request.flow,
      outcome: runError || settleError || sampleError ? "failed" : "completed",
      baselineRssBytes,
      peakRssBytes,
      idleRssBytes,
      idleRssDeltaBytes: idleRssBytes - baselineRssBytes,
      cpuMicros: safeCpu(flowCpu),
      idleCpuMicros: safeCpu(idleCpu),
      eventLoopDelayP95Ms: finiteDelay(histogram.percentile(95)),
      baselineActiveResources,
      peakActiveResources,
      idleActiveResources,
      idleActiveResourceDelta: idleActiveResources - baselineActiveResources,
      peakDatabaseConnections,
      idleDatabaseConnections,
      maximumQueueLatencyMs,
      maximumProviderLatencyMs,
      cleanupLagMs,
      sampleCount
    };
    completedReports.push(report);
    const errors = [runError, settleError, sampleError].filter((error) => error !== null);
    if (errors.length > 0) {
      throw new AggregateError(errors, "Storage vNext runtime flow measurement failed");
    }
    return report;
  }
}

function safeCpu(usage: NodeJS.CpuUsage): number {
  return sumSafe(usage.user, usage.system);
}

function sumSafe(left: number, right: number): number {
  nonnegative(left, "invalid_metric");
  nonnegative(right, "invalid_metric");
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw observerError("invalid_metric");
  return value;
}

function finiteDelay(nanoseconds: number): number {
  if (!Number.isFinite(nanoseconds) || nanoseconds < 0) return 0;
  return round(nanoseconds / 1_000_000);
}

function activeResourceCount(): number {
  return process.getActiveResourcesInfo().length;
}

function metric(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw observerError("invalid_metric");
}

function positive(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw observerError(code);
}

function nonnegative(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw observerError(code);
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function observerError(code: string): Error {
  return Object.assign(
    new Error(`Storage vNext runtime flow observer error: ${code}`),
    { code }
  );
}
