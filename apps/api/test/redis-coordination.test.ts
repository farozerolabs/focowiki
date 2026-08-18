import { describe, expect, it, vi } from "vitest";
import { createRedisCoordinator, type RedisCommandClient } from "../src/redis/coordination.js";

describe("redis coordination cleanup", () => {
  it("clears source-file runtime keys and source-scoped paginated caches", async () => {
    const deletedKeys: string[] = [];
    const client = createRedisClient({
      keys: [
        "focowiki:pagination-invalid:source-file-events:kb-test:source-file-test",
        "focowiki:pagination-cursors:developer-openapi:related:kb-test:source-file-test:cursor-a",
        "focowiki:page-cache:developer-openapi:related:kb-test:source-file-test:page-a"
      ],
      deletedKeys
    });
    const redis = createRedisCoordinator(client);

    const deleted = await redis.clearSourceFileRuntimeKeys({
      knowledgeBaseId: "kb-test",
      sourceFileId: "source-file-test"
    });

    expect(deleted).toBe(5);
    expect(deletedKeys).toEqual(
      expect.arrayContaining([
        "focowiki:source-file-locks:source-file-test",
        "focowiki:source-file-graph-locks:source-file-test",
        "focowiki:pagination-invalid:source-file-events:kb-test:source-file-test",
        "focowiki:pagination-cursors:developer-openapi:related:kb-test:source-file-test:cursor-a",
        "focowiki:page-cache:developer-openapi:related:kb-test:source-file-test:page-a"
      ])
    );
  });

  it("clears knowledge-base runtime keys and source runtime keys together", async () => {
    const deletedKeys: string[] = [];
    const client = createRedisClient({
      keys: [
        "focowiki:page-cache:knowledge-bases:page-shared",
        "focowiki:pagination-cursors:knowledge-bases:query-contract:cursor-shared",
        "focowiki:pagination-invalid:source-files:kb-test",
        "focowiki:pagination-cursors:file-tree:kb-test:generation-test:cursor-a",
        "focowiki:page-cache:active-files:kb-test:generation-test:page-a"
      ],
      deletedKeys
    });
    const redis = createRedisCoordinator(client);

    const deleted = await redis.clearKnowledgeBaseRuntimeKeys({
      knowledgeBaseId: "kb-test",
      sourceFileIds: ["source-file-a"]
    });

    expect(deleted).toBe(7);
    expect(deletedKeys).toEqual(
      expect.arrayContaining([
        "focowiki:page-cache:knowledge-bases:page-shared",
        "focowiki:pagination-cursors:knowledge-bases:query-contract:cursor-shared",
        "focowiki:pagination-invalid:source-files:kb-test",
        "focowiki:pagination-cursors:file-tree:kb-test:generation-test:cursor-a",
        "focowiki:page-cache:active-files:kb-test:generation-test:page-a",
        "focowiki:source-file-locks:source-file-a",
        "focowiki:source-file-graph-locks:source-file-a"
      ])
    );
  });

  it("uses TTLs for current-version signals and rate counters", async () => {
    const client = createRedisClient({ keys: [], deletedKeys: [] });
    const redis = createRedisCoordinator(client);

    await redis.setRuntimeSettingsVersion("version-one");
    const first = await redis.hitRateLimit("developer", "client-one", {
      max: 2,
      windowSeconds: 60
    });
    const second = await redis.hitRateLimit("developer", "client-one", {
      max: 2,
      windowSeconds: 60
    });

    expect(client.ttls.get("focowiki:runtime-settings:version")).toBe(300);
    expect(client.ttls.get("focowiki:rate-limits:developer:client-one")).toBe(60);
    expect(first).toMatchObject({ allowed: true, remaining: 1 });
    expect(second).toMatchObject({ allowed: true, remaining: 0 });
  });

  it("releases a lock only when the owner still matches", async () => {
    const client = createRedisClient({ keys: [], deletedKeys: [] });
    const redis = createRedisCoordinator(client);

    await expect(redis.acquireLock("workflow", "operation-one", "owner-one", 30))
      .resolves.toBe(true);
    await expect(redis.releaseLock("workflow", "operation-one", "owner-two"))
      .resolves.toBe(false);
    await expect(redis.releaseLock("workflow", "operation-one", "owner-one"))
      .resolves.toBe(true);
  });

  it("clears both authorization and usage keys for a revoked OpenAPI key", async () => {
    const deletedKeys: string[] = [];
    const redis = createRedisCoordinator(createRedisClient({ keys: [], deletedKeys }));

    await redis.clearPublicOpenApiKeyRuntimeKeys("key-test", "hash-test");

    expect(deletedKeys).toEqual([
      "focowiki:public-openapi-key-cache:hash-test",
      "focowiki:public-openapi-key-used:key-test"
    ]);
  });

  it("publishes a best-effort unified-worker wakeup", async () => {
    const client = createRedisClient({ keys: [], deletedKeys: [] });
    const publish = vi.fn().mockResolvedValue(2);
    client.publish = publish;
    const redis = createRedisCoordinator(client, { keyPrefix: "review" });

    await expect(redis.notifyWorkerWork("document")).resolves.toBe(true);
    expect(publish).toHaveBeenCalledWith("review:worker:wakeup", "document");
  });
});

function createRedisClient(input: {
  keys: string[];
  deletedKeys: string[];
}): RedisCommandClient & { ttls: Map<string, number> } {
  const deleted = new Set<string>();
  const keys = new Set(input.keys);
  const values = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    ttls,
    set: vi.fn(async (key: string, value: string, options?: Record<string, unknown>) => {
      if (options?.NX === true && values.has(key)) return null;
      keys.add(key);
      values.set(key, value);
      if (typeof options?.EX === "number") ttls.set(key, options.EX);
      return "OK";
    }),
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    del: vi.fn(async (key: string) => {
      if (deleted.has(key)) {
        return 0;
      }
      deleted.add(key);
      input.deletedKeys.push(key);
      keys.delete(key);
      values.delete(key);
      ttls.delete(key);
      return 1;
    }),
    eval: vi.fn(async (script: string, options: { keys: string[]; arguments: string[] }) => {
      const key = options.keys[0];
      if (!key) return 0;
      if (script.includes("next_count")) {
        const count = Number(values.get(key) ?? "0") + 1;
        values.set(key, String(count));
        const windowSeconds = Number(options.arguments[0]);
        if (count === 1 || !ttls.has(key)) ttls.set(key, windowSeconds);
        return [count, ttls.get(key)];
      }
      if (values.get(key) !== options.arguments[0]) return 0;
      values.delete(key);
      ttls.delete(key);
      return 1;
    }),
    scanIterator: async function* (options: { MATCH?: string }) {
      const pattern = options.MATCH ?? "*";
      const matches = [...keys].filter((key) => matchesPattern(key, pattern));

      if (matches.length > 0) {
        yield matches;
      }
    }
  };
}

function matchesPattern(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}
