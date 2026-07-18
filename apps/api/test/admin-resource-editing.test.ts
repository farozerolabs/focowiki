import { createStorageKeyspace } from "../src/storage/keys.js";
import { describe, expect, it, vi } from "vitest";
import type { SourceResourceRepository } from "../src/application/ports/source-resource-repository.js";
import type { RuntimeConfig } from "../src/config.js";
import type { AdminRepositories, KnowledgeBaseRecord } from "../src/db/admin-repositories.js";
import type { PublicationGenerationRepository } from "../src/application/ports/publication-generation-repository.js";
import type { RoleJobRepository } from "../src/application/ports/role-job-repository.js";
import type { ResourceOperationRecord } from "../src/domain/source-resource.js";
import { SourceResourceError } from "../src/domain/source-resource.js";
import { createApiApp } from "../src/server.js";
import type { StorageAdapter } from "../src/storage/s3.js";
import {
  createTestRedisCoordinator,
  loginAndReadSessionCookie,
  withTrustedAdminOrigin
} from "./support/session.js";

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

function operation(overrides: Partial<ResourceOperationRecord> = {}): ResourceOperationRecord {
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

async function createApp(overrides: Partial<SourceResourceRepository> = {}) {
  const knowledgeBase: KnowledgeBaseRecord = {
    id: "kb-docs",
    name: "Docs",
    description: "Current description",
    activeGenerationId: "generation-active",
    resourceRevision: 2,
    catalogGeneration: 1,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z"
  };
  const sourceResources = {
    updateKnowledgeBase: vi.fn(async (input) => ({
      ...knowledgeBase,
      name: input.name ?? knowledgeBase.name,
      description: input.description === undefined ? knowledgeBase.description : input.description,
      resourceRevision: 3,
      catalogGeneration: 2
    })),
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
    getSourceFile: vi.fn(async () => ({
      id: "source-file-intro",
      knowledgeBaseId: "kb-docs",
      directoryId: null,
      name: "intro.md",
      relativePath: "intro.md",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 7,
      checksumSha256: "checksum",
      resourceRevision: 3,
      contentRevision: 1,
      activeRevisionId: "source-revision-1",
      processingStatus: "completed" as const,
      currentStage: "generation_activation" as const,
      terminalFailure: null,
      generatedOutputStatus: "visible" as const,
      generatedPath: "pages/intro.md",
      deleting: false,
      createdAt: "2026-07-12T00:00:00.000Z"
    })),
    getSourceFileContentDescriptor: vi.fn(async () => ({
      objectKey: "tenant/test/source.md",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 7,
      checksumSha256: "checksum",
      contentRevision: 1
    })),
    createOperation: vi.fn(async (input) => ({
      operation: operation({
        kind: input.kind,
        expectedResourceRevision: input.expectedResourceRevision
      }),
      replayed: false
    })),
    prepareOperation: vi.fn(),
    failOperation: vi.fn(async () => ({ operation: null, objectKeys: [] })),
    failSourceFileCandidateOperation: vi.fn(async () => ({ operation: null, objectKeys: [] })),
    getOperation: vi.fn(async () => operation({ state: "processing" })),
    listOperations: vi.fn(async () => ({ items: [operation({ state: "processing" })], nextCursor: null })),
    acceptDirectoryDeletion: vi.fn(),
    acceptSourceFileDeletion: vi.fn(),
    acceptKnowledgeBaseDeletion: vi.fn(),
    ...overrides
  } satisfies SourceResourceRepository;
  const enqueueRoleJob = vi.fn(async () => null);
  const commitMutation = vi.fn(async () => ({
    generationId: "generation-next",
    changeFactCreated: true,
    scheduledPublication: true
  }));
  const roleJobs = { enqueue: enqueueRoleJob } as unknown as RoleJobRepository;
  const publicationGenerations = {
    commitMutation
  } as unknown as PublicationGenerationRepository;
  const storage = {
    keyspace: createStorageKeyspace("tenant/test"),
    getObjectText: vi.fn(async () => "# Intro"),
    getObjectBody: vi.fn(async () => new TextEncoder().encode("# Intro")),
    putObject: vi.fn(async () => undefined),
    deleteObject: vi.fn(async () => undefined)
  } satisfies StorageAdapter;
  const repositories = {
    knowledgeBases: {
      listKnowledgeBases: vi.fn(async () => ({ items: [knowledgeBase], nextCursor: null })),
      createKnowledgeBase: vi.fn(),
      getKnowledgeBase: vi.fn(async () => knowledgeBase)
    },
    sourceResources
  } as unknown as AdminRepositories;
  const app = createApiApp({
    config: createConfig(),
    redis: createTestRedisCoordinator(),
    repositories,
    storage,
    roleJobs,
    publicationGenerations
  });
  const cookie = await loginAndReadSessionCookie(app);
  return {
    app,
    cookie,
    sourceResources,
    storage,
    commitMutation,
    enqueueRoleJob
  };
}

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
      body: JSON.stringify({ name: "Updated docs", description: "Updated description" })
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
    expect(context.commitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: "kb-docs",
        kind: "knowledge_base_metadata_changed",
        resourceRevision: 3
      })
    );
  });

  it("accepts file move and enqueues one durable operation", async () => {
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
    expect(context.enqueueRoleJob).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "source",
        kind: "resource_operation",
        knowledgeBaseId: "kb-docs"
      })
    );
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
    expect(read.headers.get("x-content-revision")).toBe("1");
    expect(replace.status).toBe(202);
    await expect(replace.json()).resolves.toMatchObject({
      operation: { kind: "source_file_replace" }
    });
    expect(context.storage.putObject).toHaveBeenCalledTimes(1);
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
      createOperation: vi.fn(async () => {
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
