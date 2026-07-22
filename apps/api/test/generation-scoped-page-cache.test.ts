import { describe, expect, it, vi } from "vitest";
import { loadGenerationScopedPage } from "../src/developer-openapi/generation-scoped-page-cache.js";
import { createRedisCoordinator } from "../src/redis/coordination.js";
import { MemoryRedisCommandClient } from "./support/session.js";

describe("generation-scoped page cache", () => {
  it("serves a bounded page from Redis until the entry expires", async () => {
    const client = new MemoryRedisCommandClient();
    const redis = createRedisCoordinator(client, { keyPrefix: "page-cache-test" });
    const loader = vi.fn().mockResolvedValue({ items: ["first"] });
    const input = {
      redis,
      scope: "generation-a",
      pageId: "first-page",
      ttlSeconds: 30,
      load: loader
    };

    await expect(loadGenerationScopedPage(input)).resolves.toEqual({ items: ["first"] });
    await expect(loadGenerationScopedPage(input)).resolves.toEqual({ items: ["first"] });
    expect(loader).toHaveBeenCalledTimes(1);

    await client.del(redis.buildKey("page-cache", input.scope, input.pageId));
    await loadGenerationScopedPage(input);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("isolates cached pages by active generation", async () => {
    const redis = createRedisCoordinator(new MemoryRedisCommandClient(), {
      keyPrefix: "page-cache-generation-test"
    });
    const loader = vi.fn()
      .mockResolvedValueOnce({ generation: "a" })
      .mockResolvedValueOnce({ generation: "b" });

    await loadGenerationScopedPage({
      redis,
      scope: "generation-a",
      pageId: "same-page",
      ttlSeconds: 30,
      load: loader
    });
    await expect(loadGenerationScopedPage({
      redis,
      scope: "generation-b",
      pageId: "same-page",
      ttlSeconds: 30,
      load: loader
    })).resolves.toEqual({ generation: "b" });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("coordinates concurrent misses and fails open when Redis is unavailable", async () => {
    const redis = createRedisCoordinator(new MemoryRedisCommandClient(), {
      keyPrefix: "page-cache-lock-test"
    });
    const loader = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { items: ["shared"] };
    });
    const input = {
      redis,
      scope: "generation-a",
      pageId: "shared-page",
      ttlSeconds: 30,
      load: loader
    };

    await expect(Promise.all([
      loadGenerationScopedPage(input),
      loadGenerationScopedPage(input)
    ])).resolves.toEqual([{ items: ["shared"] }, { items: ["shared"] }]);
    expect(loader).toHaveBeenCalledTimes(1);

    const fallback = vi.fn().mockResolvedValue({ items: ["database"] });
    await expect(loadGenerationScopedPage({
      redis: null,
      scope: "generation-a",
      pageId: "unavailable",
      ttlSeconds: 30,
      load: fallback
    })).resolves.toEqual({ items: ["database"] });
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});
