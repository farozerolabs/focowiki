import { describe, expect, it } from "vitest";
import { calculateProcessResourcePressure } from
  "../src/document-indexing/application/process-resource-pressure.js";

describe("process resource pressure", () => {
  it("uses the V8 heap limit instead of current heap allocation", () => {
    expect(calculateProcessResourcePressure({
      heapUsed: 90,
      heapLimit: 1_000,
      rss: 200,
      systemMemory: 8_000,
      constrainedMemory: 2_000,
      loadAverage: 0.5,
      cpuCount: 2
    })).toEqual({
      cpuPressure: 0.25,
      memoryPressure: 0.1
    });
  });

  it("uses the container memory limit when it is lower than host memory", () => {
    expect(calculateProcessResourcePressure({
      heapUsed: 100,
      heapLimit: 1_000,
      rss: 1_800,
      systemMemory: 16_000,
      constrainedMemory: 2_000,
      loadAverage: 0,
      cpuCount: 2
    }).memoryPressure).toBe(0.9);
  });
});
