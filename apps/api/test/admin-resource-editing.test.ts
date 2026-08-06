import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../src/config.js";
import {
  SourceResourceError,
  type ResourceOperationRecord
} from "../src/domain/source-resource.js";
import { createApiApp } from "../src/server.js";
import type { StorageVnextAdminMutationApplication } from
  "../src/storage-vnext/api/admin-mutation-application.js";
import {
  createTestRedisCoordinator,
  loginAndReadSessionCookie,
  withTrustedAdminOrigin
} from "./support/session.js";

describe("Admin resource editing", () => {
  it("updates knowledge-base metadata with revision protection", async () => {
    const context = await createApp();
    const response = await context.app.request("/admin/api/knowledge-bases/kb-docs", {
      method: "PATCH",
      headers: withTrustedAdminOrigin({
        cookie: context.cookie,
        "content-type": "application/json",
        "if-match": "2"
      }),
      body: JSON.stringify({
        name: "Updated docs",
        description: "Updated description"
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      knowledgeBase: {
        id: "kb-docs",
        name: "Updated docs",
        description: "Updated description",
        resourceRevision: 3
      },
      publicationQueued: true
    });
    expect(context.application.updateKnowledgeBase).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-docs",
      expectedResourceRevision: 2,
      name: "Updated docs",
      description: "Updated description"
    });
  });

  it("accepts file move through one vNext durable operation", async () => {
    const context = await createApp();
    const response = await context.app.request(
      "/admin/api/knowledge-bases/kb-docs/source-files/source-file-intro",
      {
        method: "PATCH",
        headers: withTrustedAdminOrigin({
          cookie: context.cookie,
          "content-type": "application/json",
          "if-match": "3",
          "idempotency-key": "move-intro"
        }),
        body: JSON.stringify({ relativePath: "guides/intro.md" })
      }
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      operation: { operationId: "resource-operation-1", kind: "source_file_move" }
    });
    expect(context.application.moveSourceFile).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-docs",
      targetId: "source-file-intro",
      expectedResourceRevision: 3,
      idempotencyKey: "move-intro",
      relativePath: "guides/intro.md"
    });
  });

  it("reads and replaces original source Markdown", async () => {
    const context = await createApp();
    const read = await context.app.request(
      "/admin/api/knowledge-bases/kb-docs/source-files/source-file-intro/content",
      { headers: { cookie: context.cookie } }
    );
    const replace = await context.app.request(
      "/admin/api/knowledge-bases/kb-docs/source-files/source-file-intro/content",
      {
        method: "PUT",
        headers: withTrustedAdminOrigin({
          cookie: context.cookie,
          "content-type": "text/markdown; charset=utf-8",
          "if-match": "3",
          "idempotency-key": "replace-intro"
        }),
        body: "# Updated"
      }
    );

    expect(read.status).toBe(200);
    await expect(read.text()).resolves.toBe("# Intro");
    expect(read.headers.get("etag")).toBe('"1"');
    expect(read.headers.get("x-content-revision")).toBe("1");
    expect(replace.status).toBe(202);
    await expect(replace.json()).resolves.toMatchObject({
      operation: { kind: "source_file_replace" }
    });
    const request = vi.mocked(context.application.replaceSourceFileContent)
      .mock.calls[0]![0];
    expect(new TextDecoder().decode(request.bytes)).toBe("# Updated");
  });

  it("lists directories and accepts directory moves", async () => {
    const context = await createApp();
    const list = await context.app.request(
      "/admin/api/knowledge-bases/kb-docs/source-directories?parentDirectoryId=root",
      { headers: { cookie: context.cookie } }
    );
    const move = await context.app.request(
      "/admin/api/knowledge-bases/kb-docs/source-directories/source-directory-guides",
      {
        method: "PATCH",
        headers: withTrustedAdminOrigin({
          cookie: context.cookie,
          "content-type": "application/json",
          "if-match": "4",
          "idempotency-key": "move-guides"
        }),
        body: JSON.stringify({ relativePath: "handbook/guides" })
      }
    );

    expect(list.status).toBe(200);
    expect(move.status).toBe(202);
    await expect(move.json()).resolves.toMatchObject({
      operation: { kind: "source_directory_move" }
    });
  });

  it("restores active resource operations", async () => {
    const context = await createApp();
    const response = await context.app.request(
      "/admin/api/knowledge-bases/kb-docs/operations?state=processing",
      { headers: { cookie: context.cookie } }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [{ operationId: "resource-operation-1", state: "processing" }],
      nextCursor: null
    });
  });

  it("returns a stable conflict response when a source resource is busy", async () => {
    const context = await createApp({
      moveSourceFile: vi.fn(async () => {
        throw new SourceResourceError("RESOURCE_BUSY");
      })
    });
    const response = await context.app.request(
      "/admin/api/knowledge-bases/kb-docs/source-files/source-file-intro",
      {
        method: "PATCH",
        headers: withTrustedAdminOrigin({
          cookie: context.cookie,
          "content-type": "application/json",
          "if-match": "3",
          "idempotency-key": "busy-intro"
        }),
        body: JSON.stringify({ relativePath: "guides/intro.md" })
      }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: "RESOURCE_BUSY", messageKey: "errors.resourceBusy" }
    });
  });
});

async function createApp(
  overrides: Partial<StorageVnextAdminMutationApplication> = {}
) {
  const knowledgeBase = {
    id: "kb-docs",
    name: "Docs",
    description: "Current description",
    activeGenerationId: "generation-active",
    resourceRevision: 2,
    catalogGeneration: 1,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z"
  };
  const application: StorageVnextAdminMutationApplication = {
    available: () => true,
    updateKnowledgeBase: vi.fn(async (request) => ({
      knowledgeBase: {
        ...knowledgeBase,
        name: request.name ?? knowledgeBase.name,
        description: request.description === undefined
          ? knowledgeBase.description
          : request.description,
        resourceRevision: 3,
        catalogGeneration: 2
      },
      publicationQueued: true
    })),
    deleteKnowledgeBase: vi.fn(async () => ({
      operation: operation({ kind: "knowledge_base_delete" }),
      affectedDirectoryCount: 0,
      affectedFileCount: 0
    })),
    getKnowledgeBase: vi.fn(async () => knowledgeBase),
    listDirectories: vi.fn(async () => ({ items: [], nextCursor: null })),
    getDirectory: vi.fn(async () => ({
      id: "source-directory-guides",
      knowledgeBaseId: "kb-docs",
      parentDirectoryId: null,
      name: "guides",
      relativePath: "guides",
      depth: 1,
      resourceRevision: 4,
      directFileCount: 1,
      descendantFileCount: 1,
      deleting: false,
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z"
    })),
    listSourceFiles: vi.fn(async () => ({ items: [], nextCursor: null })),
    getSourceFile: vi.fn(async () => null),
    moveSourceDirectory: vi.fn(async () => ({
      operation: operation({ kind: "source_directory_move" })
    })),
    deleteSourceDirectory: vi.fn(async () => ({
      operation: operation({ kind: "source_directory_delete" }),
      effectiveDirectoryId: "source-directory-guides",
      affectedDirectoryCount: 1,
      affectedFileCount: 1
    })),
    readSourceContent: vi.fn(async () => ({
      content: "# Intro",
      contentType: "text/markdown; charset=utf-8",
      resourceRevision: 1,
      contentRevision: 1
    })),
    moveSourceFile: vi.fn(async () => ({
      operation: operation({ kind: "source_file_move" })
    })),
    replaceSourceFileContent: vi.fn(async () => ({
      operation: operation({ kind: "source_file_replace" })
    })),
    deleteSourceFile: vi.fn(async () => ({
      operation: operation({ kind: "source_file_delete" })
    })),
    listOperations: vi.fn(async () => ({
      items: [operation({ state: "processing" })],
      nextCursor: null
    })),
    getOperation: vi.fn(async () => operation({ state: "processing" })),
    ...overrides
  };
  const app = createApiApp({
    config: createConfig(),
    redis: createTestRedisCoordinator(),
    storageVnextAdminMutation: application
  });
  const cookie = await loginAndReadSessionCookie(app);
  return { app, cookie, application };
}

function operation(
  overrides: Partial<ResourceOperationRecord> = {}
): ResourceOperationRecord {
  return {
    id: "resource-operation-1",
    knowledgeBaseId: "kb-docs",
    kind: "source_file_move",
    state: "accepted",
    expectedResourceRevision: 3,
    candidateCatalogGeneration: 2,
    result: null,
    errorCode: null,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    completedAt: null,
    ...overrides
  };
}

function createConfig(): RuntimeConfig {
  return {
    admin: { username: "admin", password: "admin-secret" },
    database: { url: "postgres://test:test@127.0.0.1:5432/test" },
    redis: { url: "redis://127.0.0.1:6379/0" },
    ports: { adminApi: 43_000, adminUi: 43_100, publicOpenApi: 43_200 },
    publicApi: { baseUrl: "https://kb.example.com" },
    storage: {
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "test",
      accessKeyId: "access",
      secretAccessKey: "secret",
      prefix: "tenant/test",
      forcePathStyle: true
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
    model: { enabled: false },
    corsOrigins: []
  };
}
