import {
  createAdaptiveResourceController,
  type AdaptiveResourceObservation
} from "./adaptive-resource-controller.js";
import {
  createWeightedGenerationQueue,
  type GenerationWorkClass
} from "./weighted-generation-queue.js";
import { readProcessResourcePressure } from "./process-resource-pressure.js";

const INITIAL_PROVIDER_CAPACITY = 4;

export type GenerationTaskMetric = {
  workClass: GenerationWorkClass;
  waitTimeMs: number;
  serviceTimeMs: number;
  outcome: "success" | "failure";
};

type QueuedTask = {
  workClass: GenerationWorkClass;
  ownerKey: string;
  operation(): Promise<unknown>;
  signal: AbortSignal | undefined;
  enqueuedAt: number;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  onMetric: ((metric: GenerationTaskMetric) => void) | undefined;
  classifyResult: ((value: unknown) => AdaptiveResourceObservation["outcome"])
    | undefined;
};

export type WeightedGenerationTaskRunner = ReturnType<
  typeof createWeightedGenerationTaskRunner
>;

export function createWeightedGenerationTaskRunner(input: {
  configuredMaximum: number;
  maximumWaiters: number;
  weights: Record<GenerationWorkClass, number>;
  clockMs?: () => number;
  pressure?: () => { cpuPressure: number; memoryPressure: number };
  onMetric?(metric: GenerationTaskMetric): void;
}) {
  if (!Number.isSafeInteger(input.maximumWaiters)
    || input.maximumWaiters < 0 || input.maximumWaiters > 100_000) {
    throw new Error("GENERATION_WAITER_LIMIT_INVALID");
  }
  const clockMs = input.clockMs ?? Date.now;
  const pressure = input.pressure ?? readProcessResourcePressure;
  const controller = createAdaptiveResourceController({
    configuredMaximum: input.configuredMaximum
  });
  const providerControllers = new Map<string, ReturnType<
    typeof createAdaptiveResourceController
  >>();
  const activeByOwner = new Map<string, number>();
  const queue = createWeightedGenerationQueue<QueuedTask>({
    weights: input.weights
  });
  let active = 0;
  let maximumWaiters = input.maximumWaiters;
  let lastPressure: null | {
    cpuPressure: number;
    memoryPressure: number;
    pressureSource: string | null;
  } = null;

  function drain(): void {
    while (active < controller.capacity()) {
      const next = queue.dequeue((item) => ownerActive(item.ownerKey)
        < ownerController(item.ownerKey).capacity());
      if (!next) return;
      if (next.item.signal?.aborted) {
        next.item.reject(abortError(next.item.signal));
        continue;
      }
      active += 1;
      activeByOwner.set(next.item.ownerKey, ownerActive(next.item.ownerKey) + 1);
      const serviceStartedAt = clockMs();
      const workClass = next.workClass;
      void execute(next.item, workClass);

      async function execute(
        item: QueuedTask,
        taskWorkClass: GenerationWorkClass
      ): Promise<void> {
        let outcome: "success" | "failure" = "success";
        let result: unknown;
        let failure: unknown;
        try {
          result = await item.operation();
        } catch (error) {
          outcome = "failure";
          failure = error;
        } finally {
        const finishedAt = clockMs();
        active -= 1;
        activeByOwner.set(item.ownerKey, Math.max(0, ownerActive(item.ownerKey) - 1));
        const metric = {
          workClass: taskWorkClass,
          waitTimeMs: elapsed(item.enqueuedAt, serviceStartedAt),
          serviceTimeMs: elapsed(serviceStartedAt, finishedAt),
          outcome
        };
        const observation: AdaptiveResourceObservation = {
          outcome: failure === undefined && item.classifyResult
            ? item.classifyResult(result)
            : adaptiveOutcome(failure),
          latencyMs: metric.serviceTimeMs,
          ...pressure()
        };
        lastPressure = pressureSnapshot(observation);
        controller.observe({
          ...observation,
          outcome: observation.outcome === "rate_limited"
            || observation.outcome === "timeout"
            ? "failure"
            : observation.outcome
        });
        ownerController(item.ownerKey).observe({
          outcome: observation.outcome,
          latencyMs: observation.latencyMs,
          cpuPressure: 0,
          memoryPressure: 0,
          pressureSource: "model_revision_provider"
        });
        input.onMetric?.(metric);
        item.onMetric?.(metric);
        drain();
        }
        if (failure === undefined) item.resolve(result);
        else item.reject(failure);
      }
    }
  }

  return {
    run<TResult>(
      workClass: GenerationWorkClass,
      operation: () => Promise<TResult>,
      options: {
        signal?: AbortSignal;
        ownerKey?: string;
        onMetric?(metric: GenerationTaskMetric): void;
        classifyResult?(result: TResult): AdaptiveResourceObservation["outcome"];
      } = {}
    ): Promise<TResult> {
      if (options.signal?.aborted) {
        return Promise.reject(abortError(options.signal));
      }
      if (queue.size() >= maximumWaiters) {
        return Promise.reject(generationRunnerError(
          "GENERATION_WAITER_LIMIT_EXCEEDED"
        ));
      }
      return new Promise<TResult>((resolve, reject) => {
        const ownerKey = options.ownerKey?.trim() || "default";
        queue.enqueue(workClass, {
          workClass,
          ownerKey,
          operation,
          signal: options.signal,
          enqueuedAt: clockMs(),
          resolve: (value) => resolve(value as TResult),
          reject,
          onMetric: options.onMetric,
          classifyResult: options.classifyResult
            ? (value) => options.classifyResult!(value as TResult)
            : undefined
        });
        drain();
      });
    },
    observe(observation: AdaptiveResourceObservation): number {
      lastPressure = pressureSnapshot(observation);
      const capacity = controller.observe(observation);
      drain();
      return capacity;
    },
    updateLimits(configuredMaximum: number, nextMaximumWaiters: number): void {
      if (!Number.isSafeInteger(nextMaximumWaiters)
        || nextMaximumWaiters < 0 || nextMaximumWaiters > 100_000) {
        throw new Error("GENERATION_WAITER_LIMIT_INVALID");
      }
      maximumWaiters = nextMaximumWaiters;
      controller.updateConfiguredMaximum(configuredMaximum, {
        preserveCurrent: true
      });
      for (const owner of providerControllers.values()) {
        owner.updateConfiguredMaximum(configuredMaximum, {
          preserveCurrent: true
        });
      }
      drain();
    },
    snapshot() {
      const globalCapacity = controller.capacity();
      const ownerCapacities = [...providerControllers.values()].map(
        (owner) => owner.capacity()
      );
      return {
        active,
        waiting: queue.size(),
        capacity: ownerCapacities.length === 0
          ? globalCapacity
          : Math.min(globalCapacity, Math.max(...ownerCapacities)),
        globalCapacity,
        configuredMaximum: controller.configuredMaximum(),
        pressure: lastPressure,
        owners: Object.fromEntries([...providerControllers].map(([ownerKey, owner]) => [
          ownerKey,
          { active: ownerActive(ownerKey), capacity: owner.capacity() }
        ]))
      };
    }
  };

  function ownerController(ownerKey: string) {
    let owner = providerControllers.get(ownerKey);
    if (!owner) {
      owner = createAdaptiveResourceController({
        configuredMaximum: controller.configuredMaximum(),
        initialCapacity: Math.min(
          controller.configuredMaximum(), INITIAL_PROVIDER_CAPACITY
        )
      });
      providerControllers.set(ownerKey, owner);
    }
    return owner;
  }

  function ownerActive(ownerKey: string): number {
    return activeByOwner.get(ownerKey) ?? 0;
  }
}

function pressureSnapshot(observation: AdaptiveResourceObservation) {
  return {
    cpuPressure: observation.cpuPressure,
    memoryPressure: observation.memoryPressure,
    pressureSource: observation.pressureSource ?? null
  };
}

function generationRunnerError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Generation runner error: ${code}`), { code });
}

function adaptiveOutcome(
  error: unknown
): "success" | "failure" | "rate_limited" | "timeout" {
  if (error === undefined) return "success";
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : error instanceof Error ? error.message : String(error);
  if (/(?:RATE_LIMIT|THROTTL|TOO_MANY_REQUESTS|HTTP_?429)/iu.test(code)) {
    return "rate_limited";
  }
  if (/(?:TIMEOUT|TIMED_OUT|DEADLINE)/iu.test(code)) return "timeout";
  return "failure";
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error("Generation wait was aborted"), { name: "AbortError" });
}

function elapsed(startedAt: number, endedAt: number): number {
  const value = Math.round(endedAt - startedAt);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("GENERATION_METRIC_CLOCK_INVALID");
  }
  return value;
}
