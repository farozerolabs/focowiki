export const DOCUMENT_RESOURCE_KINDS = [
  "s3_read",
  "generation_model",
  "embedding",
  "database_mutation",
  "generated_object_write",
  "search_provider"
] as const;

export type DocumentResourceKind = (typeof DOCUMENT_RESOURCE_KINDS)[number];

type PermitSnapshot = {
  active: number;
  waiting: number;
  capacity: number;
};

export type DocumentResourceMetric = {
  resource: DocumentResourceKind;
  waitTimeMs: number;
  serviceTimeMs: number;
  outcome: "success" | "failure";
};

type Waiter = {
  resolve(release: () => void): void;
  reject(error: unknown): void;
  signal: AbortSignal | undefined;
  abort: (() => void) | null;
};

export function createDocumentResourcePermits(input: {
  capacities: Record<DocumentResourceKind, number>;
  maximumWaitersPerResource: number;
  clockMs?: () => number;
  onMetric?(metric: DocumentResourceMetric): void;
}) {
  assertConfiguration(input);
  const clockMs = input.clockMs ?? (() => Date.now());
  const resources = Object.fromEntries(DOCUMENT_RESOURCE_KINDS.map((kind) => [kind, {
    capacity: input.capacities[kind],
    active: 0,
    waiters: [] as Waiter[]
  }])) as Record<DocumentResourceKind, {
    capacity: number;
    active: number;
    waiters: Waiter[];
  }>;

  async function acquire(
    kind: DocumentResourceKind,
    signal?: AbortSignal
  ): Promise<() => void> {
    const resource = resources[kind];
    if (!resource) throw new Error("Document resource kind is invalid");
    if (signal?.aborted) throw abortError();
    if (resource.active < resource.capacity) {
      resource.active += 1;
      return releaseOnce(kind);
    }
    if (resource.waiters.length >= input.maximumWaitersPerResource) {
      throw new Error(`Document resource waiter limit exceeded: ${kind}`);
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, abort: null };
      if (signal) {
        waiter.abort = () => {
          const index = resource.waiters.indexOf(waiter);
          if (index >= 0) resource.waiters.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      resource.waiters.push(waiter);
    });
  }

  function releaseOnce(kind: DocumentResourceKind): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release(kind);
    };
  }

  function release(kind: DocumentResourceKind): void {
    const resource = resources[kind];
    resource.active -= 1;
    if (resource.active < 0) throw new Error("Document resource permit underflow");
    while (resource.waiters.length > 0) {
      const waiter = resource.waiters.shift()!;
      if (waiter.abort && waiter.signal) {
        waiter.signal.removeEventListener("abort", waiter.abort);
      }
      if (waiter.signal?.aborted) {
        waiter.reject(abortError());
        continue;
      }
      resource.active += 1;
      waiter.resolve(releaseOnce(kind));
      break;
    }
  }

  return {
    async run<TResult>(
      kind: DocumentResourceKind,
      operation: () => Promise<TResult>,
      options: {
        signal?: AbortSignal;
        onMetric?(metric: DocumentResourceMetric): void;
      } = {}
    ): Promise<TResult> {
      const waitingStartedAt = clockMs();
      const releasePermit = await acquire(kind, options.signal);
      const serviceStartedAt = clockMs();
      let outcome: "success" | "failure" = "success";
      try {
        if (options.signal?.aborted) throw abortError();
        return await operation();
      } catch (error) {
        outcome = "failure";
        throw error;
      } finally {
        const finishedAt = clockMs();
        releasePermit();
        const metric = {
          resource: kind,
          waitTimeMs: elapsed(waitingStartedAt, serviceStartedAt),
          serviceTimeMs: elapsed(serviceStartedAt, finishedAt),
          outcome
        };
        input.onMetric?.(metric);
        options.onMetric?.(metric);
      }
    },
    snapshot(): Record<DocumentResourceKind, PermitSnapshot> {
      return Object.fromEntries(DOCUMENT_RESOURCE_KINDS.map((kind) => [kind, {
        active: resources[kind].active,
        waiting: resources[kind].waiters.length,
        capacity: resources[kind].capacity
      }])) as Record<DocumentResourceKind, PermitSnapshot>;
    }
  };
}

function assertConfiguration(input: {
  capacities: Record<DocumentResourceKind, number>;
  maximumWaitersPerResource: number;
}): void {
  for (const kind of DOCUMENT_RESOURCE_KINDS) {
    const value = input.capacities[kind];
    if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
      throw new Error(`Document resource capacity is invalid: ${kind}`);
    }
  }
  if (!Number.isSafeInteger(input.maximumWaitersPerResource)
    || input.maximumWaitersPerResource < 0
    || input.maximumWaitersPerResource > 100_000) {
    throw new Error("Document resource waiter limit is invalid");
  }
}

function abortError(): Error {
  return Object.assign(new Error("Document resource wait was aborted"), {
    name: "AbortError"
  });
}

function elapsed(startedAt: number, finishedAt: number): number {
  const value = Math.round(finishedAt - startedAt);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Document resource metric clock is invalid");
  }
  return value;
}
