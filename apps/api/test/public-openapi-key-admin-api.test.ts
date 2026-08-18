import { describe, expect, it } from "vitest";
import { createApiApp } from "../src/server.js";
import type { RuntimeConfig } from "../src/config.js";
import {
  type PublicOpenApiKeyRepository,
  type PublicOpenApiKeyRecord
} from "../src/public-openapi/keys.js";
import { createTestRedisCoordinator, loginAndReadSessionCookie, withTrustedAdminOrigin } from "./support/session.js";

function createConfig(): RuntimeConfig {
  return {
    admin: {
      username: "admin",
      password: "admin-secret",
    },
    database: {
      url: "postgres://focowiki:focowiki@127.0.0.1:5432/focowiki"
    },
    redis: {
      url: "redis://127.0.0.1:6379/0"
    },
    ports: {
      adminApi: 43_000,
      adminUi: 43_100,
      publicOpenApi: 43_200
    },
    publicApi: {
      baseUrl: "https://kb.example.com"
    },
    storage: {
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "focowiki",
      accessKeyId: "s3-access",
      secretAccessKey: "s3-secret",
      prefix: "tenant/demo",
      forcePathStyle: true
    },
    generated: {
      directoryIndexMaxEntries: 200,
      directoryIndexMaxBytes: 65_536,
      rootSummaryLimit: 500,
      okfLogMaxEntries: 100,
      okfLogMaxBytes: 65_536
    },
    pagination: {
      defaultPageSize: 50,
      maxPageSize: 200,
      treeDefaultPageSize: 100,
      treeMaxPageSize: 500,
      cursorTtlSeconds: 900,
      generatedContentMaxBytes: 10_485_760
    },
    model: {
      enabled: false
    },
    corsOrigins: []
  };
}

class MemoryPublicOpenApiKeyRepository implements PublicOpenApiKeyRepository {
  public readonly records: PublicOpenApiKeyRecord[] = [];

  public async listPublicOpenApiKeys(input: { limit: number; cursor: string | null }) {
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
    const record: PublicOpenApiKeyRecord = {
      ...input,
      status: "active",
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
    }
  }
}

describe("Admin public OpenAPI key API", () => {
  it("lists without mutation, then explicitly creates and deletes managed keys", async () => {
    const publicApiKeys = new MemoryPublicOpenApiKeyRepository();
    const app = createApiApp({
      config: createConfig(),
      redis: createTestRedisCoordinator(),
      storageVnextApiKeys: publicApiKeys
    });
    const cookie = await loginAndReadSessionCookie(app);
    const firstList = await app.request("/admin/api/openapi-keys", {
      headers: { cookie }
    });
    const firstListBody = (await firstList.json()) as {
      items: Array<{ id: string; fingerprint: string }>;
      nextCursor: string | null;
    };

    expect(firstList.status).toBe(200);
    expect(firstListBody).toEqual({ items: [], nextCursor: null });
    expect(publicApiKeys.records).toHaveLength(0);

    const created = await app.request("/admin/api/openapi-keys", {
      method: "POST",
      headers: withTrustedAdminOrigin({
        cookie,
        "content-type": "application/json"
      }),
      body: JSON.stringify({ name: "Agent key" })
    });
    const createdBody = (await created.json()) as {
      key: { id: string; name: string };
      oneTimeKey: { id: string; rawKey: string };
    };

    expect(created.status).toBe(201);
    expect(createdBody.key.name).toBe("Agent key");
    expect(createdBody.oneTimeKey.rawKey).toMatch(/^fwok_/);

    const oversizedName = await app.request("/admin/api/openapi-keys", {
      method: "POST",
      headers: withTrustedAdminOrigin({
        cookie,
        "content-type": "application/json"
      }),
      body: JSON.stringify({ name: "x".repeat(81) })
    });
    expect(oversizedName.status).toBe(422);
    expect(publicApiKeys.records.some((record) => record.name === "x".repeat(80))).toBe(false);

    const deleted = await app.request(`/admin/api/openapi-keys/${createdBody.key.id}`, {
      method: "DELETE",
      headers: withTrustedAdminOrigin({ cookie })
    });

    await expect(deleted.json()).resolves.toEqual({ deleted: true });
    expect(deleted.status).toBe(200);
    expect(publicApiKeys.records.find((record) => record.id === createdBody.key.id)?.status).toBe(
      "revoked"
    );

    const listAfterDelete = await app.request("/admin/api/openapi-keys", {
      headers: { cookie }
    });
    const listAfterDeleteBody = (await listAfterDelete.json()) as {
      items: Array<{ id: string; name: string }>;
    };

    expect(listAfterDelete.status).toBe(200);
    expect(listAfterDeleteBody.items.map((item) => item.id)).not.toContain(createdBody.key.id);
  });

  it("rejects unauthenticated OpenAPI key management", async () => {
    const app = createApiApp({
      config: createConfig(),
      redis: createTestRedisCoordinator(),
      storageVnextApiKeys: new MemoryPublicOpenApiKeyRepository()
    });

    expect((await app.request("/admin/api/openapi-keys")).status).toBe(401);
    expect(
      (
        await app.request("/admin/api/openapi-keys", {
          method: "POST"
        })
      ).status
    ).toBe(401);
  });
});
