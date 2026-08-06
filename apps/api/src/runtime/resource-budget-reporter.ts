import { performance } from "node:perf_hooks";
import type {
  RuntimeDiagnosticFields,
  RuntimeDiagnosticValue,
  RuntimeLogger
} from "../logger.js";
import type {
  ProcessResourceBudgets,
  ResourceBudgetName
} from "./resource-budget.js";

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
      const activeResourceInfo = process.getActiveResourcesInfo();
      input.logger.info("runtime.resource_budget_metrics", {
        ...budgetDiagnosticFields(budgets),
        rssBytes: memory.rss,
        maximumRssBytes: Math.trunc(resourceUsage.maxRSS * 1_024),
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
        activeResources: activeResourceInfo.length,
        activeResourceTypes: summarizeActiveResourceTypes(activeResourceInfo),
        userCpuMicros: resourceUsage.userCPUTime - previousResourceUsage.userCPUTime,
        systemCpuMicros: resourceUsage.systemCPUTime - previousResourceUsage.systemCPUTime,
        eventLoopUtilization: roundMetric(eventLoopUtilization.utilization)
      });
      previousResourceUsage = resourceUsage;
      previousEventLoopUtilization = performance.eventLoopUtilization();
      return true;
    }
  };
}

function summarizeActiveResourceTypes(resources: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const resource of resources) {
    counts.set(resource, (counts.get(resource) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([resource, count]) => `${resource}=${count}`)
    .join(",");
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function budgetDiagnosticFields(
  budgets: ProcessResourceBudgets
): RuntimeDiagnosticFields {
  const fields: Record<string, RuntimeDiagnosticValue> = {};
  const snapshots = budgets.snapshots();
  for (const name of RESOURCE_BUDGET_NAMES) {
    const snapshot = snapshots[name];
    fields[`${name}Active`] = snapshot.active;
    fields[`${name}Waiting`] = snapshot.waiting;
    fields[`${name}Completed`] = snapshot.completed;
    fields[`${name}Failed`] = snapshot.failed;
    fields[`${name}Retries`] = snapshot.retries;
  }
  return fields;
}

const RESOURCE_BUDGET_NAMES: readonly ResourceBudgetName[] = [
  "model",
  "generatedObjectWrite"
];
