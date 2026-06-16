import { describe, expect, it } from "vitest";
import { createPublicOpenApiApp } from "../src/server.js";
import type { RuntimeConfig } from "../src/config.js";
import { hashPublicOpenApiKey } from "../src/public-openapi/keys.js";
import { createTestRedisCoordinator } from "./support/session.js";

const publicKey = "fwok_test-public-secret";

const knowledgeBase = {
  id: "kb-001",
  name: "Developer docs",
  description: null,
  activeReleaseId: null,
  createdAt: "2026-06-14T00:00:00.000Z",
  updatedAt: "2026-06-14T00:00:00.000Z"
};

const taskRecord = {
  id: "task-001",
  knowledgeBaseId: "kb-001",
  operation: "upload" as const,
  startedAt: "2026-06-14T00:00:00.000Z",
  sourceCount: 2,
  resultReleaseId: "release-001",
  internalErrorCode: null,
  internalErrorMessage: null,
  createdAt: "2026-06-14T00:00:00.000Z"
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
    publicApiKeys: createPublicApiKeyRepository(publicKey),
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
    files: {
      async listBundleTreeEntries() {
        return { items: [], nextCursor: null };
      },
      async getBundleFile() {
        return null;
      },
      async listSourceFilesForTask() {
        return { items: [], nextCursor: null };
      },
      async listSourceFiles() {
        return { items: [], nextCursor: null };
      },
      async listReleases() {
        return { items: [], nextCursor: null };
      },
      async listBundleFiles() {
        return { items: [], nextCursor: null };
      }
    },
    tasks: {
      async createUploadTask() {
        throw new Error("Not used by public task status tests");
      },
      async getUploadTask(input: { knowledgeBaseId: string; taskId: string }) {
        return input.knowledgeBaseId === "kb-001" && input.taskId === "task-001" && task
          ? {
              ...taskRecord,
              endedAt: task.endedAt,
              phases: [{ phaseKey: "bundle_generation" }]
            }
          : null;
      },
      async listUploadTasks(input: {
        knowledgeBaseId: string;
        limit: number;
        cursor: string | null;
      }) {
        if (input.knowledgeBaseId !== "kb-001" || !task) {
          return { items: [], nextCursor: null };
        }

        return {
          items: [{ ...taskRecord, endedAt: task.endedAt }],
          nextCursor: null
        };
      }
    }
  };
}

function createPublicApiKeyRepository(rawKey: string) {
  const keyHash = hashPublicOpenApiKey(rawKey);

  return {
    async countActivePublicOpenApiKeys() {
      return 1;
    },
    async listPublicOpenApiKeys() {
      return { items: [], nextCursor: null };
    },
    async createPublicOpenApiKey() {
      throw new Error("Not used by public task status tests");
    },
    async findActivePublicOpenApiKeyByHash(candidateHash: string) {
      return candidateHash === keyHash
        ? {
            id: "openapi-key-test",
            name: "Test key",
            keyHash,
            keyPrefix: rawKey.slice(0, 10),
            keySuffix: rawKey.slice(-6),
            status: "active" as const,
            createdAt: "2026-06-14T00:00:00.000Z",
            lastUsedAt: null,
            revokedAt: null
          }
        : null;
    },
    async revokePublicOpenApiKey() {
      return null;
    },
    async updatePublicOpenApiKeyLastUsed() {
      return undefined;
    }
  };
}

describe("Developer upload task status OpenAPI", () => {
  it("returns unified running task lifecycle without internal phases", async () => {
    const app = createPublicOpenApiApp({
      config: createConfig(),
      repositories: createRepositories({ endedAt: null }),
      redis: createTestRedisCoordinator()
    });
    const response = await app.request("/openapi/v1/knowledge-bases/kb-001/tasks", {
      headers: {
        authorization: `Bearer ${publicKey}`
      }
    });
    const body = (await response.json()) as { items: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.items[0]).toMatchObject({
      knowledgeBaseId: "kb-001",
      taskId: "task-001",
      startedAt: "2026-06-14T00:00:00.000Z",
      endedAt: null,
      lifecycle: "running"
    });
    expect(body.items[0]).not.toHaveProperty("phases");
    expect(body.items[0]).not.toHaveProperty("phaseKey");
  });

  it("returns latest unified ended task lifecycle", async () => {
    const app = createPublicOpenApiApp({
      config: createConfig(),
      repositories: createRepositories({ endedAt: "2026-06-14T00:01:00.000Z" }),
      redis: createTestRedisCoordinator()
    });
    const response = await app.request("/openapi/v1/knowledge-bases/kb-001/tasks/task-001", {
      headers: {
        authorization: `Bearer ${publicKey}`
      }
    });

    await expect(response.json()).resolves.toMatchObject({
      task: {
        endedAt: "2026-06-14T00:01:00.000Z",
        lifecycle: "ended"
      }
    });
    expect(response.status).toBe(200);
  });

  it("protects task status and returns not found when missing", async () => {
    const app = createPublicOpenApiApp({
      config: createConfig(),
      repositories: createRepositories(null),
      redis: createTestRedisCoordinator()
    });
    const path = "/openapi/v1/knowledge-bases/kb-001/tasks/task-001";
    const missingAuth = await app.request(path);
    const wrongAuth = await app.request(path, {
      headers: {
        authorization: "Bearer wrong"
      }
    });
    const missingTask = await app.request(path, {
      headers: {
        authorization: `Bearer ${publicKey}`
      }
    });

    expect(missingAuth.status).toBe(401);
    expect(wrongAuth.status).toBe(401);
    expect(missingTask.status).toBe(404);
  });
});
