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
  return {
    report(
      budgets: ProcessResourceBudgets,
      options: { force?: boolean } = {}
    ): boolean {
      const reportedAt = now();
      if (!options.force && reportedAt < nextReportAt) return false;
      nextReportAt = reportedAt + intervalMs;
      input.logger.info("Resource budget metrics", {
        budgets: budgets.snapshots()
      });
      return true;
    }
  };
}
