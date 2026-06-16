import { describe, expect, it } from "vitest";
import {
  createPublicOpenApiKeyService,
  hashPublicOpenApiKey,
  type PublicOpenApiKeyRepository
} from "../src/public-openapi/keys.js";
import { createTestRedisCoordinator } from "./support/session.js";

class MemoryPublicOpenApiKeyRepository implements PublicOpenApiKeyRepository {
  public readonly records: Awaited<ReturnType<PublicOpenApiKeyRepository["createPublicOpenApiKey"]>>[] = [];
  public lastUsedWrites = 0;

  public async countActivePublicOpenApiKeys(): Promise<number> {
    return this.records.filter((record) => record.status === "active").length;
  }

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
  it("bootstraps a default key with one-time raw disclosure and hash-only records", async () => {
    const repository = new MemoryPublicOpenApiKeyRepository();
    const service = createPublicOpenApiKeyService({
      repository,
      redis: createTestRedisCoordinator()
    });
    const page = await service.listKeysWithBootstrap({ limit: 10, cursor: null });

    expect(page.items).toHaveLength(1);
    expect(page.oneTimeKey?.rawKey).toMatch(/^fwok_/);
    expect(page.oneTimeKey?.id).toBe(page.items[0]?.id);
    expect(repository.records[0]?.keyHash).toBe(hashPublicOpenApiKey(page.oneTimeKey?.rawKey ?? ""));
    expect(JSON.stringify(repository.records)).not.toContain(page.oneTimeKey?.rawKey);

    const secondPage = await service.listKeysWithBootstrap({ limit: 10, cursor: null });
    expect(secondPage.oneTimeKey).toBeNull();
  });

  it("creates, authorizes, throttles last-used writes, and revokes keys", async () => {
    const repository = new MemoryPublicOpenApiKeyRepository();
    const redis = createTestRedisCoordinator();
    const service = createPublicOpenApiKeyService({ repository, redis });
    const created = await service.createKey({ name: "Agent key" });

    expect(created.key.name).toBe("Agent key");
    expect(created.rawKey).toMatch(/^fwok_/);
    expect(created.key.fingerprint).toContain("...");
    await expect(service.authorize(created.rawKey)).resolves.toEqual({ authorized: true });
    await expect(service.authorize(created.rawKey)).resolves.toEqual({ authorized: true });
    expect(repository.lastUsedWrites).toBe(1);

    await expect(service.authorize("wrong")).resolves.toEqual({ authorized: false });
    await expect(service.deleteKey(created.key.id)).resolves.toBe(true);
    await expect(service.authorize(created.rawKey)).resolves.toEqual({ authorized: false });
  });
});
