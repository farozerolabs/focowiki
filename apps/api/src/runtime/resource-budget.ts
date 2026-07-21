export type ResourceBudgetName =
  | "model"
  | "sourceObjectRead"
  | "generatedObjectWrite"
  | "graphQuery"
  | "databaseMutation"
  | "directory"
  | "projectionPartition"
  | "generationAssembly"
  | "migrationBackfill"
  | "compaction";

export type ResourceBudgetLimits = Record<ResourceBudgetName, number>;

export type ResourceBudgetSnapshot = {
  concurrency: number;
  active: number;
  waiting: number;
  started: number;
  completed: number;
  failed: number;
  retries: number;
  saturationCount: number;
  saturated: boolean;
  utilization: number;
  totalWaitMs: number;
  maxWaitMs: number;
  averageWaitMs: number;
  totalRunMs: number;
  maxRunMs: number;
  averageRunMs: number;
  throughputPerSecond: number;
};

export type ResourceBudget = {
  run<T>(operation: () => Promise<T>): Promise<T>;
  recordRetry(count?: number): void;
  snapshot(): ResourceBudgetSnapshot;
};

export type ProcessResourceBudgets = Record<ResourceBudgetName, ResourceBudget> & {
  update(limits: Partial<ResourceBudgetLimits>): void;
  snapshots(): Record<ResourceBudgetName, ResourceBudgetSnapshot>;
};

type MutableResourceBudget = ResourceBudget & {
  updateConcurrency(concurrency: number): void;
};

export function createProcessResourceBudgets(
  limits: ResourceBudgetLimits
): ProcessResourceBudgets {
  const budgets = Object.fromEntries(
    resourceBudgetNames().map((name) => [name, createResourceBudget(limits[name])])
  ) as Record<ResourceBudgetName, MutableResourceBudget>;
  return {
    ...budgets,
    update(updates) {
      for (const name of resourceBudgetNames()) {
        const concurrency = updates[name];
        if (concurrency !== undefined) budgets[name].updateConcurrency(concurrency);
      }
    },
    snapshots() {
      return Object.fromEntries(
        resourceBudgetNames().map((name) => [name, budgets[name].snapshot()])
      ) as Record<ResourceBudgetName, ResourceBudgetSnapshot>;
    }
  };
}

function createResourceBudget(initialConcurrency: number): MutableResourceBudget {
  const createdAt = Date.now();
  let concurrency = positiveInteger(initialConcurrency, "resource concurrency");
  let active = 0;
  let started = 0;
  let completed = 0;
  let failed = 0;
  let retries = 0;
  let saturationCount = 0;
  let totalWaitMs = 0;
  let maxWaitMs = 0;
  let totalRunMs = 0;
  let maxRunMs = 0;
  const queue: Array<{
    enqueuedAt: number;
    start(): void;
  }> = [];

  const drain = () => {
    while (active < concurrency && queue.length > 0) {
      const next = queue.shift()!;
      const waitMs = Math.max(0, Date.now() - next.enqueuedAt);
      totalWaitMs += waitMs;
      maxWaitMs = Math.max(maxWaitMs, waitMs);
      active += 1;
      started += 1;
      next.start();
    }
  };

  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (active >= concurrency || queue.length > 0) saturationCount += 1;
        queue.push({
          enqueuedAt: Date.now(),
          start() {
            const startedAt = Date.now();
            Promise.resolve()
              .then(operation)
              .then((result) => {
                completed += 1;
                resolve(result);
              }, (error) => {
                failed += 1;
                reject(error);
              })
              .finally(() => {
                const runMs = Math.max(0, Date.now() - startedAt);
                totalRunMs += runMs;
                maxRunMs = Math.max(maxRunMs, runMs);
                active -= 1;
                drain();
              });
          }
        });
        drain();
      });
    },
    updateConcurrency(value) {
      concurrency = positiveInteger(value, "resource concurrency");
      drain();
    },
    recordRetry(count = 1) {
      retries += positiveInteger(count, "resource retry count");
    },
    snapshot() {
      const finished = completed + failed;
      const elapsedSeconds = Math.max(0.001, (Date.now() - createdAt) / 1_000);
      return {
        concurrency,
        active,
        waiting: queue.length,
        started,
        completed,
        failed,
        retries,
        saturationCount,
        saturated: active >= concurrency || queue.length > 0,
        utilization: roundMetric(active / concurrency),
        totalWaitMs,
        maxWaitMs,
        averageWaitMs: roundMetric(started === 0 ? 0 : totalWaitMs / started),
        totalRunMs,
        maxRunMs,
        averageRunMs: roundMetric(finished === 0 ? 0 : totalRunMs / finished),
        throughputPerSecond: roundMetric(finished / elapsedSeconds)
      };
    }
  };
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function resourceBudgetNames(): ResourceBudgetName[] {
  return [
    "model",
    "sourceObjectRead",
    "generatedObjectWrite",
    "graphQuery",
    "databaseMutation",
    "directory",
    "projectionPartition",
    "generationAssembly",
    "migrationBackfill",
    "compaction"
  ];
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}
