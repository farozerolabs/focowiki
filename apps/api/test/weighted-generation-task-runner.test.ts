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
    runner.updateLimits(8, 20);
    expect(runner.snapshot().capacity).toBe(2);
  });

  it("adapts when a provider failure is returned as a classified result", async () => {
    const runner = createWeightedGenerationTaskRunner({
      configuredMaximum: 8,
      maximumWaiters: 20,
      weights: {
        first_layer: 4,
        graphrag: 2,
        candidate_delta: 1,
        slow_retry: 1
      },
      pressure: () => ({ cpuPressure: 0.1, memoryPressure: 0.2 })
    });

    await expect(runner.run("candidate_delta", async () => ({
      warnings: ["Model response idle timeout reached"]
    }), {
      classifyResult(result) {
        return result.warnings.some((warning) => warning.includes("timeout"))
          ? "timeout"
          : "success";
      }
    })).resolves.toEqual({
      warnings: ["Model response idle timeout reached"]
    });

    expect(runner.snapshot().capacity).toBe(2);
  });

  it("ramps a model revision from a bounded cold-start capacity", async () => {
    const runner = createWeightedGenerationTaskRunner({
      configuredMaximum: 40,
      maximumWaiters: 100,
      weights: {
        first_layer: 4,
        graphrag: 2,
        candidate_delta: 1,
        slow_retry: 1
      }
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = 0;
    const tasks = Array.from({ length: 16 }, () => runner.run(
      "candidate_delta",
      async () => {
        started += 1;
        await gate;
      },
      { ownerKey: "model-revision-a" }
    ));

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(started).toBe(4);
    expect(runner.snapshot().owners["model-revision-a"]).toEqual({
      active: 4,
      capacity: 4
    });

    release();
    await Promise.all(tasks);
  });
});
