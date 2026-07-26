import { performance } from "node:perf_hooks";
import type { RuntimeLogger } from "../logger.js";
import type { ProcessResourceBudgets } from "./resource-budget.js";

export function createResourceBudgetReporter(input: {
  logger: Pick<RuntimeLogger, "info">;
  intervalMs?: number;
  now?: () => number;
}) {
  const intervalMs = input.intervalMs ?? 60_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("Resource budget report interval must be positive");
  }
  const now = input.now ?? Date.now;
  let nextReportAt = 0;
  let previousResourceUsage = process.resourceUsage();
  let previousEventLoopUtilization = performance.eventLoopUtilization();
  return {
    report(
      budgets: ProcessResourceBudgets,
      options: { force?: boolean } = {}
    ): boolean {
      const reportedAt = now();
      if (!options.force && reportedAt < nextReportAt) return false;
      nextReportAt = reportedAt + intervalMs;
      const memory = process.memoryUsage();
      const resourceUsage = process.resourceUsage();
      const eventLoopUtilization = performance.eventLoopUtilization(
        previousEventLoopUtilization
      );
      input.logger.info("Resource budget metrics", {
        budgets: budgets.snapshots(),
        process: {
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          externalBytes: memory.external,
          userCpuMicros:
            resourceUsage.userCPUTime - previousResourceUsage.userCPUTime,
          systemCpuMicros:
            resourceUsage.systemCPUTime - previousResourceUsage.systemCPUTime,
          eventLoopUtilization: roundMetric(eventLoopUtilization.utilization)
        }
      });
      previousResourceUsage = resourceUsage;
      previousEventLoopUtilization = performance.eventLoopUtilization();
      return true;
    }
  };
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
