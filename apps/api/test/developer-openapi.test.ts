import { describe, expect, it } from "vitest";
import { createApiApp, createPublicOpenApiApp } from "../src/server.js";
import type {
  AdminRepositories,
  BundleFileRecord,
  BundleTreeEntryRecord,
  KnowledgeBaseRecord,
  SourceFileRecord,
  WebhookDeliveryRecord,
  WebhookSubscriptionRecord
} from "../src/db/admin-repositories.js";
import { hashPublicOpenApiKey } from "../src/public-openapi/keys.js";
import { createStorageKeyspace } from "../src/storage/keys.js";
import type { StorageAdapter, StoredObject } from "../src/storage/s3.js";
import type { RuntimeConfig } from "../src/config.js";
import type { WorkerJobDraft, WorkerJobRecord, WorkerJobRepository } from "../src/db/worker-job-repository.js";
import { createTestRedisCoordinator, loginAndReadSessionCookie } from "./support/session.js";

const developerKey = "fwok_developer-openapi-test-key";
const now = "2026-06-16T00:00:00.000Z";

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for OpenAPI reads")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

const expectedDeveloperOpenApiOperations = [
  { method: "get", path: "/openapi/v1/health", status: "200" },
  { method: "get", path: "/openapi/v1/version", status: "200" },
  { method: "get", path: "/openapi/v1/openapi.json", status: "200" },
  { method: "get", path: "/openapi/v1/knowledge-bases", status: "200" },
  { method: "post", path: "/openapi/v1/knowledge-bases", status: "201" },
  { method: "get", path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}", status: "200" },
  { method: "delete", path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}", status: "200" },
  { method: "post", path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/uploads", status: "202" },
  { method: "get", path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/source-files", status: "200" },
  {
    method: "get",
    path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}",
    status: "200"
  },
  {
    method: "get",
    path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}/events",
    status: "200"
  },
  {
    method: "post",
    path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}/retry",
    status: "202"
  },
  { method: "get", path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/tree", status: "200" },
  { method: "get", path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/files/content", status: "200" },
  { method: "get", path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}", status: "200" },
  {
    method: "get",
    path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}/content",
    status: "200"
  },
  {
    method: "get",
    path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}/related",
    status: "200"
  },
  { method: "delete", path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}", status: "200" },
  { method: "delete", path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/files", status: "200" },
  { method: "post", path: "/openapi/v1/webhooks", status: "201" },
  { method: "get", path: "/openapi/v1/webhooks", status: "200" },
  { method: "delete", path: "/openapi/v1/webhooks/{webhookId}", status: "200" },
  { method: "get", path: "/openapi/v1/webhook-deliveries", status: "200" },
  { method: "post", path: "/openapi/v1/webhook-deliveries/{deliveryId}/redeliver", status: "202" }
] as const;

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
      fileProcessingConcurrency: 1,
      storageConcurrency: 4
    },
    worker: {
      sourceFileConcurrency: 1,
      claimBatchSize: 2,
      pollIntervalMs: 1_000,
      lockTtlSeconds: 900,
      jobMaxAttempts: 2,
      jobRetryDelayMs: 1_000,
      queueBackpressureLimit: 1,
      queueBackpressureKnowledgeBaseLimit: 1,
      queueBackpressureRetryAfterSeconds: 30,
      shutdownGraceMs: 1_000
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

  public async writeCurrentPointer(): Promise<void> {
    throw new Error("Not used by Developer OpenAPI tests");
  }

  public async readCurrentPointer(): Promise<null> {
    return null;
  }
}

function createRepositories(): AdminRepositories & {
  webhookDeliveries: Map<string, WebhookDeliveryRecord>;
} {
  const keyHash = hashPublicOpenApiKey(developerKey);
  const knowledgeBase: KnowledgeBaseRecord = {
    id: "kb-seeded",
    name: "Seeded KB",
    description: null,
    activeReleaseId: "release-seeded",
    createdAt: now,
    updatedAt: now
  };
  const sourceFile: SourceFileRecord = {
    id: "source-guide",
    knowledgeBaseId: "kb-seeded",
    originalName: "guide.md",
    objectKey: "tenant/demo/knowledge-bases/kb-seeded/sources/source-guide/guide.md",
    contentType: "text/markdown; charset=utf-8",
    sizeBytes: 41,
    checksumSha256: "checksum",
    metadata: {},
    modelSuggestions: null,
    processingStatus: "completed",
    processingStage: "release_activation",
    processingStartedAt: now,
    processingEndedAt: now,
    processingErrorCode: null,
    processingErrorMessage: null,
    generatedOutputStatus: "visible",
    generatedBundleFileId: "bundle-guide",
    generatedBundleFilePath: "pages/guide.md",
    retryCount: 0,
    createdAt: now,
    deletedAt: null
  };
  const sourceFiles = new Map<string, SourceFileRecord>([[sourceFile.id, sourceFile]]);
  const bundleFile: BundleFileRecord = {
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
  };
  const treeEntry: BundleTreeEntryRecord = {
    id: "tree-guide",
    knowledgeBaseId: "kb-seeded",
    releaseId: "release-seeded",
    parentPath: "pages",
    name: "guide.md",
    logicalPath: "pages/guide.md",
    sortKey: "1:guide.md",
    entryType: "file",
    bundleFileId: "bundle-guide",
    sourceFileId: "source-guide",
    fileKind: "page",
    childCount: 0
  };
  const webhooks = new Map<string, WebhookSubscriptionRecord>();
  const webhookDeliveries = new Map<string, WebhookDeliveryRecord>();

  return {
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
      async listKnowledgeBases() {
        return { items: [knowledgeBase], nextCursor: null };
      },
      async createKnowledgeBase(input) {
        return {
          id: "kb-created",
          name: input.name,
          description: input.description,
          activeReleaseId: null,
          createdAt: now,
          updatedAt: now
        };
      },
      async getKnowledgeBase(id) {
        return id === knowledgeBase.id ? knowledgeBase : null;
      },
      async softDeleteKnowledgeBase() {
        return true;
      }
    },
    files: {
      async createSourceFiles(files) {
        for (const file of files) {
          sourceFiles.set(file.id, {
            ...file,
            processingStatus: file.processingStatus ?? "queued",
            processingStage: file.processingStage ?? "upload_storage",
            processingStartedAt: file.processingStartedAt ?? null,
            processingEndedAt: file.processingEndedAt ?? null,
            processingErrorCode: file.processingErrorCode ?? null,
            processingErrorMessage: file.processingErrorMessage ?? null,
            retryCount: file.retryCount ?? 0,
            createdAt: now,
            deletedAt: null
          });
        }
      },
      async createRelease() {
        return undefined;
      },
      async createBundleFiles() {
        return undefined;
      },
      async createBundleTreeEntries() {
        return undefined;
      },
      async createSourceFileRetryAttempt(input) {
        return {
          id: "retry-attempt-001",
          knowledgeBaseId: input.knowledgeBaseId,
          sourceFileId: input.sourceFileId,
          status: input.status,
          startedAt: input.startedAt,
          endedAt: input.endedAt ?? null,
          errorCode: input.errorCode ?? null,
          createdAt: input.startedAt
        };
      },
      async activateRelease() {
        return undefined;
      },
      async listBundleTreeEntries({ parentPath }) {
        return {
          items: parentPath === "pages" ? [treeEntry] : [],
          nextCursor: null
        };
      },
      async getBundleFile({ logicalPath }) {
        return logicalPath === bundleFile.logicalPath ? bundleFile : null;
      },
      async getBundleFileById({ fileId }) {
        return fileId === bundleFile.id ? bundleFile : null;
      },
      async getSourceFile({ sourceFileId }) {
        return sourceFiles.get(sourceFileId) ?? null;
      },
      async listSourceFiles() {
        return { items: Array.from(sourceFiles.values()), nextCursor: null };
      },
      async listReleases() {
        return { items: [], nextCursor: null };
      },
      async listBundleFiles() {
        return { items: [bundleFile], nextCursor: null };
      },
      async softDeleteSourceFile() {
        return true;
      }
    },
    graph: {
      async upsertGraphNode() {
        throw new Error("Not used by Developer OpenAPI tests");
      },
      async upsertGraphEdges() {
        throw new Error("Not used by Developer OpenAPI tests");
      },
      async listGraphNodes() {
        return { items: [], nextCursor: null };
      },
      async listGraphEdges() {
        return { items: [], nextCursor: null };
      },
      async listGraphNeighborhood({ sourceFileId }) {
        return {
          items:
            sourceFileId === "source-guide"
              ? [
                  {
                    fileId: "source-reference",
                    sourceFileId: "source-reference",
                    bundleFileId: "bundle-reference",
                    path: "pages/reference.md",
                    title: "Reference",
                    relationType: "shared_tag",
                    direction: "outgoing",
                    weight: 0.8,
                    reason: "Both files share a topic.",
                    source: "deterministic",
                    contentAvailable: true
                  }
                ]
              : [],
          nextCursor: null
        };
      },
      async deleteGraphForSourceFile() {
        throw new Error("Not used by Developer OpenAPI tests");
      }
    },
    workerJobs: createWorkerJobRepository(),
    webhooks: {
      async createWebhookSubscription(input) {
        const webhook = {
          id: input.id,
          name: input.name,
          url: input.url,
          signingSecret: input.signingSecret,
          events: input.events,
          enabled: true,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
          lastDeliveryAt: null
        };
        webhooks.set(webhook.id, webhook);
        return webhook;
      },
      async getWebhookSubscription(id) {
        return webhooks.get(id) ?? null;
      },
      async listWebhookSubscriptions() {
        return { items: Array.from(webhooks.values()), nextCursor: null };
      },
      async deleteWebhookSubscription({ id }) {
        return webhooks.delete(id);
      },
      async createWebhookDelivery(input) {
        const delivery = {
          id: input.id,
          webhookId: input.webhookId,
          eventId: input.eventId,
          eventType: input.eventType,
          payload: input.payload,
          status: input.status,
          attemptCount: input.attemptCount,
          httpStatus: input.httpStatus,
          errorCode: input.errorCode,
          createdAt: input.createdAt,
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

        const updated = {
          ...delivery,
          status: input.status,
          attemptCount: input.attemptCount,
          httpStatus: input.httpStatus,
          errorCode: input.errorCode,
          updatedAt: input.updatedAt
        };
        webhookDeliveries.set(input.id, updated);
        return updated;
      },
      async listWebhookDeliveries() {
        return { items: Array.from(webhookDeliveries.values()), nextCursor: null };
      },
      async getWebhookDelivery(deliveryId) {
        return webhookDeliveries.get(deliveryId) ?? null;
      }
    }
  };
}

function createApp() {
  const config = createConfig();
  const repositories = createRepositories();
  const storage = new MemoryStorage();
  const app = createPublicOpenApiApp({
    config,
    storage,
    redis: createTestRedisCoordinator(),
    repositories
  });

  return { app, repositories, storage };
}

function createFullApp() {
  const config = createConfig();
  const repositories = createRepositories();
  const storage = new MemoryStorage();
  const app = createApiApp({
    config,
    storage,
    redis: createTestRedisCoordinator(),
    repositories
  });

  return { app, repositories, storage };
}

function createWorkerJobRepository(): WorkerJobRepository {
  const workerJobs: WorkerJobRecord[] = [];

  return {
    async enqueueWorkerJob(input) {
      const record = createWorkerJob(input);
      workerJobs.push(record);
      return record;
    },
    async enqueueSourceFileJob(input) {
      const record = createWorkerJob({
        kind: "source_file_processing",
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFileId: input.sourceFileId,
        payload: { reason: input.reason },
        runAfter: input.runAfter,
        maxAttempts: input.maxAttempts
      });
      workerJobs.push(record);
      return record;
    },
    async enqueuePublicationJob(input) {
      const record = createWorkerJob({
        kind: "publication",
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFileId: null,
        payload: { reason: input.reason },
        runAfter: input.runAfter,
        maxAttempts: input.maxAttempts
      });
      workerJobs.push(record);
      return record;
    },
    async claimWorkerJobs() {
      return [];
    },
    async releaseWorkerJob() {
      return null;
    },
    async completeWorkerJob() {
      return null;
    },
    async failWorkerJob() {
      return null;
    },
    async deadLetterWorkerJob() {
      return null;
    },
    async heartbeatWorkerJob() {
      return null;
    },
    async recordWorkerHeartbeat(input) {
      return {
        workerId: input.workerId,
        lastSeenAt: input.lastSeenAt,
        activeJobCount: input.activeJobCount,
        metadata: input.metadata ?? {},
        createdAt: input.lastSeenAt,
        updatedAt: input.lastSeenAt
      };
    },
    async listWorkerHeartbeats() {
      return [];
    },
    async getWorkerQueueSummary() {
      return {
        queuedCount: workerJobs.filter((job) => job.status === "queued").length,
        runningCount: workerJobs.filter((job) => job.status === "running").length,
        completedCount: workerJobs.filter((job) => job.status === "completed").length,
        failedCount: workerJobs.filter((job) => job.status === "failed").length,
        deadLetterCount: workerJobs.filter((job) => job.status === "dead_letter").length,
        oldestQueuedAt: null,
        oldestQueuedAgeSeconds: null
      };
    },
    async cleanupWorkerJobs() {
      return 0;
    },
    async countActiveWorkerJobs(input) {
      return workerJobs.filter((job) => {
        if (job.status !== "queued" && job.status !== "running") {
          return false;
        }
        if (input.kinds && !input.kinds.includes(job.kind)) {
          return false;
        }
        if (input.knowledgeBaseId && job.knowledgeBaseId !== input.knowledgeBaseId) {
          return false;
        }
        return true;
      }).length;
    }
  };
}

function createWorkerJob(input: WorkerJobDraft): WorkerJobRecord {
  return {
    id: `worker-job-${input.sourceFileId ?? input.kind}`,
    kind: input.kind,
    status: "queued",
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.sourceFileId ?? null,
    payload: input.payload,
    runAfter: input.runAfter,
    attemptCount: 0,
    maxAttempts: input.maxAttempts,
    lockedBy: null,
    lockedAt: null,
    heartbeatAt: null,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: now,
    updatedAt: now
  };
}

function authHeaders() {
  return {
    authorization: `Bearer ${developerKey}`
  };
}

describe("Developer OpenAPI", () => {
  it("returns only health status", async () => {
    const { app } = createApp();
    const response = await app.request("/openapi/v1/health", {
      headers: authHeaders()
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("uses the injected product release version without changing the API version", async () => {
    const previousVersion = process.env.FOCOWIKI_RELEASE_VERSION;
    process.env.FOCOWIKI_RELEASE_VERSION = "9.8.7";

    try {
      const { app } = createApp();
      const [versionResponse, contractResponse, healthResponse] = await Promise.all([
        app.request("/openapi/v1/version", {
          headers: authHeaders()
        }),
        app.request("/openapi/v1/openapi.json", {
          headers: authHeaders()
        }),
        app.request("/openapi/v1/health", {
          headers: authHeaders()
        })
      ]);
      const versionBody = (await versionResponse.json()) as {
        product: string;
        version: string;
        apiVersion: string;
      };
      const contract = (await contractResponse.json()) as {
        info: { version: string };
        paths: {
          "/openapi/v1/version": {
            get: {
              responses: {
                "200": {
                  content: {
                    "application/json": {
                      example: { version: string; apiVersion: string };
                    };
                  };
                };
              };
            };
          };
          "/openapi/v1/openapi.json": {
            get: {
              responses: {
                "200": {
                  content: {
                    "application/json": {
                      example: { info: { version: string } };
                    };
                  };
                };
              };
            };
          };
        };
      };
      const healthBody = (await healthResponse.json()) as Record<string, unknown>;

      expect(versionBody).toEqual({
        product: "focowiki",
        version: "9.8.7",
        apiVersion: "v1"
      });
      expect(contract.info.version).toBe("9.8.7");
      expect(
        contract.paths["/openapi/v1/version"].get.responses["200"].content["application/json"].example
      ).toMatchObject({
        version: "9.8.7",
        apiVersion: "v1"
      });
      expect(
        contract.paths["/openapi/v1/openapi.json"].get.responses["200"].content["application/json"].example
          .info.version
      ).toBe("9.8.7");
      expect(healthBody).toEqual({ status: "ok" });
      expect(healthBody).not.toHaveProperty("version");
      expect(healthBody).not.toHaveProperty("apiVersion");
    } finally {
      if (previousVersion === undefined) {
        delete process.env.FOCOWIKI_RELEASE_VERSION;
      } else {
        process.env.FOCOWIKI_RELEASE_VERSION = previousVersion;
      }
    }
  });

  it("requires a valid OpenAPI key", async () => {
    const { app } = createApp();
    const response = await app.request("/openapi/v1/knowledge-bases");

    expect(response.status).toBe(401);
  });

  it("returns queue backpressure guidance when upload work is above capacity", async () => {
    const { app, repositories } = createApp();
    const workerJobs = repositories.workerJobs;

    if (!workerJobs) {
      throw new Error("Worker job repository is missing from the test fixture.");
    }

    workerJobs.countActiveWorkerJobs = async () => 1;
    const form = new FormData();
    form.append(
      "files",
      new File(["---\ntitle: New guide\ntype: page\n---\n# New guide"], "new-guide.md", {
        type: "text/markdown"
      })
    );

    const response = await app.request("/openapi/v1/knowledge-bases/kb-seeded/uploads", {
      method: "POST",
      headers: authHeaders(),
      body: form
    });
    const body = (await response.json()) as {
      error: {
        code: string;
        httpStatus: number;
        details?: Record<string, unknown>;
      };
    };

    expect(response.status).toBe(503);
    expect(body.error).toMatchObject({
      code: "QUEUE_BACKPRESSURE",
      httpStatus: 503,
      details: {
        activeJobCount: 1,
        limit: 1,
        knowledgeBaseActiveJobCount: 1,
        knowledgeBaseLimit: 1,
        retryAfterSeconds: 30
      }
    });
  });

  it("rejects non-Markdown uploads before creating source files or queue jobs", async () => {
    const { app, repositories, storage } = createApp();
    let sourceFileCreateCount = 0;
    let enqueueCount = 0;
    const initialStoredObjectCount = storage.objects.size;

    if (!repositories.files?.createSourceFiles || !repositories.workerJobs) {
      throw new Error("Upload dependencies are missing from the test fixture.");
    }

    repositories.files.createSourceFiles = async () => {
      sourceFileCreateCount += 1;
    };
    repositories.workerJobs.enqueueSourceFileJob = async (input) => {
      enqueueCount += 1;
      return createWorkerJob({
        kind: "source_file_processing",
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFileId: input.sourceFileId,
        payload: { reason: input.reason },
        runAfter: input.runAfter,
        maxAttempts: input.maxAttempts
      });
    };
    const form = new FormData();
    form.append("files", new File(["plain text"], "notes.txt", { type: "text/plain" }));

    const response = await app.request("/openapi/v1/knowledge-bases/kb-seeded/uploads", {
      method: "POST",
      headers: authHeaders(),
      body: form
    });
    const body = (await response.json()) as {
      error: {
        code: string;
        httpStatus: number;
        details?: Record<string, unknown>;
      };
    };

    expect(response.status).toBe(422);
    expect(body.error).toMatchObject({
      code: "VALIDATION_ERROR",
      httpStatus: 422,
      details: {
        field: "files"
      }
    });
    expect(sourceFileCreateCount).toBe(0);
    expect(enqueueCount).toBe(0);
    expect(storage.objects.size).toBe(initialStoredObjectCount);
  });

  it("accepts single and multi-file Markdown uploads as durable source files", async () => {
    const single = createApp();
    const singleForm = new FormData();
    singleForm.append(
      "files",
      new File(["---\ntitle: Single\ntype: page\n---\n# Single"], "single.md", {
        type: "text/markdown"
      })
    );
    const singleResponse = await single.app.request(
      "/openapi/v1/knowledge-bases/kb-seeded/uploads",
      {
        method: "POST",
        headers: authHeaders(),
        body: singleForm
      }
    );
    const singleBody = (await singleResponse.json()) as {
      knowledgeBaseId: string;
      files: Array<{ fileId: string; originalFilename: string; processingState: string }>;
    };

    expect(singleResponse.status).toBe(202);
    expect(singleBody).toMatchObject({
      knowledgeBaseId: "kb-seeded",
      files: [
        {
          originalFilename: "single.md",
          processingState: "queued"
        }
      ]
    });

    const singleFileId = singleBody.files[0]?.fileId;

    if (!singleFileId) {
      throw new Error("Single upload did not return a fileId.");
    }

    const singleDetailResponse = await single.app.request(
      `/openapi/v1/knowledge-bases/kb-seeded/source-files/${singleFileId}`,
      {
        headers: authHeaders()
      }
    );

    expect(singleDetailResponse.status).toBe(200);

    const multi = createApp();
    const multiForm = new FormData();
    multiForm.append("files", new File(["# Alpha"], "alpha.md", { type: "text/markdown" }));
    multiForm.append("files", new File(["# Beta"], "beta.md", { type: "text/markdown" }));
    const multiResponse = await multi.app.request("/openapi/v1/knowledge-bases/kb-seeded/uploads", {
      method: "POST",
      headers: authHeaders(),
      body: multiForm
    });
    const multiBody = (await multiResponse.json()) as {
      files: Array<{ fileId: string; originalFilename: string; processingState: string }>;
    };

    expect(multiResponse.status).toBe(202);
    expect(multiBody.files.map((file) => file.originalFilename)).toEqual(["alpha.md", "beta.md"]);
    expect(multiBody.files.every((file) => file.fileId && file.processingState === "queued")).toBe(
      true
    );
  });

  it("accepts many source files and leaves processing work in the durable queue", async () => {
    const { app, repositories } = createApp();
    const form = new FormData();

    for (let index = 1; index <= 6; index += 1) {
      form.append(
        "files",
        new File([`---\ntitle: File ${index}\ntype: page\n---\n# File ${index}`], `file-${index}.md`, {
          type: "text/markdown"
        })
      );
    }

    const response = await app.request("/openapi/v1/knowledge-bases/kb-seeded/uploads", {
      method: "POST",
      headers: authHeaders(),
      body: form
    });
    const body = (await response.json()) as {
      files: Array<{
        fileId: string;
        processingState: string;
        generatedFileAvailable: boolean;
      }>;
    };
    const activeQueuedWork = await repositories.workerJobs?.countActiveWorkerJobs({
      kinds: ["source_file_processing"],
      knowledgeBaseId: "kb-seeded"
    });

    expect(response.status).toBe(202);
    expect(body.files).toHaveLength(6);
    expect(body.files.every((file) => file.fileId && file.processingState === "queued")).toBe(true);
    expect(body.files.every((file) => file.generatedFileAvailable === false)).toBe(true);
    expect(activeQueuedWork).toBe(6);
  });

  it("keeps read endpoints responsive while durable source-file work is active", async () => {
    const { app } = createApp();
    const form = new FormData();
    form.append(
      "files",
      new File(["---\ntitle: Active work\ntype: page\n---\n# Active work"], "active-work.md", {
        type: "text/markdown"
      })
    );
    const uploadResponse = await app.request("/openapi/v1/knowledge-bases/kb-seeded/uploads", {
      method: "POST",
      headers: authHeaders(),
      body: form
    });
    const uploadBody = (await uploadResponse.json()) as {
      files: Array<{ fileId: string }>;
    };
    const uploadedFileId = uploadBody.files[0]?.fileId;

    if (!uploadedFileId) {
      throw new Error("Upload response did not return a fileId.");
    }

    const responses = await withTimeout(
      Promise.all([
        app.request("/openapi/v1/health", { headers: authHeaders() }),
        app.request("/openapi/v1/version", { headers: authHeaders() }),
        app.request("/openapi/v1/openapi.json", { headers: authHeaders() }),
        app.request("/openapi/v1/knowledge-bases/kb-seeded/source-files", {
          headers: authHeaders()
        }),
        app.request(`/openapi/v1/knowledge-bases/kb-seeded/source-files/${uploadedFileId}`, {
          headers: authHeaders()
        }),
        app.request("/openapi/v1/knowledge-bases/kb-seeded/tree?parentPath=pages", {
          headers: authHeaders()
        }),
        app.request(
          "/openapi/v1/knowledge-bases/kb-seeded/files/content?path=pages%2Fguide.md",
          {
            headers: authHeaders()
          }
        )
      ]),
      1_000
    );

    expect(uploadResponse.status).toBe(202);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200, 200]);
  });

  it("keeps Developer OpenAPI responses contract-stable while Admin polling is active", async () => {
    const { app } = createFullApp();
    const adminCookie = await loginAndReadSessionCookie(app);
    const responses = await withTimeout(
      Promise.all([
        app.request("/admin/api/knowledge-bases/kb-seeded/source-files?limit=1", {
          headers: { cookie: adminCookie }
        }),
        app.request("/admin/api/knowledge-bases/kb-seeded/files/tree?parentPath=pages&limit=1", {
          headers: { cookie: adminCookie }
        }),
        app.request("/openapi/v1/knowledge-bases/kb-seeded/source-files", {
          headers: authHeaders()
        }),
        app.request("/openapi/v1/knowledge-bases/kb-seeded/tree?parentPath=pages", {
          headers: authHeaders()
        }),
        app.request("/openapi/v1/knowledge-bases/kb-seeded/files/content?path=pages%2Fguide.md", {
          headers: authHeaders()
        })
      ]),
      1_000
    );
    const developerSourceFiles = (await responses[2].json()) as {
      items: Array<Record<string, unknown>>;
    };
    const developerTree = (await responses[3].json()) as {
      items: Array<Record<string, unknown>>;
    };

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    expect(developerSourceFiles.items[0]).toMatchObject({
      fileId: "source-guide",
      generatedFileId: "bundle-guide",
      generatedFilePath: "pages/guide.md"
    });
    expect(developerSourceFiles.items[0]).not.toHaveProperty("objectKey");
    expect(developerSourceFiles.items[0]).not.toHaveProperty("releaseId");
    expect(developerTree.items[0]).toMatchObject({
      id: "tree-guide",
      path: "pages/guide.md"
    });
    expect(developerTree.items[0]).not.toHaveProperty("objectKey");
  });

  it("keeps queued source-file work visible after recreating the API app", async () => {
    const config = createConfig();
    const repositories = createRepositories();
    const storage = new MemoryStorage();
    const firstApp = createPublicOpenApiApp({
      config,
      storage,
      redis: createTestRedisCoordinator(),
      repositories
    });
    const form = new FormData();
    form.append("files", new File(["# Restart"], "restart.md", { type: "text/markdown" }));
    const uploadResponse = await firstApp.request("/openapi/v1/knowledge-bases/kb-seeded/uploads", {
      method: "POST",
      headers: authHeaders(),
      body: form
    });
    const uploadBody = (await uploadResponse.json()) as {
      files: Array<{ fileId: string }>;
    };
    const uploadedFileId = uploadBody.files[0]?.fileId;

    if (!uploadedFileId) {
      throw new Error("Upload response did not return a fileId.");
    }

    const restartedApp = createPublicOpenApiApp({
      config,
      storage,
      redis: createTestRedisCoordinator(),
      repositories
    });
    const statusResponse = await restartedApp.request(
      `/openapi/v1/knowledge-bases/kb-seeded/source-files/${uploadedFileId}`,
      {
        headers: authHeaders()
      }
    );
    const activeQueuedWork = await repositories.workerJobs?.countActiveWorkerJobs({
      kinds: ["source_file_processing"],
      knowledgeBaseId: "kb-seeded"
    });

    expect(uploadResponse.status).toBe(202);
    expect(statusResponse.status).toBe(200);
    expect(activeQueuedWork).toBe(1);
  });

  it("accepts retry for a failed source file and enqueues durable work", async () => {
    const { app, repositories } = createApp();
    const baseGetSourceFile = repositories.files?.getSourceFile;
    let enqueueCount = 0;

    if (!baseGetSourceFile || !repositories.files || !repositories.workerJobs) {
      throw new Error("Retry dependencies are missing from the test fixture.");
    }

    repositories.files.getSourceFile = async (input) => {
      const sourceFile = await baseGetSourceFile(input);

      if (!sourceFile) {
        return null;
      }

      return {
        ...sourceFile,
        processingStatus: "failed",
        processingStage: "llm_suggestion",
        processingEndedAt: now,
        processingErrorCode: "MODEL_SUGGESTION_FAILED"
      };
    };
    repositories.workerJobs.enqueueSourceFileJob = async (input) => {
      enqueueCount += 1;
      return createWorkerJob({
        kind: "source_file_processing",
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFileId: input.sourceFileId,
        payload: { reason: input.reason },
        runAfter: input.runAfter,
        maxAttempts: input.maxAttempts
      });
    };

    const response = await app.request(
      "/openapi/v1/knowledge-bases/kb-seeded/source-files/source-guide/retry",
      {
        method: "POST",
        headers: authHeaders()
      }
    );
    const body = (await response.json()) as {
      file: {
        fileId: string;
        processingState: string;
        currentStage: string;
        processingErrorCode: string | null;
      };
    };

    expect(response.status).toBe(202);
    expect(body.file).toMatchObject({
      fileId: "source-guide",
      processingState: "failed",
      currentStage: "llm_suggestion",
      processingErrorCode: "MODEL_SUGGESTION_FAILED"
    });
    expect(enqueueCount).toBe(1);
  });

  it("exposes source file endpoints in the OpenAPI contract", async () => {
    const { app } = createApp();
    const response = await app.request("/openapi/v1/openapi.json", {
      headers: authHeaders()
    });
    const contract = (await response.json()) as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };

    for (const operation of expectedDeveloperOpenApiOperations) {
      expect(contract.paths[operation.path]?.[operation.method]?.responses[operation.status]).toBeDefined();
    }
    expect(contract.paths["/openapi/v1/knowledge-bases/{knowledgeBaseId}/tasks"]).toBeUndefined();
  });

  it("lists source files without task fields", async () => {
    const { app } = createApp();
    const response = await app.request("/openapi/v1/knowledge-bases/kb-seeded/source-files", {
      headers: authHeaders()
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<Record<string, unknown>>;
    };

    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      fileId: "source-guide",
      originalFilename: "guide.md",
      processingState: "completed",
      generatedFileAvailable: true,
      generatedFileId: "bundle-guide",
      generatedFilePath: "pages/guide.md"
    });
    expect(body.items[0]).not.toHaveProperty("taskId");
    expect(body.items[0]).not.toHaveProperty("releaseId");
    expect(body.items[0]).not.toHaveProperty("objectKey");
  });

  it("documents every returned source file field in the OpenAPI contract", async () => {
    const { app } = createApp();
    const [contractResponse, sourceFilesResponse, sourceFileDetailResponse] = await Promise.all([
      app.request("/openapi/v1/openapi.json", {
        headers: authHeaders()
      }),
      app.request("/openapi/v1/knowledge-bases/kb-seeded/source-files", {
        headers: authHeaders()
      }),
      app.request("/openapi/v1/knowledge-bases/kb-seeded/files/source-guide", {
        headers: authHeaders()
      })
    ]);
    const contract = (await contractResponse.json()) as {
      components: {
        schemas: Record<string, { properties?: Record<string, unknown> }>;
      };
    };
    const sourceFilesBody = (await sourceFilesResponse.json()) as {
      items: Array<Record<string, unknown>>;
    };
    const sourceFileDetailBody = (await sourceFileDetailResponse.json()) as {
      file: Record<string, unknown>;
    };
    const sourceFileSchema = contract.components.schemas.SourceFile;
    const sourceFileDetailSchema = contract.components.schemas.SourceFileDetail;

    if (!sourceFileSchema?.properties || !sourceFileDetailSchema?.properties) {
      throw new Error("Source file schemas are missing from the OpenAPI contract.");
    }
    const sourceFile = sourceFilesBody.items[0];

    if (!sourceFile) {
      throw new Error("Source file fixture did not return an item.");
    }

    expect(Object.keys(sourceFileSchema.properties).sort()).toEqual(
      Object.keys(sourceFile).sort()
    );
    expect(Object.keys(sourceFileDetailSchema.properties).sort()).toEqual(
      Object.keys(sourceFileDetailBody.file).sort()
    );
  });

  it("returns bounded related files for a generated source-backed file", async () => {
    const { app } = createApp();
    const response = await app.request(
      "/openapi/v1/knowledge-bases/kb-seeded/files/bundle-guide/related",
      {
        headers: authHeaders()
      }
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      fileId: string;
      sourceFileId: string;
      items: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };

    expect(body).toMatchObject({
      fileId: "bundle-guide",
      sourceFileId: "source-guide",
      nextCursor: null,
      items: [
        {
          fileId: "source-reference",
          path: "pages/reference.md",
          title: "Reference",
          relationType: "shared_tag",
          direction: "outgoing",
          weight: 0.8,
          reason: "Both files share a topic.",
          contentAvailable: true
        }
      ]
    });
  });
});
