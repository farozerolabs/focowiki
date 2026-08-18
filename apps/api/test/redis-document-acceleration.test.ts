import { describe, expect, it, vi } from "vitest";
import { createDocumentRedisAcceleration } from
  "../src/document-indexing/infrastructure/redis-document-acceleration.js";

describe("Redis document acceleration", () => {
  it("coalesces identical in-process evaluations and reads durable completion", async () => {
    const values = new Map<string, string>();
    const client = redisClient(values);
    const acceleration = createDocumentRedisAcceleration({
      client,
      buildKey: (...parts) => parts.join(":"),
      wait: async () => undefined
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const evaluate = vi.fn(async () => {
      await gate;
      return { result: "accepted" };
    });
    const request = {
      fingerprint: "evaluation-a",
      lockTtlSeconds: 30,
      signal: new AbortController().signal,
      readDurable: vi.fn(async () => null),
      evaluate
    };
    const first = acceleration.runEvaluationSingleflight(request);
    const duplicate = acceleration.runEvaluationSingleflight(request);
    release();
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { result: "accepted" }, { result: "accepted" }
    ]);
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it("falls back to authoritative work when Redis is unavailable", async () => {
    const acceleration = createDocumentRedisAcceleration({
      client: {
        set: vi.fn().mockRejectedValue(new Error("redis down")),
        get: vi.fn().mockRejectedValue(new Error("redis down")),
        del: vi.fn().mockRejectedValue(new Error("redis down")),
        eval: vi.fn().mockRejectedValue(new Error("redis down"))
      },
      buildKey: (...parts) => parts.join(":"),
      wait: async () => undefined
    });
    const evaluate = vi.fn(async () => "durable-result");
    await expect(acceleration.runEvaluationSingleflight({
      fingerprint: "evaluation-a",
      lockTtlSeconds: 30,
      signal: new AbortController().signal,
      readDurable: async () => null,
      evaluate
    })).resolves.toBe("durable-result");
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it("reports a failed distributed-lock cleanup without failing durable work", async () => {
    const values = new Map<string, string>();
    const client = {
      ...redisClient(values),
      eval: vi.fn().mockRejectedValue(new Error("redis cleanup unavailable"))
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const acceleration = createDocumentRedisAcceleration({
      client,
      buildKey: (...parts) => parts.join(":"),
      wait: async () => undefined
    });

    await expect(acceleration.runEvaluationSingleflight({
      fingerprint: "evaluation-cleanup",
      lockTtlSeconds: 30,
      signal: new AbortController().signal,
      readDurable: async () => null,
      evaluate: async () => "durable-result"
    })).resolves.toBe("durable-result");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(
      '"event":"document_evaluation.lock_cleanup_failed"'
    ));
    warning.mockRestore();
  });

  it("lets a second process reuse the first durable singleflight result", async () => {
    const values = new Map<string, string>();
    const client = redisClient(values);
    let durable: string | null = null;
    let release!: () => void;
    const completed = new Promise<void>((resolve) => { release = resolve; });
    const firstEvaluate = vi.fn(async () => {
      await completed;
      durable = "accepted";
      return durable;
    });
    const first = createDocumentRedisAcceleration({
      client,
      buildKey: (...parts) => parts.join(":"),
      wait: async () => undefined
    });
    const second = createDocumentRedisAcceleration({
      client,
      buildKey: (...parts) => parts.join(":"),
      wait: async () => {
        release();
        await Promise.resolve();
        await Promise.resolve();
      }
    });
    const shared = {
      fingerprint: "evaluation-shared",
      lockTtlSeconds: 30,
      signal: new AbortController().signal,
      readDurable: async () => durable
    };
    const owner = first.runEvaluationSingleflight({
      ...shared,
      evaluate: firstEvaluate
    });
    await Promise.resolve();
    const duplicateEvaluate = vi.fn(async () => "duplicate");
    const duplicate = second.runEvaluationSingleflight({
      ...shared,
      evaluate: duplicateEvaluate
    });

    await expect(Promise.all([owner, duplicate])).resolves.toEqual([
      "accepted", "accepted"
    ]);
    expect(firstEvaluate).toHaveBeenCalledOnce();
    expect(duplicateEvaluate).not.toHaveBeenCalled();
  });

});

function redisClient(values: Map<string, string>) {
  return {
    async set(key: string, value: string, options?: Record<string, unknown>) {
      if (options?.NX && values.has(key)) return null;
      values.set(key, value);
      return "OK";
    },
    async get(key: string) { return values.get(key) ?? null; },
    async del(key: string) { return values.delete(key) ? 1 : 0; },
    async eval(_script: string, input: { keys: string[]; arguments: string[] }) {
      if (values.get(input.keys[0]!) !== input.arguments[0]) return 0;
      values.delete(input.keys[0]!);
      return 1;
    }
  };
}
