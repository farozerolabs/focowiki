import { describe, expect, it } from "vitest";
import { createApiApp } from "../src/server.js";
import type { RuntimeConfig } from "../src/config.js";
import { createRedisCoordinator } from "../src/redis/coordination.js";
import {
  createTestRedisCoordinator,
  loginAndReadSessionCookie,
  MemoryRedisCommandClient,
  withTrustedAdminOrigin
} from "./support/session.js";

type KnowledgeBaseRecord = {
  id: string;
  name: string;
  description: string | null;
  activeReleaseId: string | null;
  catalogGeneration: number;
  createdAt: string;
  updatedAt: string;
};

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
      generationBatchSize: 50,
      fileProcessingConcurrency: 1,
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

function createRepository() {
  const items = new Map<string, KnowledgeBaseRecord>();
  let nextId = 0;
  const listCalls: Array<{ limit: number; cursor: string | null; query?: string | null }> = [];

  return {
    listCalls,
    async listKnowledgeBases(request: { limit: number; cursor: string | null; query?: string | null }) {
      listCalls.push(request);
      const normalizedQuery = request.query?.toLocaleLowerCase("en-US") ?? "";
      const values = Array.from(items.values()).filter((item) => {
        if (!normalizedQuery) {
          return true;
        }

        return [item.id, item.name, item.description ?? ""]
          .join(" ")
          .toLocaleLowerCase("en-US")
          .includes(normalizedQuery);
      });
      const start = request.cursor ? Number(request.cursor) : 0;
      const pageItems = values.slice(start, start + request.limit);
      const nextCursor =
        start + request.limit < values.length ? String(start + request.limit) : null;
      return { items: pageItems, nextCursor };
    },
    async createKnowledgeBase(input: { name: string; description: string | null }) {
      nextId += 1;
      const now = "2026-06-14T00:00:00.000Z";
      const knowledgeBase: KnowledgeBaseRecord = {
        id: `kb-${String(nextId).padStart(6, "0")}`,
        name: input.name,
        description: input.description,
        activeReleaseId: null,
        catalogGeneration: 0,
        createdAt: now,
        updatedAt: now
      };
      items.set(knowledgeBase.id, knowledgeBase);
      return knowledgeBase;
    },
    async getKnowledgeBase(id: string) {
      return items.get(id) ?? null;
    }
  };
}

async function createAuthenticatedKnowledgeBaseApp() {
  const repositories = {
    knowledgeBases: createRepository()
  };
  const app = createApiApp({
    config: createConfig(),
    redis: createTestRedisCoordinator(),
    repositories
  });
  const cookie = await loginAndReadSessionCookie(app);
  return { app, cookie };
}

describe("Knowledge base Admin API", () => {
  it("lists an empty knowledge base page", async () => {
    const { app, cookie } = await createAuthenticatedKnowledgeBaseApp();
    const response = await app.request("/admin/api/knowledge-bases", {
      headers: {
        cookie
      }
    });

    await expect(response.json()).resolves.toEqual({
      items: [],
      nextCursor: null
    });
    expect(response.status).toBe(200);
  });

  it("creates a knowledge base and returns its detail", async () => {
    const { app, cookie } = await createAuthenticatedKnowledgeBaseApp();
    const create = await app.request("/admin/api/knowledge-bases", {
      method: "POST",
      headers: withTrustedAdminOrigin({
        cookie,
        "content-type": "application/json"
      }),
      body: JSON.stringify({
        name: "Developer docs",
        description: "Internal markdown knowledge"
      })
    });
    const createBody = (await create.json()) as { knowledgeBase: KnowledgeBaseRecord };
    const detail = await app.request(`/admin/api/knowledge-bases/${createBody.knowledgeBase.id}`, {
      headers: {
        cookie
      }
    });

    expect(create.status).toBe(201);
    expect(createBody.knowledgeBase).toMatchObject({
      id: expect.stringMatching(/^kb-[a-z0-9-]+$/),
      name: "Developer docs",
      description: "Internal markdown knowledge",
      activeReleaseId: null
    });
    await expect(detail.json()).resolves.toEqual({
      knowledgeBase: createBody.knowledgeBase
    });
    expect(detail.status).toBe(200);
  });

  it("rejects invalid create input", async () => {
    const { app, cookie } = await createAuthenticatedKnowledgeBaseApp();
    const response = await app.request("/admin/api/knowledge-bases", {
      method: "POST",
      headers: withTrustedAdminOrigin({
        cookie,
        "content-type": "application/json"
      }),
      body: JSON.stringify({ name: " " })
    });

    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_KNOWLEDGE_BASE",
        messageKey: "errors.invalidKnowledgeBase"
      }
    });
    expect(response.status).toBe(400);
  });

  it("returns not found for a missing knowledge base detail", async () => {
    const { app, cookie } = await createAuthenticatedKnowledgeBaseApp();
    const response = await app.request("/admin/api/knowledge-bases/kb-missing", {
      headers: {
        cookie
      }
    });

    expect(response.status).toBe(404);
  });

  it("returns cursor-paginated knowledge base cards with Redis cursor and page cache state", async () => {
    const repository = createRepository();
    await repository.createKnowledgeBase({ name: "One", description: null });
    await repository.createKnowledgeBase({ name: "Two", description: null });
    const redisClient = new MemoryRedisCommandClient();
    const app = createApiApp({
      config: createConfig(),
      redis: createRedisCoordinator(redisClient, { keyPrefix: "focowiki-test" }),
      repositories: {
        knowledgeBases: repository
      }
    });
    const cookie = await loginAndReadSessionCookie(app);
    const first = await app.request("/admin/api/knowledge-bases?limit=1", {
      headers: {
        cookie
      }
    });
    const firstBody = (await first.json()) as {
      items: KnowledgeBaseRecord[];
      nextCursor: string | null;
    };

    expect(first.status).toBe(200);
    expect(firstBody.items).toHaveLength(1);
    expect(firstBody.nextCursor).toEqual(expect.stringMatching(/^cursor-/));
    expect(firstBody.nextCursor).not.toBe("1");
    expect(
      Array.from(redisClient.values.keys()).some((key) =>
        key.startsWith("focowiki-test:pagination-cursors:knowledge-bases:")
      )
    ).toBe(true);
    expect(
      Array.from(redisClient.values.keys()).some((key) =>
        key.startsWith("focowiki-test:page-cache:knowledge-bases:")
      )
    ).toBe(true);

    const second = await app.request(
      `/admin/api/knowledge-bases?limit=1&cursor=${firstBody.nextCursor}`,
      {
        headers: {
          cookie
        }
      }
    );
    const secondBody = (await second.json()) as {
      items: KnowledgeBaseRecord[];
      nextCursor: string | null;
    };

    expect(second.status).toBe(200);
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.nextCursor).toBeNull();
    expect(repository.listCalls).toEqual([
      { limit: 1, cursor: null, query: null },
      { limit: 1, cursor: "1", query: null }
    ]);
  });

  it("searches knowledge base cards by name, description, and ID", async () => {
    const repository = createRepository();
    await repository.createKnowledgeBase({
      name: "Developer docs",
      description: "Markdown product knowledge"
    });
    await repository.createKnowledgeBase({
      name: "Legal library",
      description: "Contract metadata"
    });
    const app = createApiApp({
      config: createConfig(),
      redis: createTestRedisCoordinator(),
      repositories: {
        knowledgeBases: repository
      }
    });
    const cookie = await loginAndReadSessionCookie(app);

    const byName = await app.request("/admin/api/knowledge-bases?query=developer", {
      headers: { cookie }
    });
    const byDescription = await app.request("/admin/api/knowledge-bases?query=product", {
      headers: { cookie }
    });
    const byId = await app.request("/admin/api/knowledge-bases?query=kb-000002", {
      headers: { cookie }
    });

    await expect(byName.json()).resolves.toMatchObject({
      items: [{ id: "kb-000001", name: "Developer docs" }],
      nextCursor: null
    });
    await expect(byDescription.json()).resolves.toMatchObject({
      items: [{ id: "kb-000001", name: "Developer docs" }],
      nextCursor: null
    });
    await expect(byId.json()).resolves.toMatchObject({
      items: [{ id: "kb-000002", name: "Legal library" }],
      nextCursor: null
    });
    expect(byName.status).toBe(200);
    expect(byDescription.status).toBe(200);
    expect(byId.status).toBe(200);
    expect(repository.listCalls.map((call) => call.query)).toEqual([
      "developer",
      "product",
      "kb-000002"
    ]);
  });

  it("rejects invalid knowledge base card search query without repository reads", async () => {
    const repository = createRepository();
    const app = createApiApp({
      config: createConfig(),
      redis: createTestRedisCoordinator(),
      repositories: {
        knowledgeBases: repository
      }
    });
    const cookie = await loginAndReadSessionCookie(app);
    const query = "x".repeat(129);
    const response = await app.request(`/admin/api/knowledge-bases?query=${query}`, {
      headers: { cookie }
    });

    await expect(response.json()).resolves.toEqual({
      error: {
        code: "KNOWLEDGE_BASE_SEARCH_QUERY_TOO_LONG"
      }
    });
    expect(response.status).toBe(400);
    expect(repository.listCalls).toEqual([]);
  });

  it("rejects knowledge base search cursors from a different query scope", async () => {
    const repository = createRepository();
    await repository.createKnowledgeBase({ name: "One docs", description: null });
    await repository.createKnowledgeBase({ name: "Two docs", description: null });
    const redisClient = new MemoryRedisCommandClient();
    const app = createApiApp({
      config: createConfig(),
      redis: createRedisCoordinator(redisClient, { keyPrefix: "focowiki-test" }),
      repositories: {
        knowledgeBases: repository
      }
    });
    const cookie = await loginAndReadSessionCookie(app);
    const first = await app.request("/admin/api/knowledge-bases?query=docs&limit=1", {
      headers: { cookie }
    });
    const firstBody = (await first.json()) as {
      items: KnowledgeBaseRecord[];
      nextCursor: string | null;
    };

    expect(first.status).toBe(200);
    expect(firstBody.nextCursor).toEqual(expect.stringMatching(/^cursor-/));
    expect(
      Array.from(redisClient.values.keys()).some((key) =>
        key.startsWith("focowiki-test:pagination-cursors:knowledge-bases:query-")
      )
    ).toBe(true);

    const mismatch = await app.request(
      `/admin/api/knowledge-bases?query=support&limit=1&cursor=${firstBody.nextCursor}`,
      {
        headers: { cookie }
      }
    );

    await expect(mismatch.json()).resolves.toEqual({
      error: {
        code: "INVALID_PAGINATION"
      }
    });
    expect(mismatch.status).toBe(400);
  });
});
