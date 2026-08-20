import { availableParallelism, totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";

export type ProcessResourcePressure = {
  cpuPressure: number;
  memoryPressure: number;
  pressureSource: "process_cpu_cgroup_memory";
};

export const readProcessResourcePressure = createProcessResourcePressureReader();

export function createProcessResourcePressureReader(input: {
  clockMilliseconds?: () => number;
  cpuUsage?: () => NodeJS.CpuUsage;
  cpuCount?: () => number;
  memoryUsage?: () => NodeJS.MemoryUsage;
  heapLimit?: () => number;
  systemMemory?: () => number;
  constrainedMemory?: () => number;
} = {}): () => ProcessResourcePressure {
  const clock = input.clockMilliseconds ?? Date.now;
  const cpuUsage = input.cpuUsage ?? process.cpuUsage;
  let previousAt: number | null = null;
  let previousCpu: NodeJS.CpuUsage | null = null;
  return () => {
    const currentAt = clock();
    const currentCpu = cpuUsage();
    const memory = (input.memoryUsage ?? process.memoryUsage)();
    const elapsedMilliseconds = previousAt === null
      ? 0 : Math.max(0, currentAt - previousAt);
    const processCpuMicros = previousCpu === null ? 0 : Math.max(0,
      currentCpu.user - previousCpu.user + currentCpu.system - previousCpu.system
    );
    previousAt = currentAt;
    previousCpu = currentCpu;
    return calculateProcessResourcePressure({
      heapUsed: memory.heapUsed,
      heapLimit: (input.heapLimit ?? (() => getHeapStatistics().heap_size_limit))(),
      rss: memory.rss,
      systemMemory: (input.systemMemory ?? totalmem)(),
      constrainedMemory: (input.constrainedMemory
        ?? (() => process.constrainedMemory?.() ?? 0))(),
      processCpuMicros,
      elapsedMilliseconds,
      cpuCount: (input.cpuCount ?? availableParallelism)()
    });
  };
}

export function calculateProcessResourcePressure(input: {
  heapUsed: number;
  heapLimit: number;
  rss: number;
  systemMemory: number;
  constrainedMemory: number;
  processCpuMicros: number;
  elapsedMilliseconds: number;
  cpuCount: number;
}): ProcessResourcePressure {
  const heapPressure = ratio(input.heapUsed, input.heapLimit);
  const memoryLimit = input.constrainedMemory > 0
    ? Math.min(input.systemMemory, input.constrainedMemory)
    : input.systemMemory;
  const residentPressure = ratio(input.rss, memoryLimit);
  const availableCpuMicros = input.elapsedMilliseconds * 1_000
    * Math.max(1, input.cpuCount);
  const cpuPressure = ratio(input.processCpuMicros, availableCpuMicros);
  return {
    cpuPressure: boundedPressure(cpuPressure),
    memoryPressure: boundedPressure(Math.max(heapPressure, residentPressure)),
    pressureSource: "process_cpu_cgroup_memory"
  };
}

function ratio(value: number, limit: number): number {
  return Number.isFinite(value) && value >= 0
    && Number.isFinite(limit) && limit > 0 ? value / limit : 0;
}

function boundedPressure(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
