import type {
  SemanticStageKind
} from "./stage-orchestration.js";

type SemanticStageOutcome =
  | "completed" | "superseded" | "retry" | "failed" | "cancelled";

type StageCounter = {
  executionCount: number;
  completedCount: number;
  supersededCount: number;
  retryCount: number;
  failedCount: number;
  cancelledCount: number;
  totalDurationMs: number;
  maximumDurationMs: number;
};

const STAGE_KINDS: readonly SemanticStageKind[] = [
  "extraction", "reconciliation", "community", "embedding",
  "vector", "publication", "validation", "cleanup"
];

export function createSemanticStageMetrics() {
  const byStage = Object.fromEntries(
    STAGE_KINDS.map((stageKind) => [stageKind, createCounter()])
  ) as Record<SemanticStageKind, StageCounter>;
  const total = createCounter();
  return {
    record(input: {
      stageKind: SemanticStageKind;
      outcome: SemanticStageOutcome;
      durationMs: number;
    }): void {
      recordCounter(total, input.outcome, input.durationMs);
      recordCounter(byStage[input.stageKind], input.outcome, input.durationMs);
    },
    diagnosticFields(): Record<string, number> {
      return {
        ...counterFields("stage", total, true),
        ...Object.fromEntries(STAGE_KINDS.flatMap((stageKind) =>
          Object.entries(counterFields(stageKind, byStage[stageKind], false))
        ))
      };
    }
  };
}

function createCounter(): StageCounter {
  return {
    executionCount: 0,
    completedCount: 0,
    supersededCount: 0,
    retryCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    totalDurationMs: 0,
    maximumDurationMs: 0
  };
}

function recordCounter(
  counter: StageCounter,
  outcome: SemanticStageOutcome,
  durationMs: number
): void {
  const boundedDurationMs = Number.isFinite(durationMs)
    ? Math.max(0, durationMs)
    : 0;
  counter.executionCount += 1;
  counter[`${outcome}Count`] += 1;
  counter.totalDurationMs += boundedDurationMs;
  counter.maximumDurationMs = Math.max(
    counter.maximumDurationMs,
    boundedDurationMs
  );
}

function counterFields(
  prefix: string,
  counter: StageCounter,
  includeTerminalDetails: boolean
): Record<string, number> {
  return {
    [`${prefix}ExecutionCount`]: counter.executionCount,
    [`${prefix}CompletedCount`]: counter.completedCount,
    [`${prefix}RetryCount`]: counter.retryCount,
    [`${prefix}FailedCount`]: counter.failedCount,
    ...(includeTerminalDetails
      ? {
          [`${prefix}SupersededCount`]: counter.supersededCount,
          [`${prefix}CancelledCount`]: counter.cancelledCount
        }
      : {}),
    [`${prefix}AverageDurationMs`]: roundMetric(
      counter.executionCount === 0
        ? 0
        : counter.totalDurationMs / counter.executionCount
    ),
    [`${prefix}MaximumDurationMs`]: roundMetric(counter.maximumDurationMs)
  };
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
