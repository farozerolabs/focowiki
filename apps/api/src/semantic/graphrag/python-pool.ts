import { randomUUID } from "node:crypto";
import {
  GRAPHRAG_REQUEST_SCHEMA,
  GraphRagAdapterError,
  type GraphRagAdapterRequest,
  type GraphRagAdapterResponse
} from "./contracts.js";
import type { GraphRagPythonProcess } from "./python-process.js";

type PendingWork = {
  request: GraphRagAdapterRequest;
  timeoutMs: number;
  signal?: AbortSignal;
  resolve(value: GraphRagAdapterResponse): void;
  reject(error: Error): void;
};

type Slot = {
  child: GraphRagPythonProcess;
  busy: boolean;
  ready: boolean;
  completed: number;
  cancelCurrent?: (error: Error) => void;
};

export type GraphRagPythonPool = {
  start(): Promise<void>;
  run(request: GraphRagAdapterRequest, options: { timeoutMs: number; signal?: AbortSignal }): Promise<GraphRagAdapterResponse>;
  close(): Promise<void>;
  stats(): { size: number; busy: number; queued: number; restarts: number };
};

export function createGraphRagPythonPool(input: {
  size: number;
  maximumBacklog: number;
  maximumTasksPerChild: number;
  refillDelayMs?: number;
  createChild(): GraphRagPythonProcess;
}): GraphRagPythonPool {
  requirePositive(input.size, "size");
  requirePositive(input.maximumBacklog, "maximumBacklog");
  requirePositive(input.maximumTasksPerChild, "maximumTasksPerChild");
  const refillDelayMs = input.refillDelayMs ?? 100;
  if (!Number.isSafeInteger(refillDelayMs) || refillDelayMs < 0) {
    throw new GraphRagAdapterError(
      "INVALID_POOL_LIMIT",
      "refillDelayMs must be a non-negative integer"
    );
  }
  const slots: Slot[] = [];
  const queue: PendingWork[] = [];
  const refillTimers = new Set<ReturnType<typeof setTimeout>>();
  const childTerminations = new Set<Promise<void>>();
  let closed = false;
  let restarts = 0;

  function healthRequest(): GraphRagAdapterRequest {
    return {
      schemaVersion: GRAPHRAG_REQUEST_SCHEMA,
      requestId: `health-${randomUUID()}`,
      operation: "health"
    };
  }

  function replace(slot: Slot): void {
    void terminateChild(slot.child);
    slot.completed = 0;
    slot.ready = false;
    slot.busy = false;
    restarts += 1;
    refill(slot);
  }

  function terminateChild(child: GraphRagPythonProcess): Promise<void> {
    const pending = Promise.resolve(child.terminate()).catch(() => undefined);
    childTerminations.add(pending);
    void pending.finally(() => childTerminations.delete(pending));
    return pending;
  }

  function refill(slot: Slot): void {
    if (closed) return;
    try {
      slot.child = input.createChild();
    } catch {
      scheduleRefill(slot);
      return;
    }
    void slot.child.request(healthRequest()).then((response) => {
      if (closed) {
        void terminateChild(slot.child);
        return;
      }
      if (!response.ok) {
        void terminateChild(slot.child);
        scheduleRefill(slot);
        return;
      }
      slot.ready = true;
      dispatch();
    }).catch(() => {
      void terminateChild(slot.child);
      scheduleRefill(slot);
    });
  }

  function scheduleRefill(slot: Slot): void {
    if (closed) return;
    const timer = setTimeout(() => {
      refillTimers.delete(timer);
      refill(slot);
    }, refillDelayMs);
    timer.unref?.();
    refillTimers.add(timer);
  }

  function dispatch(): void {
    if (closed) return;
    for (const slot of slots) {
      if (slot.busy || !slot.ready) continue;
      let work = queue.shift();
      while (work?.signal?.aborted) {
        work.reject(abortedError());
        work = queue.shift();
      }
      if (!work) break;
      slot.busy = true;
      void execute(slot, work);
    }
  }

  async function execute(slot: Slot, work: PendingWork): Promise<void> {
    let settled = false;
    const finish = (error?: Error, value?: GraphRagAdapterResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      work.signal?.removeEventListener("abort", onAbort);
      slot.busy = false;
      delete slot.cancelCurrent;
      if (error) work.reject(error);
      else work.resolve(value as GraphRagAdapterResponse);
      dispatch();
    };
    const recycle = (error: Error): void => {
      replace(slot);
      finish(error);
    };
    const onAbort = () => recycle(abortedError());
    const timer = setTimeout(
      () => recycle(new GraphRagAdapterError("ADAPTER_TIMEOUT", "Adapter request exceeded its deadline")),
      work.timeoutMs
    );
    timer.unref?.();
    work.signal?.addEventListener("abort", onAbort, { once: true });
    slot.cancelCurrent = (error) => finish(error);
    try {
      const response = await slot.child.request(work.request);
      if (settled) return;
      slot.completed += 1;
      if (slot.completed >= input.maximumTasksPerChild) replace(slot);
      finish(undefined, response);
    } catch {
      if (!settled) recycle(new GraphRagAdapterError("ADAPTER_PROCESS_FAILED", "Adapter process failed"));
    }
  }

  return {
    async start() {
      if (closed) throw new GraphRagAdapterError("ADAPTER_POOL_CLOSED", "Adapter pool is closed");
      if (slots.length > 0) return;
      for (let index = 0; index < input.size; index += 1) {
        slots.push({ child: input.createChild(), busy: false, ready: false, completed: 0 });
      }
      let health: GraphRagAdapterResponse[];
      try {
        health = await Promise.all(slots.map((slot) => slot.child.request(healthRequest())));
      } catch {
        await this.close();
        throw new GraphRagAdapterError("ADAPTER_HEALTH_FAILED", "Adapter compatibility health check failed");
      }
      if (health.some((response) => !response.ok)) {
        await this.close();
        throw new GraphRagAdapterError("ADAPTER_HEALTH_FAILED", "Adapter compatibility health check failed");
      }
      for (const slot of slots) slot.ready = true;
    },
    run(request, options) {
      if (closed) return Promise.reject(new GraphRagAdapterError("ADAPTER_POOL_CLOSED", "Adapter pool is closed"));
      if (slots.length === 0) return Promise.reject(new GraphRagAdapterError("ADAPTER_POOL_NOT_STARTED", "Adapter pool has not started"));
      if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
        return Promise.reject(new GraphRagAdapterError("INVALID_ADAPTER_TIMEOUT", "Adapter timeout must be positive"));
      }
      if (queue.length >= input.maximumBacklog) {
        return Promise.reject(new GraphRagAdapterError("ADAPTER_BACKLOG_FULL", "Adapter backlog is full"));
      }
      return new Promise((resolve, reject) => {
        queue.push({
          request,
          timeoutMs: options.timeoutMs,
          ...(options.signal ? { signal: options.signal } : {}),
          resolve,
          reject
        });
        dispatch();
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const timer of refillTimers) clearTimeout(timer);
      refillTimers.clear();
      for (const work of queue.splice(0)) {
        work.reject(new GraphRagAdapterError("ADAPTER_POOL_CLOSED", "Adapter pool is closed"));
      }
      const terminating = [...childTerminations];
      for (const slot of slots) {
        slot.cancelCurrent?.(
          new GraphRagAdapterError("ADAPTER_POOL_CLOSED", "Adapter pool is closed")
        );
        terminating.push(terminateChild(slot.child));
      }
      slots.length = 0;
      await Promise.all(terminating);
    },
    stats() {
      return {
        size: slots.length,
        busy: slots.filter((slot) => slot.busy || !slot.ready).length,
        queued: queue.length,
        restarts
      };
    }
  };
}

function requirePositive(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new GraphRagAdapterError("INVALID_POOL_LIMIT", `${field} must be a positive integer`);
  }
}

function abortedError(): GraphRagAdapterError {
  return new GraphRagAdapterError("ADAPTER_CANCELLED", "Adapter request was cancelled");
}
