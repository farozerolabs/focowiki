import {
  createAdaptiveResourceController,
  type AdaptiveResourceObservation
} from "./adaptive-resource-controller.js";
import {
  createWeightedGenerationQueue,
  type GenerationWorkClass
} from "./weighted-generation-queue.js";
import { readProcessResourcePressure } from "./process-resource-pressure.js";

export type GenerationTaskMetric = {
  workClass: GenerationWorkClass;
  waitTimeMs: number;
  serviceTimeMs: number;
  outcome: "success" | "failure";
};

type QueuedTask = {
  workClass: GenerationWorkClass;
  operation(): Promise<unknown>;
  signal: AbortSignal | undefined;
  enqueuedAt: number;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  onMetric: ((metric: GenerationTaskMetric) => void) | undefined;
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
  const queue = createWeightedGenerationQueue<QueuedTask>({
    weights: input.weights
  });
  let active = 0;

  function drain(): void {
    while (active < controller.capacity()) {
      const next = queue.dequeue();
      if (!next) return;
      if (next.item.signal?.aborted) {
        next.item.reject(abortError(next.item.signal));
        continue;
      }
      active += 1;
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
        const metric = {
          workClass: taskWorkClass,
          waitTimeMs: elapsed(item.enqueuedAt, serviceStartedAt),
          serviceTimeMs: elapsed(serviceStartedAt, finishedAt),
          outcome
        };
        controller.observe({
          outcome: adaptiveOutcome(failure),
          latencyMs: metric.serviceTimeMs,
          ...pressure()
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
        onMetric?(metric: GenerationTaskMetric): void;
      } = {}
    ): Promise<TResult> {
      if (options.signal?.aborted) {
        return Promise.reject(abortError(options.signal));
      }
      if (queue.size() >= input.maximumWaiters) {
        return Promise.reject(generationRunnerError(
          "GENERATION_WAITER_LIMIT_EXCEEDED"
        ));
      }
      return new Promise<TResult>((resolve, reject) => {
        queue.enqueue(workClass, {
          workClass,
          operation,
          signal: options.signal,
          enqueuedAt: clockMs(),
          resolve: (value) => resolve(value as TResult),
          reject,
          onMetric: options.onMetric
        });
        drain();
      });
    },
    observe(observation: AdaptiveResourceObservation): number {
      const capacity = controller.observe(observation);
      drain();
      return capacity;
    },
    snapshot() {
      return {
        active,
        waiting: queue.size(),
        capacity: controller.capacity(),
        configuredMaximum: input.configuredMaximum
      };
    }
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
