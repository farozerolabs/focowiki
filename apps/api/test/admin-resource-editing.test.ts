import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../src/config.js";
import { SourcePathValidationError } from "../src/domain/source-path.js";
import {
  SourceResourceError,
  type ResourceOperationRecord
} from "../src/domain/source-resource.js";
import { createApiApp } from "../src/server.js";
import type { StorageVnextAdminMutationApplication } from
  "../src/storage-vnext/api/admin-mutation-application.js";
import { createPostgresStorageVnextAdminMutation } from
  "../src/storage-vnext/api/postgres-admin-mutation.js";
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
        "if-match": "2",
        "idempotency-key": "metadata-attempt"
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
      }
    });
    expect(context.application.updateKnowledgeBase).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-docs",
      expectedResourceRevision: 2,
      idempotencyKey: "metadata-attempt",
      name: "Updated docs",
      description: "Updated description"
    });
  });

  it("maps invalid knowledge-base metadata fields to a stable validation error", async () => {
    const context = await createApp();
    const response = await context.app.request("/admin/api/knowledge-bases/kb-docs", {
      method: "PATCH",
      headers: withTrustedAdminOrigin({
        cookie: context.cookie,
        "content-type": "application/json",
        "if-match": "2"
      }),
      body: JSON.stringify({ name: null })
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "VALIDATION_ERROR",
        messageKey: "errors.invalidResourceMutation"
      }
    });
    expect(context.application.updateKnowledgeBase).not.toHaveBeenCalled();
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

  it("rejects non-Markdown replacement bodies before invoking the application", async () => {
    const context = await createApp();
    const response = await context.app.request(
      "/admin/api/knowledge-bases/kb-docs/source-files/source-file-intro/content",
      {
        method: "PUT",
        headers: withTrustedAdminOrigin({
          cookie: context.cookie,
          "content-type": "application/json",
          "if-match": "3",
          "idempotency-key": "replace-json"
        }),
        body: JSON.stringify({ content: "# Updated" })
      }
    );

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "UNSUPPORTED_MEDIA_TYPE",
        messageKey: "errors.sourceContentTypeUnsupported"
      }
    });
    expect(context.application.replaceSourceFileContent).not.toHaveBeenCalled();
  });

  it("maps an unsafe replacement path to validation error", async () => {
    const context = await createApp({
      replaceSourceFileContent: vi.fn(async () => {
        throw new SourcePathValidationError("traversal", "../escape.md");
      })
    });
    const response = await context.app.request(
      "/admin/api/knowledge-bases/kb-docs/source-files/source-file-intro/content",
      {
        method: "PUT",
        headers: withTrustedAdminOrigin({
          cookie: context.cookie,
          "content-type": "text/markdown; charset=utf-8",
          "if-match": "3",
          "idempotency-key": "replace-unsafe",
          "x-source-relative-path": "../escape.md"
        }),
        body: "# Updated"
      }
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "VALIDATION_ERROR",
        messageKey: "errors.invalidResourceMutation"
      }
    });
  });

  it("accepts file deletion by stable source identifier", async () => {
    const context = await createApp();
    const response = await context.app.request(
      "/admin/api/knowledge-bases/kb-docs/source-files/source-file-intro",
      {
        method: "DELETE",
        headers: withTrustedAdminOrigin({
          cookie: context.cookie,
          "if-match": "3",
          "idempotency-key": "delete-intro"
        })
      }
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      operation: { operationId: "resource-operation-1", kind: "source_file_delete" },
      deletion: { sourceFileId: "source-file-intro" }
    });
    expect(context.application.deleteSourceFile).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-docs",
      sourceFileId: "source-file-intro",
      expectedResourceRevision: 3,
      idempotencyKey: "delete-intro"
    });
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

  it("rejects an invalid resource operation state", async () => {
    const context = await createApp();
    const response = await context.app.request(
      "/admin/api/knowledge-bases/kb-docs/operations?state=invalid",
      { headers: { cookie: context.cookie } }
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "VALIDATION_ERROR",
        messageKey: "errors.invalidResourceMutation"
      }
    });
    expect(context.application.listOperations).not.toHaveBeenCalled();
  });

  it("uses the shared pagination error contract for invalid resource-list limits", async () => {
    const context = await createApp();
    for (const pathname of [
      "/admin/api/knowledge-bases/kb-docs/operations?limit=0",
      "/admin/api/knowledge-bases/kb-docs/source-directories?limit=0"
    ]) {
      const response = await context.app.request(pathname, {
        headers: { cookie: context.cookie }
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: { code: "INVALID_PAGINATION" }
      });
    }
    expect(context.application.listOperations).not.toHaveBeenCalled();
    expect(context.application.listDirectories).not.toHaveBeenCalled();
  });

  it("maps a rejected operation cursor to the shared pagination error contract", async () => {
    const context = await createApp({
      listOperations: vi.fn(async () => {
        throw new SourceResourceError("INVALID_PAGINATION");
      })
    });
    const response = await context.app.request(
      "/admin/api/knowledge-bases/kb-docs/operations?cursor=invalid",
      { headers: { cookie: context.cookie } }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_PAGINATION" }
    });
  });

  it("maps a rejected directory cursor to the shared pagination error contract", async () => {
    const context = await createApp({
      listDirectories: vi.fn(async () => {
        throw new SourceResourceError("INVALID_PAGINATION");
      })
    });
    const response = await context.app.request(
      "/admin/api/knowledge-bases/kb-docs/source-directories?cursor=invalid",
      { headers: { cookie: context.cookie } }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_PAGINATION" }
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

describe("Admin metadata persistence", () => {
  it("rejects oversized replacements before writing an immutable object", async () => {
    const putVerified = vi.fn();
    const application = createPostgresStorageVnextAdminMutation({
      sql: vi.fn() as never,
      catalog: {} as never,
      resources: {} as never,
      operations: {} as never,
      sourceBodies: {} as never,
      objectWriter: { putVerified } as never,
      runtimeSettings: {} as never,
      maximumSourceBytes: 4
    });

    await expect(application.replaceSourceFileContent({
      knowledgeBaseId: "kb-docs",
      sourceFileId: "source-file-intro",
      expectedResourceRevision: 1,
      idempotencyKey: "oversized",
      bytes: new TextEncoder().encode("12345")
    })).rejects.toMatchObject({ code: "RESOURCE_CONTENT_TOO_LARGE" });
    expect(putVerified).not.toHaveBeenCalled();
  });

  it("replays an accepted replacement before writing another immutable object", async () => {
    const putVerified = vi.fn();
    const getOperation = vi.fn(async () => ({
      id: "source-replace-replay",
      knowledgeBaseId: "kb-docs",
      kind: "source_file_replace" as const,
      state: "processing" as const,
      expectedResourceRevision: 1,
      result: null,
      errorCode: null,
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
      completedAt: null,
      targetKind: "source_file" as const,
      targetId: "source-file-intro",
      candidateRelativePath: "guides/intro.md"
    }));
    const sql = vi.fn(async () => [{
      operation_public_id: "source-replace-replay",
      operation_kind: "source_replace",
      expected_resource_revision: 1,
      target_public_id: "source-file-intro",
      source_revision_public_id: "source-revision-replay",
      checksum_sha256:
        "ba70a2b151e793e3f8b1b68b89acd57b994afc37a40cc9b8ce1e0969636142ca",
      logical_path: "guides/intro.md",
      normalized_path: "guides/intro.md",
      title: "Recovered",
      metadata: {}
    }]);
    const application = createPostgresStorageVnextAdminMutation({
      sql: sql as never,
      catalog: {} as never,
      resources: {} as never,
      operations: { get: getOperation } as never,
      sourceBodies: {} as never,
      objectWriter: { putVerified } as never,
      runtimeSettings: {} as never,
      maximumSourceBytes: 1_000_000
    });

    await expect(application.replaceSourceFileContent({
      knowledgeBaseId: "kb-docs",
      sourceFileId: "source-file-intro",
      expectedResourceRevision: 1,
      idempotencyKey: "replace-replay",
      bytes: new TextEncoder().encode("# Recovered\n\nBody\n"),
      relativePath: "guides/intro.md"
    })).resolves.toMatchObject({
      operation: { id: "source-replace-replay", state: "processing" }
    });
    expect(getOperation).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-docs",
      operationId: "source-replace-replay"
    });
    expect(putVerified).not.toHaveBeenCalled();
  });

  it("reports an existing source with a pending replacement as busy", async () => {
    const putVerified = vi.fn();
    const sql = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        active_source_revision_public_id: "source-revision-active",
        current_source_revision_public_id: "source-revision-pending",
        current_job_state: "processing"
      }]);
    const application = createPostgresStorageVnextAdminMutation({
      sql: sql as never,
      catalog: {} as never,
      resources: {} as never,
      operations: {} as never,
      sourceBodies: {} as never,
      objectWriter: { putVerified } as never,
      runtimeSettings: {} as never,
      maximumSourceBytes: 1_000_000
    });

    await expect(application.replaceSourceFileContent({
      knowledgeBaseId: "kb-docs",
      sourceFileId: "source-file-intro",
      expectedResourceRevision: 2,
      idempotencyKey: "replace-while-processing",
      bytes: new TextEncoder().encode("# Another revision\n")
    })).rejects.toMatchObject({ code: "RESOURCE_BUSY" });
    expect(putVerified).not.toHaveBeenCalled();
  });

  it("returns the metadata row that was durably updated", async () => {
    const updateKnowledgeBase = vi.fn(async () => ({
      publicId: "kb-docs",
      name: "Updated",
      description: "Current",
      revision: 3,
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:01:00.000Z"
    }));
    const application = createPostgresStorageVnextAdminMutation({
      sql: vi.fn(async () => [{ activation_revision: 4 }]) as never,
      catalog: {
        updateKnowledgeBase
      } as never,
      resources: {} as never,
      operations: {} as never,
      sourceBodies: {} as never,
      objectWriter: {} as never,
      runtimeSettings: {
        getSnapshot: vi.fn(async () => ({ worker: { completedJobRetentionDays: 7 } })),
        getCurrentRevision: vi.fn(async () => ({ publicId: "settings-current" }))
      } as never,
      maximumSourceBytes: 1_000_000
    });

    await expect(application.updateKnowledgeBase({
      knowledgeBaseId: "kb-docs",
      expectedResourceRevision: 2,
      name: "Updated",
      idempotencyKey: "metadata-attempt"
    })).resolves.toMatchObject({
      knowledgeBase: {
        id: "kb-docs",
        name: "Updated",
        resourceRevision: 3,
        activeContentRevision: 4
      }
    });
    expect(updateKnowledgeBase).toHaveBeenCalledWith(expect.objectContaining({
      revisionCheck: { expectedRevision: 2 }
    }));
  });
});

async function createApp(
  overrides: Partial<StorageVnextAdminMutationApplication> = {}
) {
  const knowledgeBase = {
    id: "kb-docs",
    name: "Docs",
    description: "Current description",
    resourceRevision: 2,
    activeContentRevision: 1,
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
        activeContentRevision: 2
      }
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
