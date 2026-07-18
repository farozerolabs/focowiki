import { describe, expect, it } from "vitest";
import {
  readPageResponseCache,
  readThroughPageResponseCache
} from "../src/page-response-cache.js";
import type { RedisCoordinator } from "../src/redis/coordination.js";

describe("page response cache", () => {
  it("coalesces concurrent cache misses through a distributed lease", async () => {
    const fixture = createRedisFixture();
    let loadCount = 0;
    const load = async () => {
      loadCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { items: ["result"] };
    };

    const values = await Promise.all([
      readThrough(fixture.redis, load),
      readThrough(fixture.redis, load),
      readThrough(fixture.redis, load)
    ]);

    expect(values).toEqual([
      { items: ["result"] },
      { items: ["result"] },
      { items: ["result"] }
    ]);
    expect(loadCount).toBe(1);
  });

  it("uses a shorter TTL for a negative result", async () => {
    const fixture = createRedisFixture();

    await readThroughPageResponseCache({
      redis: fixture.redis,
      scope: "search:generation-1",
      cacheId: "query=missing",
      load: async () => ({ items: [] as string[] }),
      ttlSeconds: 60,
      negativeTtlSeconds: 3,
      isNegative: (value) => value.items.length === 0
    });

    expect(fixture.writes).toEqual([3]);
  });

  it("falls back to the bounded loader when Redis is unavailable", async () => {
    const fixture = createRedisFixture({ failReads: true });

    const cached = await readPageResponseCache<{ items: string[] }>({
      redis: fixture.redis,
      scope: "search:generation-1",
      cacheId: "query=guide"
    });
    const loaded = await readThroughPageResponseCache({
      redis: fixture.redis,
      scope: "search:generation-1",
      cacheId: "query=guide",
      load: async () => ({ items: ["database-result"] }),
      ttlSeconds: 60,
      negativeTtlSeconds: 3,
      isNegative: (value) => value.items.length === 0
    });

    expect(cached).toBeNull();
    expect(loaded).toEqual({ items: ["database-result"] });
  });

  it("loads directly from the bounded repository when Redis is not configured", async () => {
    const loaded = await readThroughPageResponseCache({
      redis: null,
      scope: "search:generation-1",
      cacheId: "query=guide",
      load: async () => ({ items: ["database-result"] }),
      ttlSeconds: 60,
      negativeTtlSeconds: 3,
      isNegative: (value) => value.items.length === 0
    });

    expect(loaded).toEqual({ items: ["database-result"] });
  });
});

function readThrough(
  redis: RedisCoordinator,
  load: () => Promise<{ items: string[] }>
) {
  return readThroughPageResponseCache({
    redis,
    scope: "search:generation-1",
    cacheId: "query=guide",
    load,
    ttlSeconds: 60,
    negativeTtlSeconds: 3,
    isNegative: (value) => value.items.length === 0,
    waitAttempts: 10,
    waitMs: 5
  });
}

function createRedisFixture(options: { failReads?: boolean } = {}) {
  const cache = new Map<string, unknown>();
  const locks = new Map<string, string>();
  const writes: number[] = [];
  const redis = {
    async getPaginationInvalid() {
      if (options.failReads) throw new Error("redis unavailable");
      return null;
    },
    async getPageCache<T>(_scope: string, pageId: string) {
      if (options.failReads) throw new Error("redis unavailable");
      return (cache.get(pageId) as T | undefined) ?? null;
    },
    async setPageCache(_scope: string, pageId: string, value: unknown, ttlSeconds: number) {
      cache.set(pageId, value);
      writes.push(ttlSeconds);
    },
    async acquireLock(scope: string, id: string, ownerId: string) {
      if (options.failReads) throw new Error("redis unavailable");
      const key = `${scope}:${id}`;
      if (locks.has(key)) return false;
      locks.set(key, ownerId);
      return true;
    },
    async releaseLock(scope: string, id: string, ownerId: string) {
      const key = `${scope}:${id}`;
      if (locks.get(key) !== ownerId) return false;
      locks.delete(key);
      return true;
    }
  } as unknown as RedisCoordinator;

  return { redis, writes };
}
