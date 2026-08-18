import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "../src/config.js";
import { createApiApp } from "../src/server.js";
import type { StorageVnextAdminKnowledgeBase } from
  "../src/storage-vnext/api/admin-ports.js";
import type { StorageVnextAdminReadApplication } from
  "../src/storage-vnext/api/admin-read-application.js";
import type { StorageVnextAdminCoreApplication } from
  "../src/storage-vnext/api/admin-core-application.js";
import {
  createTestRedisCoordinator,
  loginAndReadSessionCookie,
  withTrustedAdminOrigin
} from "./support/session.js";

type KnowledgeBaseRecord = {
  id: string;
  name: string;
  description: string | null;
  activeGenerationId: string | null;
  catalogGeneration: number;
  createdAt: string;
  updatedAt: string;
};

describe("Knowledge base Admin API", () => {
  it("lists an empty knowledge base page", async () => {
    const { app, cookie } = await createAuthenticatedKnowledgeBaseApp();
    const response = await app.request("/admin/api/knowledge-bases", {
      headers: { cookie }
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
    const createBody = await create.json() as { knowledgeBase: KnowledgeBaseRecord };
    const detail = await app.request(
      `/admin/api/knowledge-bases/${createBody.knowledgeBase.id}`,
      { headers: { cookie } }
    );

    expect(create.status).toBe(201);
    expect(createBody.knowledgeBase).toMatchObject({
      id: expect.stringMatching(/^kb-[a-z0-9-]+$/),
      name: "Developer docs",
      description: "Internal markdown knowledge",
      activeGenerationId: null
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

  it("rejects a non-string knowledge-base description", async () => {
    const { app, cookie } = await createAuthenticatedKnowledgeBaseApp();
    const response = await app.request("/admin/api/knowledge-bases", {
      method: "POST",
      headers: withTrustedAdminOrigin({
        cookie,
        "content-type": "application/json"
      }),
      body: JSON.stringify({ name: "Developer docs", description: 1 })
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
      headers: { cookie }
    });

    expect(response.status).toBe(404);
  });

  it("returns cursor-paginated knowledge base cards with opaque cursors", async () => {
    const fixture = createKnowledgeBaseApplications();
    fixture.create({ name: "One", description: null });
    fixture.create({ name: "Two", description: null });
    const { app, cookie } = await createAuthenticatedKnowledgeBaseApp(fixture);
    const first = await app.request("/admin/api/knowledge-bases?limit=1", {
      headers: { cookie }
    });
    const firstBody = await first.json() as {
      items: KnowledgeBaseRecord[];
      nextCursor: string | null;
    };

    expect(first.status).toBe(200);
    expect(firstBody.items).toHaveLength(1);
    expect(firstBody.nextCursor).toEqual(expect.stringMatching(/^cursor-/));
    expect(firstBody.nextCursor).not.toBe("1");

    const second = await app.request(
      `/admin/api/knowledge-bases?limit=1&cursor=${firstBody.nextCursor}`,
      { headers: { cookie } }
    );
    const secondBody = await second.json() as {
      items: KnowledgeBaseRecord[];
      nextCursor: string | null;
    };

    expect(second.status).toBe(200);
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.nextCursor).toBeNull();
    expect(fixture.listCalls).toEqual([
      { limit: 1, cursor: null, query: null },
      { limit: 1, cursor: firstBody.nextCursor, query: null }
    ]);
  });

  it("searches knowledge base cards by name, description, and ID", async () => {
    const fixture = createKnowledgeBaseApplications();
    fixture.create({
      name: "Developer docs",
      description: "Markdown product knowledge"
    });
    fixture.create({
      name: "Legal library",
      description: "Contract metadata"
    });
    const { app, cookie } = await createAuthenticatedKnowledgeBaseApp(fixture);

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
  });

  it("rejects invalid knowledge base card search query without backend reads", async () => {
    const fixture = createKnowledgeBaseApplications();
    const { app, cookie } = await createAuthenticatedKnowledgeBaseApp(fixture);
    const query = "x".repeat(129);
    const response = await app.request(`/admin/api/knowledge-bases?query=${query}`, {
      headers: { cookie }
    });

    await expect(response.json()).resolves.toEqual({
      error: { code: "KNOWLEDGE_BASE_SEARCH_QUERY_TOO_LONG" }
    });
    expect(response.status).toBe(400);
    expect(fixture.listCalls).toEqual([]);
  });

  it("rejects knowledge base search cursors from a different query scope", async () => {
    const fixture = createKnowledgeBaseApplications();
    fixture.create({ name: "One docs", description: null });
    fixture.create({ name: "Two docs", description: null });
    const { app, cookie } = await createAuthenticatedKnowledgeBaseApp(fixture);
    const first = await app.request(
      "/admin/api/knowledge-bases?query=docs&limit=1",
      { headers: { cookie } }
    );
    const firstBody = await first.json() as {
      items: KnowledgeBaseRecord[];
      nextCursor: string | null;
    };

    expect(first.status).toBe(200);
    expect(firstBody.nextCursor).toEqual(expect.stringMatching(/^cursor-/));

    const mismatch = await app.request(
      `/admin/api/knowledge-bases?query=support&limit=1&cursor=${firstBody.nextCursor}`,
      { headers: { cookie } }
    );

    await expect(mismatch.json()).resolves.toEqual({
      error: { code: "INVALID_PAGINATION" }
    });
    expect(mismatch.status).toBe(400);
  });
});

async function createAuthenticatedKnowledgeBaseApp(
  fixture = createKnowledgeBaseApplications()
) {
  const app = createApiApp({
    config: createConfig(),
    redis: createTestRedisCoordinator(),
    storageVnextAdminRead: fixture.adminRead,
    storageVnextAdminCore: fixture.adminCore
  });
  const cookie = await loginAndReadSessionCookie(app);
  return { app, cookie };
}

function createKnowledgeBaseApplications() {
  const items = new Map<string, StorageVnextAdminKnowledgeBase>();
  const listCalls: Array<{ limit: number; cursor: string | null; query: string | null }> = [];
  let nextId = 0;
  const create = (input: { name: string; description: string | null }) => {
    nextId += 1;
    const now = "2026-06-14T00:00:00.000Z";
    const knowledgeBase: StorageVnextAdminKnowledgeBase = {
      id: `kb-${String(nextId).padStart(6, "0")}`,
      name: input.name,
      description: input.description,
      activeVersionId: null,
      catalogVersion: 0,
      createdAt: now,
      updatedAt: now
    };
    items.set(knowledgeBase.id, knowledgeBase);
    return knowledgeBase;
  };
  const adminRead: StorageVnextAdminReadApplication = {
    async listKnowledgeBases(request) {
      listCalls.push(request);
      const query = request.query?.toLocaleLowerCase("en-US") ?? "";
      const scope = encodeURIComponent(query);
      let start = 0;
      if (request.cursor) {
        const match = /^cursor-([^:]*):(\d+)$/.exec(request.cursor);
        if (!match || match[1] !== scope) {
          return { ok: false, code: "INVALID_PAGINATION" };
        }
        start = Number(match[2]);
      }
      const values = [...items.values()].filter((item) =>
        [item.id, item.name, item.description ?? ""]
          .join(" ")
          .toLocaleLowerCase("en-US")
          .includes(query)
      );
      const pageItems = values.slice(start, start + request.limit);
      return {
        ok: true,
        value: {
          items: pageItems,
          nextCursor: start + request.limit < values.length
            ? `cursor-${scope}:${start + request.limit}`
            : null
        }
      };
    },
    async getKnowledgeBase(request) {
      return { ok: true, value: items.get(request.knowledgeBaseId) ?? null };
    },
    async listTree() {
      return { ok: true, value: { items: [], nextCursor: null } };
    },
    async searchFiles() {
      return { ok: true, value: { items: [], nextCursor: null } };
    }
  };
  const unavailable = async () => ({
    ok: false as const,
    code: "DATABASE_REPOSITORY_UNAVAILABLE" as const
  });
  const adminCore: StorageVnextAdminCoreApplication = {
    async createKnowledgeBase(request) {
      return {
        ok: true,
        value: releasedKnowledgeBase(create(request))
      };
    },
    async getKnowledgeBase(request) {
      const knowledgeBase = items.get(request.knowledgeBaseId);
      return knowledgeBase
        ? { ok: true, value: releasedKnowledgeBase(knowledgeBase) }
        : { ok: false, code: "NOT_FOUND" };
    },
    deleteKnowledgeBase: unavailable,
    readGeneratedContent: unavailable,
    deleteSourceFile: unavailable,
    listFiles: unavailable,
    getFile: unavailable
  };
  return { adminRead, adminCore, create, listCalls };
}

function releasedKnowledgeBase(value: StorageVnextAdminKnowledgeBase): KnowledgeBaseRecord {
  return {
    id: value.id,
    name: value.name,
    description: value.description,
    activeGenerationId: value.activeVersionId,
    catalogGeneration: value.catalogVersion,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function createConfig(): RuntimeConfig {
  return {
    admin: { username: "admin", password: "admin-secret" },
    database: { url: "postgres://focowiki:focowiki@127.0.0.1:5432/focowiki" },
    redis: { url: "redis://127.0.0.1:6379/0" },
    ports: { adminApi: 43_000, adminUi: 43_100, publicOpenApi: 43_200 },
    publicApi: { baseUrl: "https://kb.example.com" },
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
    model: { enabled: false },
    corsOrigins: []
  };
}
