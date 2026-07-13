import type { RedisCoordinator } from "./redis/coordination.js";

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
  redis: RedisCoordinator;
  scope: string;
  cacheId: string;
  invalidationScopes?: string[];
}): Promise<T | null> {
  const invalidationScopes = [...new Set([input.scope, ...(input.invalidationScopes ?? [])])];
  for (const scope of invalidationScopes) {
    if (await input.redis.getPaginationInvalid(scope)) {
      return null;
    }
  }

  return input.redis.getPageCache<T>(input.scope, input.cacheId);
}

export async function writePageResponseCache<T>(input: {
  redis: RedisCoordinator;
  scope: string;
  cacheId: string;
  value: T;
  refreshAfterMs?: number | null;
  ttlSeconds?: number | null;
}): Promise<void> {
  const ttlSeconds = input.ttlSeconds ?? resolvePageResponseCacheTtlSeconds(input.refreshAfterMs ?? null);
  await input.redis.setPageCache(input.scope, input.cacheId, input.value, ttlSeconds);
}

function resolvePageResponseCacheTtlSeconds(refreshAfterMs: number | null): number {
  if (refreshAfterMs && refreshAfterMs <= 2_000) {
    return 1;
  }

  return 5;
}
