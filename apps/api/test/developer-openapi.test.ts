import { describe, expect, it } from "vitest";
import { createAdminApiApp, createPublicOpenApiApp } from "../src/server.js";
import type {
  AdminRepositories,
  BundleFileRecord,
  BundleTreeEntryRecord,
  KnowledgeBaseRecord,
  SourceFileRecord,
  UploadTaskEventRecord,
  UploadTaskRecord,
  WebhookDeliveryRecord,
  WebhookSubscriptionRecord
} from "../src/db/admin-repositories.js";
import { hashPublicOpenApiKey } from "../src/public-openapi/keys.js";
import { createStorageKeyspace } from "../src/storage/keys.js";
import type { StorageAdapter, StoredObject } from "../src/storage/s3.js";
import type { RuntimeConfig } from "../src/config.js";
import { createTestRedisCoordinator } from "./support/session.js";

const developerKey = "fwok_developer-openapi-test-key";
const now = "2026-06-16T00:00:00.000Z";
const forbiddenHealthKeys = new Set([
  "apiVersion",
  "version",
  "authenticated",
  "database",
  "redis",
  "s3",
  "model",
  "routes",
  "deployment"
]);

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

class MemoryStorage implements StorageAdapter {
  public readonly keyspace = createStorageKeyspace("tenant/demo");
  public readonly objects = new Map<string, string>([
    [
      "tenant/demo/knowledge-bases/kb-seeded/releases/release-seeded/bundle/index.md",
      "# Seeded KB"
    ],
    [
      "tenant/demo/knowledge-bases/kb-seeded/releases/release-seeded/bundle/pages/guide.md",
      "---\ntype: page\ntitle: Guide\n---\n# Guide"
    ],
    [
      "tenant/demo/knowledge-bases/kb-seeded/releases/release-seeded/bundle/_index/search.json",
      JSON.stringify({ items: [{ path: "pages/guide.md", title: "Guide" }] })
    ]
  ]);

  public async putObject(object: StoredObject): Promise<void> {
    this.objects.set(
      object.key,
      typeof object.body === "string" ? object.body : new TextDecoder().decode(object.body)
    );
  }

  public async getObjectText(key: string): Promise<string | null> {
    return this.objects.get(key) ?? null;
  }

  public async getObjectBody(key: string): Promise<BodyInit | null> {
    const value = this.objects.get(key);
    return value ? new Blob([value]) : null;
  }

  public async writeCurrentPointer(): Promise<void> {
    throw new Error("Not used by Developer OpenAPI tests");
  }

  public async readCurrentPointer(): Promise<null> {
    return null;
  }
}

function createRepositories(): AdminRepositories & {
  deletedKnowledgeBaseIds: Set<string>;
  webhookDeliveries: Map<string, WebhookDeliveryRecord>;
} {
  const keyHash = hashPublicOpenApiKey(developerKey);
  const knowledgeBases = new Map<string, KnowledgeBaseRecord>([
    [
      "kb-seeded",
      {
        id: "kb-seeded",
        name: "Seeded KB",
        description: null,
        activeReleaseId: "release-seeded",
        createdAt: now,
        updatedAt: now
      }
    ]
  ]);
  const deletedKnowledgeBaseIds = new Set<string>();
  const sourceFiles = new Map<string, SourceFileRecord>([
    [
      "source-guide",
      {
        id: "source-guide",
        knowledgeBaseId: "kb-seeded",
        taskId: "task-seeded",
        originalName: "guide.md",
        objectKey: "tenant/demo/knowledge-bases/kb-seeded/uploads/task-seeded/sources/source-guide/guide.md",
        contentType: "text/markdown; charset=utf-8",
        sizeBytes: 41,
        checksumSha256: "checksum",
        metadata: {},
        processingStatus: "completed",
        processingStage: "release_activation",
        processingStartedAt: now,
        processingEndedAt: now,
        processingErrorCode: null,
        createdAt: now,
        deletedAt: null
      }
    ]
  ]);
  const bundleFiles = new Map<string, BundleFileRecord>([
    [
      "bundle-index",
      {
        id: "bundle-index",
        knowledgeBaseId: "kb-seeded",
        releaseId: "release-seeded",
        sourceFileId: null,
        fileKind: "index",
        logicalPath: "index.md",
        objectKey: "tenant/demo/knowledge-bases/kb-seeded/releases/release-seeded/bundle/index.md",
        contentType: "text/markdown; charset=utf-8",
        sizeBytes: 12,
        checksumSha256: "checksum",
        okfType: null,
        title: null,
        description: null,
        tags: [],
        frontmatter: {}
      }
    ],
    [
      "bundle-guide",
      {
        id: "bundle-guide",
        knowledgeBaseId: "kb-seeded",
        releaseId: "release-seeded",
        sourceFileId: "source-guide",
        fileKind: "page",
        logicalPath: "pages/guide.md",
        objectKey: "tenant/demo/knowledge-bases/kb-seeded/releases/release-seeded/bundle/pages/guide.md",
        contentType: "text/markdown; charset=utf-8",
        sizeBytes: 41,
        checksumSha256: "checksum",
        okfType: "page",
        title: "Guide",
        description: null,
        tags: [],
        frontmatter: { type: "page", title: "Guide" }
      }
    ],
    [
      "bundle-search",
      {
        id: "bundle-search",
        knowledgeBaseId: "kb-seeded",
        releaseId: "release-seeded",
        sourceFileId: null,
        fileKind: "search_index",
        logicalPath: "_index/search.json",
        objectKey: "tenant/demo/knowledge-bases/kb-seeded/releases/release-seeded/bundle/_index/search.json",
        contentType: "application/json; charset=utf-8",
        sizeBytes: 49,
        checksumSha256: "checksum",
        okfType: null,
        title: null,
        description: null,
        tags: [],
        frontmatter: {}
      }
    ]
  ]);
  const treeEntries: BundleTreeEntryRecord[] = [
    {
      id: "tree-index",
      knowledgeBaseId: "kb-seeded",
      releaseId: "release-seeded",
      parentPath: "",
      name: "index.md",
      logicalPath: "index.md",
      entryType: "file",
      bundleFileId: "bundle-index",
      sourceFileId: null,
      fileKind: "index"
    },
    {
      id: "tree-pages",
      knowledgeBaseId: "kb-seeded",
      releaseId: "release-seeded",
      parentPath: "",
      name: "pages",
      logicalPath: "pages",
      entryType: "directory",
      bundleFileId: null,
      sourceFileId: null,
      fileKind: null
    },
    {
      id: "tree-guide",
      knowledgeBaseId: "kb-seeded",
      releaseId: "release-seeded",
      parentPath: "pages",
      name: "guide.md",
      logicalPath: "pages/guide.md",
      entryType: "file",
      bundleFileId: "bundle-guide",
      sourceFileId: "source-guide",
      fileKind: "page"
    }
  ];
  const tasks = new Map<string, UploadTaskRecord>([
    [
      "task-seeded",
      {
        id: "task-seeded",
        knowledgeBaseId: "kb-seeded",
        operation: "upload",
        startedAt: now,
        endedAt: now,
        sourceCount: 1,
        resultReleaseId: "release-seeded",
        internalErrorCode: null,
        internalErrorMessage: null,
        createdAt: now,
        progress: {
          total: 1,
          completed: 1,
          failed: 0,
          running: 0,
          pending: 0,
          currentStage: "release_activation"
        }
      }
    ]
  ]);
  const webhooks = new Map<string, WebhookSubscriptionRecord>();
  const webhookDeliveries = new Map<string, WebhookDeliveryRecord>();

  return {
    deletedKnowledgeBaseIds,
    webhookDeliveries,
    publicApiKeys: {
      async countActivePublicOpenApiKeys() {
        return 1;
      },
      async listPublicOpenApiKeys() {
        return { items: [], nextCursor: null };
      },
      async createPublicOpenApiKey() {
        throw new Error("Not used by Developer OpenAPI tests");
      },
      async findActivePublicOpenApiKeyByHash(candidateHash: string) {
        return candidateHash === keyHash
          ? {
              id: "openapi-key-developer",
              name: "Developer key",
              keyHash,
              keyPrefix: developerKey.slice(0, 10),
              keySuffix: developerKey.slice(-6),
              status: "active",
              createdAt: now,
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
    },
    knowledgeBases: {
      async listKnowledgeBases({ limit, cursor }) {
        const items = Array.from(knowledgeBases.values()).filter(
          (item) => !deletedKnowledgeBaseIds.has(item.id)
        );
        const offset = cursor ? Number(cursor) : 0;
        const pageItems = items.slice(offset, offset + limit);
        const nextOffset = offset + pageItems.length;
        return {
          items: pageItems,
          nextCursor: nextOffset < items.length ? String(nextOffset) : null
        };
      },
      async createKnowledgeBase(input) {
        const id = "kb-created";
        const record = {
          id,
          name: input.name,
          description: input.description,
          activeReleaseId: null,
          createdAt: now,
          updatedAt: now
        };
        knowledgeBases.set(id, record);
        return record;
      },
      async getKnowledgeBase(id) {
        return deletedKnowledgeBaseIds.has(id) ? null : knowledgeBases.get(id) ?? null;
      },
      async softDeleteKnowledgeBase({ id }) {
        if (!knowledgeBases.has(id) || deletedKnowledgeBaseIds.has(id)) {
          return false;
        }

        deletedKnowledgeBaseIds.add(id);
        return true;
      }
    },
    files: {
      async createSourceFiles(files) {
        for (const file of files) {
          sourceFiles.set(file.id, {
            ...file,
            processingStatus: file.processingStatus ?? "pending",
            processingStage: file.processingStage ?? "upload_storage",
            processingStartedAt: file.processingStartedAt ?? now,
            processingEndedAt: file.processingEndedAt ?? null,
            processingErrorCode: file.processingErrorCode ?? null,
            createdAt: now,
            deletedAt: null
          });
        }
      },
      async createRelease() {
        return undefined;
      },
      async createBundleFiles(files) {
        for (const file of files) {
          bundleFiles.set(file.id, file);
        }
      },
      async createBundleTreeEntries(entries) {
        treeEntries.push(
          ...entries.map((entry) => ({
            ...entry,
            sourceFileId: null,
            fileKind: null
          }))
        );
      },
      async activateRelease() {
        return undefined;
      },
      async listSourceFilesForTask({ knowledgeBaseId, taskId, limit, cursor }) {
        const items = Array.from(sourceFiles.values()).filter(
          (item) =>
            item.knowledgeBaseId === knowledgeBaseId &&
            item.taskId === taskId &&
            item.deletedAt === null
        );
        const offset = cursor ? Number(cursor) : 0;
        return {
          items: items.slice(offset, offset + limit),
          nextCursor: offset + limit < items.length ? String(offset + limit) : null
        };
      },
      async updateSourceFileProcessingState() {
        return undefined;
      },
      async listBundleTreeEntries({ knowledgeBaseId, releaseId, parentPath, limit, cursor }) {
        const items = treeEntries.filter(
          (item) =>
            item.knowledgeBaseId === knowledgeBaseId &&
            item.releaseId === releaseId &&
            item.parentPath === parentPath
        );
        const offset = cursor ? Number(cursor) : 0;
        return {
          items: items.slice(offset, offset + limit),
          nextCursor: offset + limit < items.length ? String(offset + limit) : null
        };
      },
      async getBundleFile({ knowledgeBaseId, releaseId, logicalPath }) {
        return (
          Array.from(bundleFiles.values()).find(
            (file) =>
              file.knowledgeBaseId === knowledgeBaseId &&
              file.releaseId === releaseId &&
              file.logicalPath === logicalPath
          ) ?? null
        );
      },
      async listSourceFiles({ knowledgeBaseId, limit, cursor }) {
        const items = Array.from(sourceFiles.values()).filter(
          (item) => item.knowledgeBaseId === knowledgeBaseId && item.deletedAt === null
        );
        const offset = cursor ? Number(cursor) : 0;
        return {
          items: items.slice(offset, offset + limit),
          nextCursor: offset + limit < items.length ? String(offset + limit) : null
        };
      },
      async listReleases() {
        return { items: [], nextCursor: null };
      },
      async listBundleFiles({ knowledgeBaseId, releaseId, limit, cursor }) {
        const items = Array.from(bundleFiles.values()).filter(
          (item) => item.knowledgeBaseId === knowledgeBaseId && item.releaseId === releaseId
        );
        const offset = cursor ? Number(cursor) : 0;
        return {
          items: items.slice(offset, offset + limit),
          nextCursor: offset + limit < items.length ? String(offset + limit) : null
        };
      },
      async softDeleteSourceFile({ sourceFileId }) {
        const source = sourceFiles.get(sourceFileId);

        if (!source || source.deletedAt) {
          return false;
        }

        source.deletedAt = now;
        return true;
      }
    },
    tasks: {
      async createUploadTask({ knowledgeBaseId, sourceCount, operation }) {
        const task = {
          id: `task-${tasks.size + 1}`,
          knowledgeBaseId,
          operation: operation ?? "upload",
          startedAt: now,
          endedAt: null,
          sourceCount,
          resultReleaseId: null,
          internalErrorCode: null,
          internalErrorMessage: null,
          createdAt: now
        };
        tasks.set(task.id, task);
        return task;
      },
      async completeUploadTask({ knowledgeBaseId, taskId, endedAt, resultReleaseId }) {
        const task = tasks.get(taskId);

        if (!task || task.knowledgeBaseId !== knowledgeBaseId) {
          throw new Error("Task does not exist");
        }

        task.endedAt = endedAt;
        task.resultReleaseId = resultReleaseId;
        return task;
      },
      async createUploadTaskEvent(input) {
        return {
          id: "event-test",
          taskId: input.taskId,
          phaseKey: input.phaseKey,
          messageKey: input.messageKey,
          startedAt: input.startedAt,
          endedAt: input.endedAt,
          severity: input.severity,
          createdAt: now
        };
      },
      async getUploadTask({ knowledgeBaseId, taskId }) {
        const task = tasks.get(taskId);
        return task?.knowledgeBaseId === knowledgeBaseId ? task : null;
      },
      async getLatestUploadTask(knowledgeBaseId) {
        return (
          Array.from(tasks.values()).find((item) => item.knowledgeBaseId === knowledgeBaseId) ??
          null
        );
      },
      async listUploadTasks({ knowledgeBaseId, limit, cursor }) {
        const items = Array.from(tasks.values()).filter(
          (item) => item.knowledgeBaseId === knowledgeBaseId
        );
        const offset = cursor ? Number(cursor) : 0;
        return {
          items: items.slice(offset, offset + limit),
          nextCursor: offset + limit < items.length ? String(offset + limit) : null
        };
      },
      async listUploadTaskEvents(): Promise<{ items: UploadTaskEventRecord[]; nextCursor: null }> {
        return { items: [], nextCursor: null };
      }
    },
    webhooks: {
      async createWebhookSubscription(input) {
        const webhook = {
          ...input,
          enabled: true,
          updatedAt: input.createdAt,
          lastDeliveryAt: null
        };
        webhooks.set(webhook.id, webhook);
        return webhook;
      },
      async listWebhookSubscriptions({ limit, cursor }) {
        const items = Array.from(webhooks.values()).filter((webhook) => webhook.enabled);
        const offset = cursor ? Number(cursor) : 0;
        return {
          items: items.slice(offset, offset + limit),
          nextCursor: offset + limit < items.length ? String(offset + limit) : null
        };
      },
      async getWebhookSubscription(id) {
        const webhook = webhooks.get(id);
        return webhook?.enabled ? webhook : null;
      },
      async deleteWebhookSubscription({ id, updatedAt }) {
        const webhook = webhooks.get(id);

        if (!webhook || !webhook.enabled) {
          return false;
        }

        webhooks.set(id, { ...webhook, enabled: false, updatedAt });
        return true;
      },
      async createWebhookDelivery(input) {
        const delivery = {
          ...input,
          updatedAt: input.createdAt
        };
        webhookDeliveries.set(delivery.id, delivery);
        return delivery;
      },
      async updateWebhookDeliveryResult(input) {
        const delivery = webhookDeliveries.get(input.id);

        if (!delivery) {
          return null;
        }

        const updated = { ...delivery, ...input };
        webhookDeliveries.set(input.id, updated);
        return updated;
      },
      async listWebhookDeliveries({ limit, cursor }) {
        const items = Array.from(webhookDeliveries.values());
        const offset = cursor ? Number(cursor) : 0;
        return {
          items: items.slice(offset, offset + limit),
          nextCursor: offset + limit < items.length ? String(offset + limit) : null
        };
      },
      async getWebhookDelivery(deliveryId) {
        return webhookDeliveries.get(deliveryId) ?? null;
      }
    }
  };
}

function createApp() {
  const repositories = createRepositories();
  const app = createPublicOpenApiApp({
    config: createConfig(),
    storage: new MemoryStorage(),
    redis: createTestRedisCoordinator(),
    repositories
  });

  return { app, repositories };
}

function authHeaders(extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${developerKey}`,
    ...extra
  };
}

async function expectOpenApiError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body).toMatchObject({
    error: {
      code,
      httpStatus: status,
      message: expect.any(String)
    },
    requestId: expect.any(String)
  });
  return body;
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") {
    return keys;
  }

  for (const [key, nested] of Object.entries(value)) {
    keys.add(key);
    collectKeys(nested, keys);
  }

  return keys;
}

describe("Developer OpenAPI", () => {
  it("requires bearer authentication for metadata endpoints", async () => {
    const { app } = createApp();

    for (const path of ["/openapi/v1/version", "/openapi/v1/openapi.json"]) {
      await expectOpenApiError(await app.request(path), 401, "UNAUTHORIZED");
    }

    const healthBody = await expectOpenApiError(
      await app.request("/openapi/v1/health"),
      401,
      "UNAUTHORIZED"
    );

    expect(healthBody).not.toMatchObject({ status: "ok" });
    expect([...collectKeys(healthBody)].filter((key) => forbiddenHealthKeys.has(key))).toEqual([]);
  });

  it("serves authenticated metadata and documents the reusable identifiers", async () => {
    const { app } = createApp();
    const health = await app.request("/openapi/v1/health", { headers: authHeaders() });
    const version = await app.request("/openapi/v1/version", { headers: authHeaders() });
    const openapi = await app.request("/openapi/v1/openapi.json", { headers: authHeaders() });
    const openapiBody = (await openapi.json()) as Record<string, unknown>;

    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: "ok" });
    expect(version.status).toBe(200);
    await expect(version.json()).resolves.toMatchObject({ apiVersion: "v1" });
    expect(openapi.status).toBe(200);
    expect(JSON.stringify(openapiBody)).toContain("knowledgeBaseId");
    expect(JSON.stringify(openapiBody)).toContain("taskId");
    expect(JSON.stringify(openapiBody)).toContain("fileId");
  });

  it("keeps product-owned health probes health-state-only", async () => {
    const { app } = createApp();
    const adminApp = createAdminApiApp({ config: createConfig() });
    const publicHealth = await app.request("/healthz");
    const adminHealth = await adminApp.request("/healthz");
    const developerHealth = await app.request("/openapi/v1/health", { headers: authHeaders() });
    const bodies = [
      await publicHealth.json(),
      await adminHealth.json(),
      await developerHealth.json()
    ] as Array<Record<string, unknown>>;

    expect(publicHealth.status).toBe(200);
    expect(adminHealth.status).toBe(200);
    expect(developerHealth.status).toBe(200);
    expect(bodies).toEqual([{ status: "ok" }, { status: "ok" }, { status: "ok" }]);
    for (const body of bodies) {
      expect([...collectKeys(body)].filter((key) => forbiddenHealthKeys.has(key))).toEqual([]);
    }
  });

  it("requires bearer authentication for every workflow route before resource lookup", async () => {
    const { app } = createApp();
    const routes = [
      ["/openapi/v1/knowledge-bases", "GET"],
      ["/openapi/v1/knowledge-bases/kb-missing", "GET"],
      ["/openapi/v1/knowledge-bases/kb-missing/uploads", "POST"],
      ["/openapi/v1/knowledge-bases/kb-missing/tasks", "GET"],
      ["/openapi/v1/knowledge-bases/kb-missing/tree", "GET"],
      ["/openapi/v1/webhooks", "GET"],
      ["/openapi/v1/unsupported", "GET"]
    ] as const;

    for (const [path, method] of routes) {
      await expectOpenApiError(await app.request(path, { method }), 401, "UNAUTHORIZED");
    }
  });

  it("does not expose OpenAPI key lifecycle endpoints through Developer OpenAPI", async () => {
    const { app } = createApp();

    for (const [path, method] of [
      ["/openapi/v1/openapi-keys", "GET"],
      ["/openapi/v1/openapi-keys", "POST"],
      ["/openapi/v1/openapi-keys/openapi-key-developer", "DELETE"]
    ] as const) {
      await expectOpenApiError(
        await app.request(path, { method, headers: authHeaders() }),
        404,
        "UNSUPPORTED_ROUTE"
      );
    }
  });

  it("keeps reusable identifiers continuous across knowledge base, task, file, and deletion calls", async () => {
    const { app, repositories } = createApp();
    const create = await app.request("/openapi/v1/knowledge-bases", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ name: "Created KB", description: "Created through OpenAPI" })
    });
    const createBody = (await create.json()) as {
      knowledgeBase: { knowledgeBaseId: string };
    };
    const knowledgeBaseId = createBody.knowledgeBase.knowledgeBaseId;

    expect(create.status).toBe(201);
    expect(knowledgeBaseId).toBe("kb-created");

    const webhook = await app.request("/openapi/v1/webhooks", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "Progress",
        url: "https://127.0.0.1:9/webhook",
        events: ["task.progress"]
      })
    });

    expect(webhook.status).toBe(201);

    const uploadForm = new FormData();
    uploadForm.append(
      "files",
      new File(["---\ntype: page\ntitle: Intro\n---\n# Intro"], "intro.md", {
        type: "text/markdown"
      })
    );
    const upload = await app.request(`/openapi/v1/knowledge-bases/${knowledgeBaseId}/uploads`, {
      method: "POST",
      headers: authHeaders(),
      body: uploadForm
    });
    const uploadBody = (await upload.json()) as {
      knowledgeBaseId: string;
      taskId: string;
      files: Array<{ fileId: string; originalFilename: string }>;
    };

    expect(upload.status).toBe(202);
    expect(uploadBody.knowledgeBaseId).toBe(knowledgeBaseId);
    expect(uploadBody.taskId).toMatch(/^task-/);
    expect(uploadBody.files[0]).toMatchObject({
      fileId: expect.stringMatching(/^source-file-/),
      originalFilename: "intro.md"
    });

    const task = await app.request(
      `/openapi/v1/knowledge-bases/${knowledgeBaseId}/tasks/${uploadBody.taskId}`,
      { headers: authHeaders() }
    );
    const taskBody = (await task.json()) as {
      task: { taskId: string };
      files: { items: Array<{ fileId: string }> };
    };

    expect(task.status).toBe(200);
    expect(taskBody.task.taskId).toBe(uploadBody.taskId);
    expect(taskBody.files.items[0]?.fileId).toBe(uploadBody.files[0]?.fileId);

    const progressDelivery = Array.from(repositories.webhookDeliveries.values()).find(
      (delivery) => delivery.eventType === "task.progress"
    );

    expect(progressDelivery?.payload).toMatchObject({
      knowledgeBaseId,
      taskId: uploadBody.taskId,
      operation: "upload",
      sourceFileIds: [uploadBody.files[0]?.fileId],
      status: expect.any(String),
      stage: expect.any(String)
    });
  });

  it("supports generated file lookup, content reads, and deletion by returned fileId", async () => {
    const { app } = createApp();
    const tree = await app.request("/openapi/v1/knowledge-bases/kb-seeded/tree?parentPath=pages", {
      headers: authHeaders()
    });
    const treeBody = (await tree.json()) as {
      items: Array<{ fileId: string; path: string; deletable: boolean }>;
    };
    const guide = treeBody.items.find((item) => item.path === "pages/guide.md");

    expect(tree.status).toBe(200);
    expect(guide).toMatchObject({
      fileId: "bundle-guide",
      path: "pages/guide.md",
      deletable: true
    });

    const detail = await app.request(
      `/openapi/v1/knowledge-bases/kb-seeded/files/${guide?.fileId}`,
      { headers: authHeaders() }
    );
    const content = await app.request(
      `/openapi/v1/knowledge-bases/kb-seeded/files/${guide?.fileId}/content`,
      { headers: authHeaders() }
    );
    const pathContent = await app.request(
      "/openapi/v1/knowledge-bases/kb-seeded/files/content?path=pages%2Fguide.md",
      { headers: authHeaders() }
    );
    const deletion = await app.request(
      `/openapi/v1/knowledge-bases/kb-seeded/files/${guide?.fileId}`,
      { method: "DELETE", headers: authHeaders() }
    );

    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      file: {
        fileId: guide?.fileId,
        knowledgeBaseId: "kb-seeded",
        path: "pages/guide.md"
      }
    });
    expect(content.status).toBe(200);
    await expect(content.json()).resolves.toMatchObject({
      file: { fileId: guide?.fileId },
      content: expect.stringContaining("# Guide")
    });
    expect(pathContent.status).toBe(200);
    await expect(pathContent.json()).resolves.toMatchObject({
      file: { path: "pages/guide.md" },
      content: expect.stringContaining("# Guide")
    });
    expect(deletion.status).toBe(202);
    await expect(deletion.json()).resolves.toMatchObject({
      knowledgeBaseId: "kb-seeded",
      taskId: expect.stringMatching(/^task-/),
      file: {
        fileId: "bundle-guide",
        path: "pages/guide.md"
      }
    });
  });

  it("keeps webhook identifiers continuous without exposing secrets after creation", async () => {
    const { app } = createApp();
    const create = await app.request("/openapi/v1/webhooks", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "Integration",
        url: "https://example.com/webhook",
        events: ["task.ended"]
      })
    });
    const createBody = (await create.json()) as {
      webhook: { webhookId: string };
      signingSecret: string;
    };

    expect(create.status).toBe(201);
    expect(createBody.webhook.webhookId).toMatch(/^webhook-/);
    expect(createBody.signingSecret).toMatch(/^fwwh_/);

    const list = await app.request("/openapi/v1/webhooks", { headers: authHeaders() });
    const listBody = (await list.json()) as { items: Array<{ webhookId: string }> };

    expect(list.status).toBe(200);
    expect(listBody.items[0]?.webhookId).toBe(createBody.webhook.webhookId);
    expect(JSON.stringify(listBody)).not.toContain(createBody.signingSecret);

    const deleted = await app.request(
      `/openapi/v1/webhooks/${createBody.webhook.webhookId}`,
      { method: "DELETE", headers: authHeaders() }
    );

    expect(deleted.status).toBe(200);
  });

  it("returns centralized safe errors for unsupported routes and invalid cursors", async () => {
    const { app } = createApp();

    await expectOpenApiError(
      await app.request("/openapi/v1/unsupported", { headers: authHeaders() }),
      404,
      "UNSUPPORTED_ROUTE"
    );
    await expectOpenApiError(
      await app.request("/openapi/v1/knowledge-bases?cursor=missing", {
        headers: authHeaders()
      }),
      422,
      "VALIDATION_ERROR"
    );
  });

  it("does not serve old /kb public routes", async () => {
    const { app } = createApp();
    const response = await app.request("/kb/kb-seeded/index.md", {
      headers: authHeaders()
    });

    await expectOpenApiError(response, 404, "UNSUPPORTED_ROUTE");
  });
});
