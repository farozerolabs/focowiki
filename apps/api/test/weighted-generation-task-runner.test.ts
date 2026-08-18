import { describe, expect, it } from "vitest";
import { createWeightedGenerationTaskRunner } from
  "../src/document-indexing/application/weighted-generation-task-runner.js";

describe("weighted generation task runner", () => {
  it("keeps first-layer progress while remaining work-conserving", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const runner = createWeightedGenerationTaskRunner({
      configuredMaximum: 1,
      maximumWaiters: 20,
      weights: {
        first_layer: 4,
        graphrag: 2,
        candidate_delta: 1,
        slow_retry: 1
      }
    });
    const blocking = runner.run("graphrag", async () => {
      order.push("blocking");
      await gate;
      return "blocking";
    });
    const queued = [
      runner.run("graphrag", async () => { order.push("graph"); }),
      runner.run("first_layer", async () => { order.push("first-a"); }),
      runner.run("first_layer", async () => { order.push("first-b"); }),
      runner.run("slow_retry", async () => { order.push("slow"); })
    ];
    releaseFirst();
    await Promise.all([blocking, ...queued]);

    expect(order.slice(0, 3)).toEqual(["blocking", "first-a", "first-b"]);
    expect(order).toContain("graph");
    expect(order).toContain("slow");
  });

  it("reduces effective capacity without exceeding the configured maximum", () => {
    const runner = createWeightedGenerationTaskRunner({
      configuredMaximum: 4,
      maximumWaiters: 20,
      weights: {
        first_layer: 4,
        graphrag: 2,
        candidate_delta: 1,
        slow_retry: 1
      }
    });
    expect(runner.observe({
      outcome: "rate_limited",
      latencyMs: 100,
      cpuPressure: 0.1,
      memoryPressure: 0.1
    })).toBe(2);
    expect(runner.snapshot().configuredMaximum).toBe(4);
  });

  it("automatically reduces provider capacity after a rate limit", async () => {
    const runner = createWeightedGenerationTaskRunner({
      configuredMaximum: 4,
      maximumWaiters: 20,
      weights: {
        first_layer: 4,
        graphrag: 2,
        candidate_delta: 1,
        slow_retry: 1
      },
      pressure: () => ({ cpuPressure: 0.1, memoryPressure: 0.2 })
    });
    await expect(runner.run("first_layer", async () => {
      throw Object.assign(new Error("provider limited"), { code: "RATE_LIMITED" });
    })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(runner.snapshot().capacity).toBe(2);
  });
});
