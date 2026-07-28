export type DurationSummary = {
  count: number;
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
  maximumMs: number;
};

export function createOperationTimer(
  now: () => number = () => performance.now()
): {
  track: <Value>(operation: Promise<Value>) => Promise<Value>;
  elapsedMs: () => number;
} {
  const startedAt = now();
  let completedAt: number | null = null;

  return {
    track<Value>(operation: Promise<Value>): Promise<Value> {
      return operation.finally(() => {
        completedAt ??= now();
      });
    },
    elapsedMs(): number {
      if (completedAt === null) {
        throw new Error("The tracked operation has not completed");
      }
      return completedAt - startedAt;
    }
  };
}

export function summarizeDurations(values: number[]): DurationSummary {
  if (values.length === 0) {
    return {
      count: 0,
      averageMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      maximumMs: 0
    };
  }

  let total = 0;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    total += value;
    if (value > maximum) maximum = value;
  }

  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: values.length,
    averageMs: round(total / values.length),
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    maximumMs: round(maximum)
  };
}

function percentile(sorted: number[], ratio: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]!;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
