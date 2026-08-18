import { describe, expect, it } from "vitest";
import {
  createPublicOpenApiKeyService,
  hashPublicOpenApiKey,
  type PublicOpenApiKeyRepository
} from "../src/public-openapi/keys.js";
import { createRedisCoordinator } from "../src/redis/coordination.js";
import {
  createTestRedisCoordinator,
  MemoryRedisCommandClient
} from "./support/session.js";

class MemoryPublicOpenApiKeyRepository implements PublicOpenApiKeyRepository {
  public readonly records: Awaited<ReturnType<PublicOpenApiKeyRepository["createPublicOpenApiKey"]>>[] = [];
  public lastUsedWrites = 0;

  public async listPublicOpenApiKeys(input: {
    limit: number;
    cursor: string | null;
  }) {
    const offset = input.cursor ? Number(input.cursor) : 0;
    const activeRecords = this.records.filter((record) => record.status === "active");
    const items = activeRecords.slice(offset, offset + input.limit);
    const nextOffset = offset + items.length;

    return {
      items,
      nextCursor: nextOffset < activeRecords.length ? String(nextOffset) : null
    };
  }

  public async createPublicOpenApiKey(input: {
    id: string;
    name: string;
    keyHash: string;
    keyPrefix: string;
    keySuffix: string;
    createdAt: string;
  }) {
    const record = {
      ...input,
      status: "active" as const,
      lastUsedAt: null,
      revokedAt: null
    };
    this.records.unshift(record);
    return record;
  }

  public async findActivePublicOpenApiKeyByHash(keyHash: string) {
    return (
      this.records.find((record) => record.keyHash === keyHash && record.status === "active") ??
      null
    );
  }

  public async revokePublicOpenApiKey(input: { id: string; revokedAt: string }) {
    const record = this.records.find((item) => item.id === input.id && item.status === "active");

    if (!record) {
      return null;
    }

    record.status = "revoked";
    record.revokedAt = input.revokedAt;
    return record;
  }

  public async updatePublicOpenApiKeyLastUsed(input: { id: string; lastUsedAt: string }) {
    const record = this.records.find((item) => item.id === input.id);

    if (record) {
      record.lastUsedAt = input.lastUsedAt;
      this.lastUsedWrites += 1;
    }
  }
}

describe("public OpenAPI key service", () => {
  it("lists keys without creating credentials as a read side effect", async () => {
    const repository = new MemoryPublicOpenApiKeyRepository();
    const service = createPublicOpenApiKeyService({
      repository,
      redis: createTestRedisCoordinator()
    });
    const page = await service.listKeys({ limit: 10, cursor: null });

    expect(page).toEqual({ items: [], nextCursor: null });
    expect(repository.records).toHaveLength(0);
  });

  it("creates, authorizes, throttles last-used writes, and revokes keys", async () => {
    const repository = new MemoryPublicOpenApiKeyRepository();
    const redisClient = new MemoryRedisCommandClient();
    const redis = createRedisCoordinator(redisClient, { keyPrefix: "focowiki-test" });
    const service = createPublicOpenApiKeyService({ repository, redis });
    const created = await service.createKey({ name: "Agent key" });

    expect(created.key.name).toBe("Agent key");
    expect(created.rawKey).toMatch(/^fwok_/);
    expect(created.key.fingerprint).toContain("...");
    await expect(service.authorize(created.rawKey)).resolves.toEqual({ authorized: true });
    await expect(service.authorize(created.rawKey)).resolves.toEqual({ authorized: true });
    expect(repository.lastUsedWrites).toBe(1);
    expect(redisClient.values.has(redis.buildKey("public-openapi-key-used", created.key.id))).toBe(true);
    expect(redisClient.values.has(
      redis.buildKey("public-openapi-key-cache", hashPublicOpenApiKey(created.rawKey))
    )).toBe(true);

    await expect(service.authorize("wrong")).resolves.toEqual({ authorized: false });
    await expect(service.deleteKey(created.key.id)).resolves.toBe(true);
    expect(redisClient.values.has(redis.buildKey("public-openapi-key-used", created.key.id))).toBe(false);
    expect(redisClient.values.has(
      redis.buildKey("public-openapi-key-cache", hashPublicOpenApiKey(created.rawKey))
    )).toBe(false);
    await expect(service.authorize(created.rawKey)).resolves.toEqual({ authorized: false });
  });
});
