import type {
  SearchEnginePressure
} from "../application/ports/search-engine-transport.js";

const TRANSIENT_PRESSURE_RELEASE_RATIO = 0.9;

export type SearchIndexingPressureReason =
  | "queue_latency"
  | "resident_memory"
  | "database_size"
  | "task_queue_size"
  | "pressure_unavailable";

export type SearchIndexingPressureLimits = SearchEnginePressure;

export type SearchIndexingSubmissionPolicy = {
  allowIndexWrites: boolean;
  allowRoutineEngineTasks: boolean;
  throttleIndexWrites: boolean;
};

export type SearchIndexingPressureDecision = {
  reasons: SearchIndexingPressureReason[];
  pressure: SearchEnginePressure | null;
  limits: SearchIndexingPressureLimits;
  releaseLimits: SearchIndexingPressureLimits;
  submissionPolicy: SearchIndexingSubmissionPolicy;
};

export interface SearchIndexingPressureController {
  evaluate(
    pressure: SearchEnginePressure,
    limits: SearchIndexingPressureLimits
  ): SearchIndexingPressureDecision;
  unavailable(
    limits: SearchIndexingPressureLimits
  ): SearchIndexingPressureDecision;
}

type PressureMetric = {
  reason: Exclude<SearchIndexingPressureReason, "pressure_unavailable">;
  key: keyof SearchEnginePressure;
};

const PRESSURE_METRICS: PressureMetric[] = [
  { reason: "queue_latency", key: "queueLatencyMs" },
  { reason: "resident_memory", key: "residentMemoryBytes" },
  { reason: "database_size", key: "databaseSizeBytes" },
  { reason: "task_queue_size", key: "taskQueueSizeBytes" }
];

export function createSearchIndexingPressureController(): SearchIndexingPressureController {
  const activeReasons = new Set<SearchIndexingPressureReason>();

  return {
    evaluate(pressure, limits) {
      activeReasons.delete("pressure_unavailable");
      const releaseLimits = createReleaseLimits(limits);
      for (const metric of PRESSURE_METRICS) {
        const value = pressure[metric.key];
        if (value > limits[metric.key]) {
          activeReasons.add(metric.reason);
          continue;
        }
        if (value <= releaseLimits[metric.key]) {
          activeReasons.delete(metric.reason);
        }
      }
      return createDecision({
        activeReasons,
        pressure,
        limits,
        releaseLimits
      });
    },

    unavailable(limits) {
      activeReasons.add("pressure_unavailable");
      return createDecision({
        activeReasons,
        pressure: null,
        limits,
        releaseLimits: createReleaseLimits(limits)
      });
    }
  };
}

function createReleaseLimits(
  limits: SearchIndexingPressureLimits
): SearchIndexingPressureLimits {
  return {
    queueLatencyMs: transientReleaseLimit(limits.queueLatencyMs),
    residentMemoryBytes: transientReleaseLimit(limits.residentMemoryBytes),
    databaseSizeBytes: limits.databaseSizeBytes,
    taskQueueSizeBytes: transientReleaseLimit(limits.taskQueueSizeBytes)
  };
}

function transientReleaseLimit(limit: number): number {
  return Math.floor(limit * TRANSIENT_PRESSURE_RELEASE_RATIO);
}

function createDecision(input: {
  activeReasons: Set<SearchIndexingPressureReason>;
  pressure: SearchEnginePressure | null;
  limits: SearchIndexingPressureLimits;
  releaseLimits: SearchIndexingPressureLimits;
}): SearchIndexingPressureDecision {
  const reasons = PRESSURE_REASON_ORDER.filter((reason) =>
    input.activeReasons.has(reason)
  );
  const engineQueueBlocked = reasons.some((reason) =>
    reason === "queue_latency"
    || reason === "task_queue_size"
    || reason === "pressure_unavailable"
  );
  const indexWritesBlocked = reasons.some((reason) =>
    reason === "queue_latency"
    || reason === "database_size"
    || reason === "task_queue_size"
    || reason === "pressure_unavailable"
  );
  return {
    reasons,
    pressure: input.pressure,
    limits: input.limits,
    releaseLimits: input.releaseLimits,
    submissionPolicy: {
      allowIndexWrites: !indexWritesBlocked,
      allowRoutineEngineTasks: !engineQueueBlocked,
      throttleIndexWrites:
        !indexWritesBlocked && reasons.includes("resident_memory")
    }
  };
}

const PRESSURE_REASON_ORDER: SearchIndexingPressureReason[] = [
  "queue_latency",
  "resident_memory",
  "database_size",
  "task_queue_size",
  "pressure_unavailable"
];
