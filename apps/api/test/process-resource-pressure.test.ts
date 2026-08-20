import { describe, expect, it } from "vitest";
import {
  calculateProcessResourcePressure,
  createProcessResourcePressureReader
} from
  "../src/document-indexing/application/process-resource-pressure.js";

describe("process resource pressure", () => {
  it("uses the V8 heap limit instead of current heap allocation", () => {
    expect(calculateProcessResourcePressure({
      heapUsed: 90,
      heapLimit: 1_000,
      rss: 200,
      systemMemory: 8_000,
      constrainedMemory: 2_000,
      processCpuMicros: 500_000,
      elapsedMilliseconds: 1_000,
      cpuCount: 2
    })).toEqual({
      cpuPressure: 0.25,
      memoryPressure: 0.1,
      pressureSource: "process_cpu_cgroup_memory"
    });
  });

  it("uses the container memory limit when it is lower than host memory", () => {
    expect(calculateProcessResourcePressure({
      heapUsed: 100,
      heapLimit: 1_000,
      rss: 1_800,
      systemMemory: 16_000,
      constrainedMemory: 2_000,
      processCpuMicros: 0,
      elapsedMilliseconds: 1_000,
      cpuCount: 2
    }).memoryPressure).toBe(0.9);
  });

  it("ignores host load generated outside an idle quota-constrained worker", () => {
    const samples = [
      { user: 1_000_000, system: 500_000 },
      { user: 1_010_000, system: 505_000 }
    ];
    const times = [1_000, 2_000];
    const reader = createProcessResourcePressureReader({
      clockMilliseconds: () => times.shift()!,
      cpuUsage: () => samples.shift()!,
      cpuCount: () => 2,
      memoryUsage: () => ({ heapUsed: 100, rss: 200 } as NodeJS.MemoryUsage),
      heapLimit: () => 1_000,
      systemMemory: () => 8_000,
      constrainedMemory: () => 2_000
    });

    expect(reader().cpuPressure).toBe(0);
    expect(reader().cpuPressure).toBeCloseTo(0.0075, 4);
  });
});
