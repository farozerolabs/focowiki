import { describe, expect, it } from "vitest";
import {
  GRAPHRAG_REQUEST_SCHEMA,
  GRAPHRAG_RESPONSE_SCHEMA,
  type GraphRagAdapterRequest,
  type GraphRagAdapterResponse
} from "../src/semantic/graphrag/contracts.js";
import { createGraphRagPythonPool } from "../src/semantic/graphrag/python-pool.js";
import type { GraphRagPythonProcess } from "../src/semantic/graphrag/python-process.js";

type Pending = {
  request: GraphRagAdapterRequest;
  resolve(value: GraphRagAdapterResponse): void;
  reject(error: Error): void;
};

function createHarness(options: { autoResolve?: boolean } = {}) {
  const children: Array<{ terminated: boolean; pending: Pending[]; process: GraphRagPythonProcess }> = [];
  let nextPid = 100;
  return {
    children,
    createChild() {
      const state = { terminated: false, pending: [] as Pending[], process: null as unknown as GraphRagPythonProcess };
      const process: GraphRagPythonProcess = {
        pid: nextPid++,
        request(request) {
          if (request.operation === "health" || options.autoResolve) {
            return Promise.resolve(success(request.requestId));
          }
          return new Promise((resolve, reject) => state.pending.push({ request, resolve, reject }));
        },
        terminate() {
          state.terminated = true;
          for (const item of state.pending.splice(0)) item.reject(new Error("terminated"));
        }
      };
      state.process = process;
      children.push(state);
      return process;
    }
  };
}

describe("GraphRAG Python pool", () => {
  it("keeps a fixed warm pool and enforces its backlog bound", async () => {
    const harness = createHarness();
    const pool = createGraphRagPythonPool({
      size: 1,
      maximumBacklog: 1,
      maximumTasksPerChild: 10,
      createChild: harness.createChild
    });
    await pool.start();
    const first = pool.run(request("first"), { timeoutMs: 1_000 });
    const second = pool.run(request("second"), { timeoutMs: 1_000 });
    await expect(pool.run(request("third"), { timeoutMs: 1_000 })).rejects.toMatchObject({ code: "ADAPTER_BACKLOG_FULL" });
    harness.children[0]!.pending.shift()!.resolve(success("first"));
    await first;
    harness.children[0]!.pending.shift()!.resolve(success("second"));
    await second;
    expect(pool.stats()).toMatchObject({ size: 1, busy: 0, queued: 0 });
    await pool.close();
  });

  it("recycles one child after its task limit without stopping other capacity", async () => {
    const harness = createHarness({ autoResolve: true });
    const pool = createGraphRagPythonPool({
      size: 2,
      maximumBacklog: 2,
      maximumTasksPerChild: 1,
      createChild: harness.createChild
    });
    await pool.start();
    await pool.run(request("work"), { timeoutMs: 1_000 });
    expect(harness.children.filter((child) => child.terminated)).toHaveLength(1);
    expect(pool.stats()).toMatchObject({ size: 2, restarts: 1 });
    await pool.close();
  });

  it("terminates and replaces only the affected child on timeout or cancellation", async () => {
    const harness = createHarness();
    const pool = createGraphRagPythonPool({
      size: 2,
      maximumBacklog: 2,
      maximumTasksPerChild: 10,
      createChild: harness.createChild
    });
    await pool.start();
    await expect(pool.run(request("timeout"), { timeoutMs: 5 })).rejects.toMatchObject({ code: "ADAPTER_TIMEOUT" });
    expect(harness.children.filter((child) => child.terminated)).toHaveLength(1);
    expect(pool.stats().size).toBe(2);

    const controller = new AbortController();
    const cancelled = pool.run(request("cancelled"), { timeoutMs: 1_000, signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "ADAPTER_CANCELLED" });
    expect(pool.stats().restarts).toBe(2);
    await pool.close();
  });

  it("returns safe crash errors and cleans queued and live children on shutdown", async () => {
    const harness = createHarness();
    const pool = createGraphRagPythonPool({
      size: 1,
      maximumBacklog: 2,
      maximumTasksPerChild: 10,
      createChild: harness.createChild
    });
    await pool.start();
    const live = pool.run({ ...request("crash"), apiKey: "secret-value" }, { timeoutMs: 1_000 });
    const queued = pool.run(request("queued"), { timeoutMs: 1_000 });
    harness.children[0]!.pending.shift()!.reject(new Error("secret-value"));
    await expect(live).rejects.not.toThrow("secret-value");
    await pool.close();
    await expect(queued).rejects.toMatchObject({ code: "ADAPTER_POOL_CLOSED" });
    expect(harness.children.every((child) => child.terminated)).toBe(true);
  });

  it("waits for every child to exit before shutdown completes", async () => {
    let finishTermination: (() => void) | undefined;
    const pool = createGraphRagPythonPool({
      size: 1,
      maximumBacklog: 1,
      maximumTasksPerChild: 10,
      createChild: () => ({
        pid: 101,
        request: async (value) => success(value.requestId),
        terminate: () => new Promise<void>((resolve) => {
          finishTermination = resolve;
        })
      })
    });
    await pool.start();
    let closed = false;
    const closing = pool.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finishTermination?.();
    await closing;
    expect(closed).toBe(true);
  });

  it("runs repeated work through bounded warm children and leaves no live child", async () => {
    const harness = createHarness({ autoResolve: true });
    const pool = createGraphRagPythonPool({
      size: 2,
      maximumBacklog: 16,
      maximumTasksPerChild: 25,
      createChild: harness.createChild
    });
    await pool.start();
    for (let offset = 0; offset < 100; offset += 10) {
      await Promise.all(Array.from({ length: 10 }, (_, index) =>
        pool.run(request(`repeat-${offset + index}`), { timeoutMs: 1_000 })));
    }
    expect(pool.stats()).toMatchObject({ size: 2, busy: 0, queued: 0 });
    expect(harness.children.length).toBeLessThanOrEqual(6);
    await pool.close();
    expect(harness.children.every((child) => child.terminated)).toBe(true);
  });

  it("refills a recycled slot after a replacement health check fails", async () => {
    let created = 0;
    const terminated: number[] = [];
    const pool = createGraphRagPythonPool({
      size: 1,
      maximumBacklog: 2,
      maximumTasksPerChild: 1,
      refillDelayMs: 1,
      createChild() {
        const childNumber = ++created;
        return {
          pid: childNumber,
          async request(value) {
            if (value.operation === "health" && childNumber === 2) {
              throw new Error("replacement health failed");
            }
            return success(value.requestId);
          },
          terminate() {
            terminated.push(childNumber);
          }
        };
      }
    });
    await pool.start();
    await pool.run(request("recycle"), { timeoutMs: 1_000 });
    await expect(pool.run(request("after-refill"), { timeoutMs: 1_000 }))
      .resolves.toMatchObject({ ok: true });
    expect(created).toBeGreaterThanOrEqual(3);
    expect(terminated).toContain(2);
    await pool.close();
  });
});

function request(requestId: string): GraphRagAdapterRequest {
  return { schemaVersion: GRAPHRAG_REQUEST_SCHEMA, requestId, operation: "extract" };
}

function success(requestId: string): GraphRagAdapterResponse {
  return { schemaVersion: GRAPHRAG_RESPONSE_SCHEMA, requestId, ok: true, result: {} };
}
