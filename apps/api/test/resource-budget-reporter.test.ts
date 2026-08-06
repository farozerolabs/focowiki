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
      generatedObjectWrite: 1
    });
    await budgets.generatedObjectWrite.run(async () => undefined);

    expect(reporter.report(budgets)).toBe(true);
    expect(reporter.report(budgets)).toBe(false);
    now += 60_000;
    expect(reporter.report(budgets)).toBe(true);
    expect(info).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenCalledWith("runtime.resource_budget_metrics", expect.objectContaining({
      generatedObjectWriteCompleted: 1,
      modelActive: expect.any(Number),
      rssBytes: expect.any(Number),
      heapUsedBytes: expect.any(Number),
      externalBytes: expect.any(Number),
      maximumRssBytes: expect.any(Number),
      activeResources: expect.any(Number),
      activeResourceTypes: expect.stringMatching(/^[A-Za-z0-9_=-]+(?:,[A-Za-z0-9_=-]+)*$/u),
      userCpuMicros: expect.any(Number),
      systemCpuMicros: expect.any(Number),
      eventLoopUtilization: expect.any(Number)
    }));
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
      generatedObjectWrite: 1
    });

    expect(reporter.report(budgets)).toBe(true);
    expect(reporter.report(budgets)).toBe(false);
    expect(reporter.report(budgets, { force: true })).toBe(true);
    expect(info).toHaveBeenCalledTimes(2);
  });
});
