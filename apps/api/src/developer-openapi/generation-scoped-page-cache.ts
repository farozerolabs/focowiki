import { randomUUID } from "node:crypto";
import type { RedisCoordinator } from "../redis/coordination.js";

const CACHE_FILL_LOCK_TTL_SECONDS = 5;
const CACHE_FILL_WAIT_ATTEMPTS = 10;
const CACHE_FILL_WAIT_MILLISECONDS = 10;

export async function loadGenerationScopedPage<T>(input: {
  redis: RedisCoordinator | null;
  scope: string;
  pageId: string;
  ttlSeconds: number;
  load: () => Promise<T>;
}): Promise<T> {
  if (!input.redis) return input.load();

  const cached = await readCache(input.redis, input.scope, input.pageId);
  if (cached !== null) return cached as T;

  const ownerId = randomUUID();
  const lockId = `${input.scope}:${input.pageId}`;
  const acquired = await acquireFillLock(input.redis, lockId, ownerId);
  if (!acquired) {
    const filled = await waitForCache<T>(input.redis, input.scope, input.pageId);
    if (filled !== null) return filled;
    return input.load();
  }

  try {
    const page = await input.load();
    await writeCache(input.redis, input.scope, input.pageId, page, input.ttlSeconds);
    return page;
  } finally {
    await releaseFillLock(input.redis, lockId, ownerId);
  }
}

async function readCache<T>(
  redis: RedisCoordinator,
  scope: string,
  pageId: string
): Promise<T | null> {
  try {
    return await redis.getPageCache<T>(scope, pageId);
  } catch {
    return null;
  }
}

async function writeCache<T>(
  redis: RedisCoordinator,
  scope: string,
  pageId: string,
  page: T,
  ttlSeconds: number
): Promise<void> {
  try {
    await redis.setPageCache(scope, pageId, page, ttlSeconds);
  } catch {
    // PostgreSQL remains authoritative when Redis is unavailable.
  }
}

async function acquireFillLock(
  redis: RedisCoordinator,
  lockId: string,
  ownerId: string
): Promise<boolean> {
  try {
    return await redis.acquireLock(
      "active-read-page-fill",
      lockId,
      ownerId,
      CACHE_FILL_LOCK_TTL_SECONDS
    );
  } catch {
    return false;
  }
}

async function releaseFillLock(
  redis: RedisCoordinator,
  lockId: string,
  ownerId: string
): Promise<void> {
  try {
    await redis.releaseLock("active-read-page-fill", lockId, ownerId);
  } catch {
    // The lock expires independently when Redis becomes unavailable.
  }
}

async function waitForCache<T>(
  redis: RedisCoordinator,
  scope: string,
  pageId: string
): Promise<T | null> {
  for (let attempt = 0; attempt < CACHE_FILL_WAIT_ATTEMPTS; attempt += 1) {
    await delay(CACHE_FILL_WAIT_MILLISECONDS);
    const cached = await readCache<T>(redis, scope, pageId);
    if (cached !== null) return cached;
  }
  return null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
