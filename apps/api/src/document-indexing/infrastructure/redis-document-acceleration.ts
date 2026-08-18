import { randomUUID } from "node:crypto";
import type { RedisCommandClient } from "../../redis/coordination.js";

const EVALUATION_CACHE_VERSION = "document-evaluation-v1";

export type DocumentRedisAcceleration = ReturnType<
  typeof createDocumentRedisAcceleration
>;

export function createDocumentRedisAcceleration(input: {
  client: RedisCommandClient;
  buildKey: (...parts: string[]) => string;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}) {
  const localEvaluations = new Map<string, Promise<unknown>>();
  const wait = input.wait ?? waitFor;
  return {
    async markEvaluationDurable(request: {
      fingerprint: string;
      ttlSeconds: number;
    }): Promise<void> {
      try {
        await input.client.set(input.buildKey(
          "document-evaluations",
          request.fingerprint
        ), JSON.stringify({
          version: EVALUATION_CACHE_VERSION,
          fingerprint: request.fingerprint
        }), { EX: request.ttlSeconds });
      } catch {
        reportRedisAccelerationWarning("document_evaluation.cache_write_failed");
      }
    },
    async runEvaluationSingleflight<T>(request: {
      fingerprint: string;
      lockTtlSeconds: number;
      signal: AbortSignal;
      readDurable(): Promise<T | null>;
      evaluate(): Promise<T>;
    }): Promise<T> {
      const existing = localEvaluations.get(request.fingerprint) as
        Promise<T> | undefined;
      if (existing) return existing;
      const promise = runDistributedSingleflight({ ...request, input, wait });
      localEvaluations.set(request.fingerprint, promise);
      try {
        return await promise;
      } finally {
        if (localEvaluations.get(request.fingerprint) === promise) {
          localEvaluations.delete(request.fingerprint);
        }
      }
    }
  };
}

async function runDistributedSingleflight<T>(request: {
  fingerprint: string;
  lockTtlSeconds: number;
  signal: AbortSignal;
  readDurable(): Promise<T | null>;
  evaluate(): Promise<T>;
  input: {
    client: RedisCommandClient;
    buildKey: (...parts: string[]) => string;
  };
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}): Promise<T> {
  const durable = await request.readDurable();
  if (durable !== null) return durable;
  const owner = randomUUID();
  const key = request.input.buildKey(
    "document-evaluation-singleflight",
    request.fingerprint
  );
  let acquired = false;
  try {
    acquired = await request.input.client.set(key, owner, {
      EX: request.lockTtlSeconds,
      NX: true
    }) === "OK";
  } catch {
    return request.evaluate();
  }
  if (!acquired) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await request.wait(25, request.signal);
      const completed = await request.readDurable();
      if (completed !== null) return completed;
    }
    return request.evaluate();
  }
  try {
    return await request.evaluate();
  } finally {
    try {
      await releaseOwnedLock(request.input.client, key, owner);
    } catch {
      reportRedisAccelerationWarning(
        "document_evaluation.lock_cleanup_failed",
        { release: "ttl" }
      );
    }
  }
}

async function releaseOwnedLock(
  client: RedisCommandClient,
  key: string,
  owner: string
): Promise<void> {
  await client.eval(`
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    end
    return 0
  `, { keys: [key], arguments: [owner] });
}

function reportRedisAccelerationWarning(
  event: string,
  fields: Readonly<Record<string, string>> = {}
): void {
  console.warn(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "warn",
    event,
    stream: "worker",
    fields
  }));
}

function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    signal.addEventListener("abort", abort, { once: true });
    function finish(): void {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timer);
      reject(signal.reason);
    }
  });
}
