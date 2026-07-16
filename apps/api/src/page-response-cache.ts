import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { RedisCoordinator } from "./redis/coordination.js";

const DEFAULT_CACHE_MISS_LEASE_SECONDS = 3;
const DEFAULT_CACHE_WAIT_ATTEMPTS = 8;
const DEFAULT_CACHE_WAIT_MS = 25;

export function createPageResponseCacheId(input: {
  cursorToken: string | null;
  limit: number;
  extra?: string | null;
}): string {
  return [
    `cursor=${input.cursorToken ?? "root"}`,
    `limit=${input.limit}`,
    input.extra ? `extra=${input.extra}` : null
  ]
    .filter(Boolean)
    .join(":");
}

export async function readPageResponseCache<T>(input: {
  redis: RedisCoordinator | null;
  scope: string;
  cacheId: string;
  invalidationScopes?: string[];
}): Promise<T | null> {
  if (!input.redis) {
    return null;
  }

  try {
    const invalidationScopes = [...new Set([input.scope, ...(input.invalidationScopes ?? [])])];
    for (const scope of invalidationScopes) {
      if (await input.redis.getPaginationInvalid(scope)) {
        return null;
      }
    }

    return input.redis.getPageCache<T>(input.scope, input.cacheId);
  } catch {
    return null;
  }
}

export async function writePageResponseCache<T>(input: {
  redis: RedisCoordinator | null;
  scope: string;
  cacheId: string;
  value: T;
  refreshAfterMs?: number | null;
  ttlSeconds?: number | null;
}): Promise<void> {
  if (!input.redis) {
    return;
  }

  const ttlSeconds = input.ttlSeconds ?? resolvePageResponseCacheTtlSeconds(input.refreshAfterMs ?? null);
  try {
    await input.redis.setPageCache(input.scope, input.cacheId, input.value, ttlSeconds);
  } catch {
    // Redis is an optimization. The bounded database query remains authoritative.
  }
}

export async function readThroughPageResponseCache<T>(input: {
  redis: RedisCoordinator | null;
  scope: string;
  cacheId: string;
  invalidationScopes?: string[];
  load: () => Promise<T>;
  ttlSeconds: number;
  negativeTtlSeconds: number;
  isNegative: (value: T) => boolean;
  leaseSeconds?: number;
  waitAttempts?: number;
  waitMs?: number;
}): Promise<T> {
  if (!input.redis) {
    return input.load();
  }

  const cached = await readPageResponseCache<T>(input);
  if (cached !== null) {
    return cached;
  }

  const ownerId = randomUUID();
  const leaseId = createHash("sha256")
    .update(`${input.scope}\u0000${input.cacheId}`)
    .digest("hex");
  let ownsLease = false;

  try {
    ownsLease = await input.redis.acquireLock(
      "page-cache-fill",
      leaseId,
      ownerId,
      input.leaseSeconds ?? DEFAULT_CACHE_MISS_LEASE_SECONDS
    );
  } catch {
    return input.load();
  }

  if (!ownsLease) {
    const waitAttempts = input.waitAttempts ?? DEFAULT_CACHE_WAIT_ATTEMPTS;
    const waitMs = input.waitMs ?? DEFAULT_CACHE_WAIT_MS;
    for (let attempt = 0; attempt < waitAttempts; attempt += 1) {
      await delay(waitMs);
      const filled = await readPageResponseCache<T>(input);
      if (filled !== null) {
        return filled;
      }
    }

    return input.load();
  }

  try {
    const value = await input.load();
    await writePageResponseCache({
      redis: input.redis,
      scope: input.scope,
      cacheId: input.cacheId,
      value,
      ttlSeconds: input.isNegative(value) ? input.negativeTtlSeconds : input.ttlSeconds
    });
    return value;
  } finally {
    await input.redis.releaseLock("page-cache-fill", leaseId, ownerId).catch(() => false);
  }
}

function resolvePageResponseCacheTtlSeconds(refreshAfterMs: number | null): number {
  if (refreshAfterMs && refreshAfterMs <= 2_000) {
    return 1;
  }

  return 5;
}
