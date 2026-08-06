import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRedisCoordinator } from "../src/redis/coordination.js";
import { createRedisStorageVnextDeletionVisibilityCache } from
  "../src/storage-vnext/deletion/redis-visibility.js";

const redisUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_REDIS_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(
  redisUrl
  && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedRedis = hasOwnedTarget ? describe : describe.skip;

describeOwnedRedis("real storage vNext Redis coordination", () => {
  const ownerToken = (runOwner ?? "invalid").replaceAll("-", "_");
  const keyPrefix = `focowiki:test:${ownerToken}:${randomUUID().replaceAll("-", "")}`;
  const client = createClient({ url: redisUrl ?? "redis://127.0.0.1:6379/0" });

  beforeAll(async () => {
    await client.connect();
  });

  afterAll(async () => {
    for await (const batch of client.scanIterator({ MATCH: `${keyPrefix}:*`, COUNT: 100 })) {
      for (const key of batch) {
        await client.del(key);
      }
    }
    await client.quit();
  });

  it("keeps every owned key expiring and protects successor lock owners", async () => {
    const scopedRedis = createRedisCoordinator(client, { keyPrefix });
    await scopedRedis.setRuntimeSettingsVersion("version-one");

    const rateKey = scopedRedis.buildKey("rate-limits", "public", "client-one");
    await client.set(rateKey, "invalid-counter");
    await expect(scopedRedis.hitRateLimit("public", "client-one", {
      max: 2,
      windowSeconds: 60
    })).resolves.toMatchObject({ allowed: true, remaining: 1 });

    const lockKey = scopedRedis.buildKey("locks", "workflow", "operation-one");
    await expect(scopedRedis.acquireLock("workflow", "operation-one", "owner-one", 30))
      .resolves.toBe(true);
    await client.set(lockKey, "owner-two", { EX: 30 });
    await expect(scopedRedis.releaseLock("workflow", "operation-one", "owner-one"))
      .resolves.toBe(false);
    await expect(client.get(lockKey)).resolves.toBe("owner-two");
    await expect(scopedRedis.releaseLock("workflow", "operation-one", "owner-two"))
      .resolves.toBe(true);

    const ownedKeys: string[] = [];
    for await (const batch of client.scanIterator({ MATCH: `${keyPrefix}:*`, COUNT: 100 })) {
      ownedKeys.push(...batch);
    }
    expect(ownedKeys.sort()).toEqual([
      rateKey,
      scopedRedis.buildKey("runtime-settings", "version")
    ].sort());
    for (const key of ownedKeys) {
      await expect(client.ttl(key)).resolves.toBeGreaterThan(0);
    }
  });

  it("removes only deletion-visible knowledge-base caches from the owned namespace", async () => {
    const scopedRedis = createRedisCoordinator(client, { keyPrefix });
    const cache = createRedisStorageVnextDeletionVisibilityCache({ redis: scopedRedis });
    const deletedKnowledgeBaseId = "kb-delete-cache";
    const keptKnowledgeBaseId = "kb-keep-cache";
    const deletedKeys = [
      scopedRedis.buildKey(
        "knowledge-base-publication-locks",
        deletedKnowledgeBaseId
      ),
      scopedRedis.buildKey("page-cache", "tree", deletedKnowledgeBaseId, "page-one"),
      scopedRedis.buildKey(
        "pagination-cursors",
        "files",
        deletedKnowledgeBaseId,
        "cursor-one"
      )
    ];
    const keptKey = scopedRedis.buildKey(
      "page-cache",
      "tree",
      keptKnowledgeBaseId,
      "page-one"
    );
    for (const key of [...deletedKeys, keptKey]) {
      await client.set(key, "value", { EX: 60 });
    }

    await cache.invalidateKnowledgeBase({ knowledgeBaseId: deletedKnowledgeBaseId });

    for (const key of deletedKeys) await expect(client.exists(key)).resolves.toBe(0);
    await expect(client.exists(keptKey)).resolves.toBe(1);
  });
});
