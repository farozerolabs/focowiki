import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../src/config.js";
import { createApiApp } from "../src/server.js";
import type { StorageVnextAdminSourceApplication } from
  "../src/storage-vnext/api/admin-source-application.js";
import { createPostgresStorageVnextAdminSource } from
  "../src/storage-vnext/api/postgres-admin-source.js";
import {
  createTestRedisCoordinator,
  loginAndReadSessionCookie,
  withTrustedAdminOrigin
} from "./support/session.js";

const knowledgeBase = {
  id: "kb-001",
  name: "Developer docs",
  description: null,
  activeGenerationId: "generation-001",
  createdAt: "2026-06-14T00:00:00.000Z",
  updatedAt: "2026-06-14T00:00:00.000Z"
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

describe("source file task deletion Admin API", () => {
  it("maps internal deletion outcomes to the released Admin response fields", async () => {
    const application = createPostgresStorageVnextAdminSource({
      catalog: {
        getKnowledgeBase: vi.fn(async () => ({ publicId: knowledgeBase.id }))
      } as never,
      workflow: {} as never,
      deletion: {
        deleteSourceTasks: vi.fn(async () => [{
          sourceFilePublicId: "source-file-11111111-1111-4111-8111-111111111111",
          outcome: "hidden" as const,
          generatedFilePublicId: "generated-file-1",
          generatedFilePath: "pages/guide.md"
        }])
      } as never,
      runtimeSettings: {
        getCurrentRevision: vi.fn(async () => ({ publicId: "settings-1" }))
      } as never
    });

    await expect(application.deleteSourceFileTasks({
      knowledgeBaseId: knowledgeBase.id,
      sourceFileIds: ["source-file-11111111-1111-4111-8111-111111111111"]
    })).resolves.toEqual({
      ok: true,
      value: {
        results: [{
          sourceFileId: "source-file-11111111-1111-4111-8111-111111111111",
          status: "hidden",
          generatedFileId: "generated-file-1",
          generatedFilePath: "pages/guide.md"
        }],
        summary: { deleted: 0, hidden: 1, skipped: 0 }
      }
    });
  });

  it("deletes selected source-file tasks through explicit current-page IDs", async () => {
    const deleteTasks = vi.fn(async () => ({
      ok: true as const,
      value: {
        results: [
          {
            sourceFileId: "source-file-11111111-1111-4111-8111-111111111111",
            status: "hidden"
          }
        ],
        summary: {
          deleted: 0,
          hidden: 1,
          skipped: 0
        }
      }
    }));
    const app = createApiApp({
      config: createConfig(),
      redis: createTestRedisCoordinator(),
      storageVnextAdminSource: createSourceApplication(deleteTasks)
    });
    const cookie = await loginAndReadSessionCookie(app);
    const response = await app.request(
      `/admin/api/knowledge-bases/${knowledgeBase.id}/source-files/task-deletions`,
      {
        method: "POST",
        headers: withTrustedAdminOrigin({
          cookie,
          "content-type": "application/json"
        }),
        body: JSON.stringify({
          sourceFileIds: ["source-file-11111111-1111-4111-8111-111111111111"]
        })
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      results: [
        {
          sourceFileId: "source-file-11111111-1111-4111-8111-111111111111",
          status: "hidden"
        }
      ],
      summary: {
        deleted: 0,
        hidden: 1,
        skipped: 0
      }
    });
    expect(deleteTasks).toHaveBeenCalledWith({
      knowledgeBaseId: knowledgeBase.id,
      sourceFileIds: ["source-file-11111111-1111-4111-8111-111111111111"]
    });
  });

  it("rejects malformed deletion requests without partial mutation", async () => {
    const deleteTasks = vi.fn();
    const app = createApiApp({
      config: createConfig(),
      redis: createTestRedisCoordinator(),
      storageVnextAdminSource: createSourceApplication(deleteTasks)
    });
    const cookie = await loginAndReadSessionCookie(app);
    const response = await app.request(
      `/admin/api/knowledge-bases/${knowledgeBase.id}/source-files/task-deletions`,
      {
        method: "POST",
        headers: withTrustedAdminOrigin({
          cookie,
          "content-type": "application/json"
        }),
        body: JSON.stringify({
          sourceFileIds: ["source-file-11111111-1111-4111-8111-111111111111", 123]
        })
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_SOURCE_FILE_TASK_DELETION_ID",
        messageKey: "errors.sourceFileTaskDeletionInvalid"
      }
    });
    expect(deleteTasks).not.toHaveBeenCalled();
  });
});

function createSourceApplication(
  deleteSourceFileTasks: StorageVnextAdminSourceApplication["deleteSourceFileTasks"]
): StorageVnextAdminSourceApplication {
  return {
    async retrySourceFile() {
      return { ok: false, code: "DATABASE_REPOSITORY_UNAVAILABLE" };
    },
    deleteSourceFileTasks
  };
}
