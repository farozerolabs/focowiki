import { describe, expect, it, vi } from "vitest";
import { createResourceBudgetReporter } from "../src/runtime/resource-budget-reporter.js";
import { createProcessResourceBudgets } from "../src/runtime/resource-budget.js";

describe("resource budget reporter", () => {
  it("emits sanitized aggregate snapshots at a bounded interval", async () => {
    let now = 1_000;
    const info = vi.fn();
    const reporter = createResourceBudgetReporter({
      logger: { info },
      intervalMs: 60_000,
      now: () => now
    });
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
    await budgets.sourceObjectRead.run(async () => undefined);

    expect(reporter.report(budgets)).toBe(true);
    expect(reporter.report(budgets)).toBe(false);
    now += 60_000;
    expect(reporter.report(budgets)).toBe(true);
    expect(info).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenCalledWith("Resource budget metrics", {
      budgets: expect.objectContaining({
        sourceObjectRead: expect.objectContaining({ completed: 1 })
      })
    });
    const serialized = JSON.stringify(info.mock.calls);
    expect(serialized).not.toContain("content");
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("apiKey");
  });

  it("emits a final snapshot when forced before the interval elapses", () => {
    const info = vi.fn();
    const reporter = createResourceBudgetReporter({
      logger: { info },
      intervalMs: 60_000,
      now: () => 1_000
    });
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

    expect(reporter.report(budgets)).toBe(true);
    expect(reporter.report(budgets)).toBe(false);
    expect(reporter.report(budgets, { force: true })).toBe(true);
    expect(info).toHaveBeenCalledTimes(2);
  });
});
