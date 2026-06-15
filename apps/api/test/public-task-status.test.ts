import { describe, expect, it } from "vitest";
import { createPublicOpenApiApp } from "../src/server.js";
import type { RuntimeConfig } from "../src/config.js";

const knowledgeBase = {
  id: "kb-001",
  name: "Developer docs",
  description: null,
  activeReleaseId: null,
  createdAt: "2026-06-14T00:00:00.000Z",
  updatedAt: "2026-06-14T00:00:00.000Z"
};

function createConfig(): RuntimeConfig {
  return {
    admin: {
      username: "admin",
      password: "admin-secret",
      sessionSecret: "session-secret"
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
      baseUrl: "https://kb.example.com",
      authRequired: true,
      apiKey: "public-secret"
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
      taskConcurrency: 1,
      fileProcessingConcurrency: 1
    },
    pagination: {
      defaultPageSize: 50,
      maxPageSize: 200,
      cursorTtlSeconds: 900
    },
    model: {
      enabled: false
    },
    corsOrigins: []
  };
}

function createRepositories(task: { endedAt: string | null } | null) {
  return {
    knowledgeBases: {
      async listKnowledgeBases() {
        return { items: [knowledgeBase], nextCursor: null };
      },
      async createKnowledgeBase() {
        return knowledgeBase;
      },
      async getKnowledgeBase(id: string) {
        return id === knowledgeBase.id ? knowledgeBase : null;
      }
    },
    tasks: {
      async createUploadTask() {
        throw new Error("Not used by public task status tests");
      },
      async getLatestUploadTask(knowledgeBaseId: string) {
        return knowledgeBaseId === "kb-001" && task
          ? {
              id: "task-001",
              knowledgeBaseId,
              startedAt: "2026-06-14T00:00:00.000Z",
              endedAt: task.endedAt,
              sourceCount: 2,
              resultReleaseId: "release-001",
              internalErrorCode: null,
              internalErrorMessage: null,
              createdAt: "2026-06-14T00:00:00.000Z",
              phases: [{ phaseKey: "bundle_generation" }]
            }
          : null;
      }
    }
  };
}

describe("Public upload task status OpenAPI", () => {
  it("returns latest unified running task lifecycle without internal phases", async () => {
    const app = createPublicOpenApiApp({
      config: createConfig(),
      repositories: createRepositories({ endedAt: null })
    });
    const response = await app.request("/kb/kb-001/tasks/latest", {
      headers: {
        authorization: "Bearer public-secret"
      }
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      knowledgeBaseId: "kb-001",
      taskId: "task-001",
      startedAt: "2026-06-14T00:00:00.000Z",
      endedAt: null,
      lifecycle: "running"
    });
    expect(body).not.toHaveProperty("phases");
    expect(body).not.toHaveProperty("phaseKey");
  });

  it("returns latest unified ended task lifecycle", async () => {
    const app = createPublicOpenApiApp({
      config: createConfig(),
      repositories: createRepositories({ endedAt: "2026-06-14T00:01:00.000Z" })
    });
    const response = await app.request("/kb/kb-001/tasks/latest", {
      headers: {
        authorization: "Bearer public-secret"
      }
    });

    await expect(response.json()).resolves.toMatchObject({
      endedAt: "2026-06-14T00:01:00.000Z",
      lifecycle: "ended"
    });
    expect(response.status).toBe(200);
  });

  it("protects latest task status and returns not found when missing", async () => {
    const app = createPublicOpenApiApp({
      config: createConfig(),
      repositories: createRepositories(null)
    });
    const missingAuth = await app.request("/kb/kb-001/tasks/latest");
    const wrongAuth = await app.request("/kb/kb-001/tasks/latest", {
      headers: {
        authorization: "Bearer wrong"
      }
    });
    const missingTask = await app.request("/kb/kb-001/tasks/latest", {
      headers: {
        authorization: "Bearer public-secret"
      }
    });

    expect(missingAuth.status).toBe(401);
    expect(wrongAuth.status).toBe(401);
    expect(missingTask.status).toBe(404);
  });
});
