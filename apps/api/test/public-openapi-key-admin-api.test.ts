import { describe, expect, it } from "vitest";
import { createApiApp } from "../src/server.js";
import type { RuntimeConfig } from "../src/config.js";
import {
  hashPublicOpenApiKey,
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
    upload: {
      maxBytes: 1_048_576,
      maxFiles: 8,
      generationBatchSize: 50,
      fileProcessingConcurrency: 1,
      storageConcurrency: 4
    },
    publication: {
      mode: "batch",
      batchSize: 300,
      intervalSeconds: 300,
      indexShardSize: 1_000,
      linkIndexShardSize: 1_000,
      manifestShardSize: 1_000,
      graphEdgeShardSize: 5_000,
      graphCandidateLimit: 200,
      graphMaintenanceBatchSize: 500,
      rootSummaryLimit: 500
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

  public async countActivePublicOpenApiKeys(): Promise<number> {
    return this.records.filter((record) => record.status === "active").length;
  }

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

function createRepositories(publicApiKeys: PublicOpenApiKeyRepository) {
  return {
    publicApiKeys,
    knowledgeBases: {
      async listKnowledgeBases() {
        return { items: [], nextCursor: null };
      },
      async createKnowledgeBase() {
        throw new Error("Not used by OpenAPI key admin tests");
      },
      async getKnowledgeBase() {
        return null;
      }
    }
  };
}

describe("Admin public OpenAPI key API", () => {
  it("bootstraps, creates, lists, and deletes managed keys through authenticated routes", async () => {
    const publicApiKeys = new MemoryPublicOpenApiKeyRepository();
    const app = createApiApp({
      config: createConfig(),
      redis: createTestRedisCoordinator(),
      repositories: createRepositories(publicApiKeys)
    });
    const cookie = await loginAndReadSessionCookie(app);
    const firstList = await app.request("/admin/api/openapi-keys", {
      headers: { cookie }
    });
    const firstListBody = (await firstList.json()) as {
      items: Array<{ id: string; fingerprint: string }>;
      oneTimeKey: { id: string; rawKey: string } | null;
    };

    expect(firstList.status).toBe(200);
    expect(firstListBody.items).toHaveLength(1);
    expect(firstListBody.oneTimeKey?.rawKey).toMatch(/^fwok_/);
    expect(JSON.stringify(firstListBody.items)).not.toContain(firstListBody.oneTimeKey?.rawKey);
    expect(publicApiKeys.records[0]?.keyHash).toBe(
      hashPublicOpenApiKey(firstListBody.oneTimeKey?.rawKey ?? "")
    );

    const secondList = await app.request("/admin/api/openapi-keys", {
      headers: { cookie }
    });
    await expect(secondList.json()).resolves.toMatchObject({
      oneTimeKey: null
    });

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
      repositories: createRepositories(new MemoryPublicOpenApiKeyRepository())
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
