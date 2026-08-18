import { availableParallelism, loadavg, totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";

export type ProcessResourcePressure = {
  cpuPressure: number;
  memoryPressure: number;
};

export function readProcessResourcePressure(): ProcessResourcePressure {
  const memory = process.memoryUsage();
  const constrainedMemory = process.constrainedMemory?.() ?? 0;
  return calculateProcessResourcePressure({
    heapUsed: memory.heapUsed,
    heapLimit: getHeapStatistics().heap_size_limit,
    rss: memory.rss,
    systemMemory: totalmem(),
    constrainedMemory,
    loadAverage: loadavg()[0] ?? 0,
    cpuCount: availableParallelism()
  });
}

export function calculateProcessResourcePressure(input: {
  heapUsed: number;
  heapLimit: number;
  rss: number;
  systemMemory: number;
  constrainedMemory: number;
  loadAverage: number;
  cpuCount: number;
}): ProcessResourcePressure {
  const heapPressure = ratio(input.heapUsed, input.heapLimit);
  const memoryLimit = input.constrainedMemory > 0
    ? Math.min(input.systemMemory, input.constrainedMemory)
    : input.systemMemory;
  const residentPressure = ratio(input.rss, memoryLimit);
  const cpuPressure = input.loadAverage / Math.max(1, input.cpuCount);
  return {
    cpuPressure: boundedPressure(cpuPressure),
    memoryPressure: boundedPressure(Math.max(heapPressure, residentPressure))
  };
}

function ratio(value: number, limit: number): number {
  return Number.isFinite(value) && value >= 0
    && Number.isFinite(limit) && limit > 0 ? value / limit : 0;
}

function boundedPressure(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
