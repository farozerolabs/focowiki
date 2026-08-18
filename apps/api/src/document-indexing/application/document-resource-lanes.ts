import {
  createAdaptiveResourceController,
  type AdaptiveResourceObservation
} from "./adaptive-resource-controller.js";
import {
  DOCUMENT_RESOURCE_LANES,
  type DocumentResourceLane
} from "./document-fixed-dag-scheduler.js";
import { readProcessResourcePressure } from "./process-resource-pressure.js";

type LaneWaiter = {
  resolve(release: () => void): void;
  reject(error: unknown): void;
  signal: AbortSignal | undefined;
  abort: (() => void) | null;
};

export function createDocumentResourceLanes(input: {
  capacities: Record<DocumentResourceLane, number>;
  maximumWaitersPerLane: number;
  clockMs?: () => number;
  pressure?: () => { cpuPressure: number; memoryPressure: number };
}) {
  if (!Number.isSafeInteger(input.maximumWaitersPerLane)
    || input.maximumWaitersPerLane < 0
    || input.maximumWaitersPerLane > 100_000) {
    throw new Error("DOCUMENT_RESOURCE_WAITER_LIMIT_INVALID");
  }
  const lanes = Object.fromEntries(DOCUMENT_RESOURCE_LANES.map((kind) => {
    const configuredCapacity = input.capacities[kind];
    if (!Number.isSafeInteger(configuredCapacity)
      || configuredCapacity < 1
      || configuredCapacity > 1_000) {
      throw new Error(`DOCUMENT_RESOURCE_CAPACITY_INVALID:${kind}`);
    }
    return [kind, {
      active: 0,
      waiters: [] as LaneWaiter[],
      controller: createAdaptiveResourceController({
        configuredMaximum: configuredCapacity
      })
    }];
  })) as Record<DocumentResourceLane, {
    active: number;
    waiters: LaneWaiter[];
    controller: ReturnType<typeof createAdaptiveResourceController>;
  }>;

  async function acquire(
    kind: DocumentResourceLane,
    signal?: AbortSignal
  ): Promise<() => void> {
    if (signal?.aborted) throw abortError();
    const lane = lanes[kind];
    if (lane.active < lane.controller.capacity()) {
      lane.active += 1;
      return releaseOnce(kind);
    }
    if (lane.waiters.length >= input.maximumWaitersPerLane) {
      throw new Error(`DOCUMENT_RESOURCE_WAITER_LIMIT_EXCEEDED:${kind}`);
    }
    return new Promise((resolve, reject) => {
      const waiter: LaneWaiter = { resolve, reject, signal, abort: null };
      if (signal) {
        waiter.abort = () => {
          const index = lane.waiters.indexOf(waiter);
          if (index >= 0) lane.waiters.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      lane.waiters.push(waiter);
    });
  }

  function tryAcquire(kind: DocumentResourceLane): (() => void) | null {
    const lane = lanes[kind];
    if (lane.active >= lane.controller.capacity()) return null;
    lane.active += 1;
    return releaseOnce(kind);
  }

  function releaseOnce(kind: DocumentResourceLane): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const lane = lanes[kind];
      lane.active -= 1;
      if (lane.active < 0) throw new Error("DOCUMENT_RESOURCE_PERMIT_UNDERFLOW");
      drain(kind);
    };
  }

  function drain(kind: DocumentResourceLane): void {
    const lane = lanes[kind];
    while (
      lane.active < lane.controller.capacity()
      && lane.waiters.length > 0
    ) {
      const waiter = lane.waiters.shift()!;
      if (waiter.abort && waiter.signal) {
        waiter.signal.removeEventListener("abort", waiter.abort);
      }
      if (waiter.signal?.aborted) {
        waiter.reject(abortError());
        continue;
      }
      lane.active += 1;
      waiter.resolve(releaseOnce(kind));
    }
  }

  return {
    acquire,
    tryAcquire,
    async run<TResult>(
      kind: DocumentResourceLane,
      operation: () => Promise<TResult>,
      signal?: AbortSignal
    ): Promise<TResult> {
      const release = await acquire(kind, signal);
      const startedAt = (input.clockMs ?? Date.now)();
      let error: unknown;
      try {
        return await operation();
      } catch (caught) {
        error = caught;
        throw caught;
      } finally {
        const endedAt = (input.clockMs ?? Date.now)();
        lanes[kind].controller.observe({
          outcome: adaptiveOutcome(error),
          latencyMs: elapsed(startedAt, endedAt),
          ...(input.pressure ?? readProcessResourcePressure)()
        });
        release();
      }
    },
    observe(kind: DocumentResourceLane, observation: AdaptiveResourceObservation): number {
      const capacity = lanes[kind].controller.observe(observation);
      drain(kind);
      return capacity;
    },
    snapshot() {
      return Object.fromEntries(DOCUMENT_RESOURCE_LANES.map((kind) => [kind, {
        active: lanes[kind].active,
        waiting: lanes[kind].waiters.length,
        capacity: lanes[kind].controller.capacity(),
        configuredMaximum: input.capacities[kind]
      }])) as Record<DocumentResourceLane, {
        active: number;
        waiting: number;
        capacity: number;
        configuredMaximum: number;
      }>;
    }
  };
}

function adaptiveOutcome(
  error: unknown
): AdaptiveResourceObservation["outcome"] {
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

function elapsed(startedAt: number, endedAt: number): number {
  const value = Math.round(endedAt - startedAt);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("DOCUMENT_RESOURCE_METRIC_CLOCK_INVALID");
  }
  return value;
}

function abortError(): Error {
  return Object.assign(new Error("Document resource wait was aborted"), {
    name: "AbortError"
  });
}
