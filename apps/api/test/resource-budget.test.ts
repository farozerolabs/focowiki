import { describe, expect, it, vi } from "vitest";
import { createProcessResourceBudgets } from "../src/runtime/resource-budget.js";

describe("process resource budgets", () => {
  it("isolates saturated resource classes", async () => {
    const budgets = createProcessResourceBudgets({
      model: 1,
      sourceObjectRead: 1,
      generatedObjectWrite: 1,
      graphQuery: 1,
      databaseMutation: 1,
      directory: 1,
      projectionPartition: 1,
      generationAssembly: 1,
      migrationBackfill: 1,
      compaction: 1
    });
    let releaseModel!: () => void;
    const blockedModel = budgets.model.run(() => new Promise<void>((resolve) => {
      releaseModel = resolve;
    }));

    await expect(budgets.sourceObjectRead.run(async () => "read"))
      .resolves.toBe("read");
    expect(budgets.model.snapshot()).toMatchObject({ active: 1, waiting: 0 });
    releaseModel();
    await blockedModel;
  });

  it("enforces bounded concurrency and updates later claims", async () => {
    vi.useFakeTimers();
    try {
      const budgets = createProcessResourceBudgets({
        model: 1,
        sourceObjectRead: 1,
        generatedObjectWrite: 1,
        graphQuery: 1,
        databaseMutation: 1,
        directory: 1,
        projectionPartition: 1,
        generationAssembly: 1,
        migrationBackfill: 1,
        compaction: 1
      });
      let active = 0;
      let peak = 0;
      const run = () => budgets.graphQuery.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
      });
      const first = run();
      const second = run();
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(10);
      await Promise.all([first, second]);
      expect(peak).toBe(1);

      budgets.update({ graphQuery: 2 });
      const third = run();
      const fourth = run();
      await vi.advanceTimersByTimeAsync(10);
      await Promise.all([third, fourth]);
      expect(peak).toBe(2);
      expect(budgets.graphQuery.snapshot()).toMatchObject({
        active: 0,
        waiting: 0,
        started: 4,
        completed: 4,
        failed: 0,
        saturationCount: 1,
        concurrency: 2
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports bounded ownership, latency, retry, saturation, and throughput metrics", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00.000Z"));
    try {
      const budgets = createProcessResourceBudgets({
        model: 1,
        sourceObjectRead: 1,
        generatedObjectWrite: 1,
        graphQuery: 1,
        databaseMutation: 1,
        directory: 1,
        projectionPartition: 1,
        generationAssembly: 1,
        migrationBackfill: 1,
        compaction: 1
      });
      const first = budgets.model.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      const second = budgets.model.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(budgets.model.snapshot()).toMatchObject({
        active: 1,
        waiting: 1,
        saturated: true,
        saturationCount: 1
      });
      budgets.model.recordRetry(2);
      await vi.advanceTimersByTimeAsync(30);
      await Promise.all([first, second]);

      expect(budgets.model.snapshot()).toMatchObject({
        active: 0,
        waiting: 0,
        started: 2,
        completed: 2,
        failed: 0,
        retries: 2,
        totalWaitMs: 20,
        maxWaitMs: 20,
        averageWaitMs: 10,
        totalRunMs: 30,
        maxRunMs: 20,
        averageRunMs: 15,
        throughputPerSecond: expect.any(Number),
        saturated: false
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
