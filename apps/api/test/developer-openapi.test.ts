import { describe, expect, it } from "vitest";
import { createApiApp, createPublicOpenApiApp } from "../src/server.js";
import type {
  AdminRepositories,
  BundleFileRecord,
  BundleTreeEntryRecord,
  KnowledgeBaseRecord,
  SourceFileListFilters,
  SourceFileTaskDeletionRepositoryResult,
  SourceFileRecord,
  WebhookDeliveryRecord,
  WebhookSubscriptionRecord
} from "../src/db/admin-repositories.js";
import { hashPublicOpenApiKey } from "../src/public-openapi/keys.js";
import { createStorageKeyspace } from "../src/storage/keys.js";
import type { StorageAdapter, StoredObject } from "../src/storage/s3.js";
import {
  resolveSecurityConfig,
  resolveWorkerConfig,
  type RuntimeConfig
} from "../src/config.js";
import type { WorkerJobDraft, WorkerJobRecord, WorkerJobRepository } from "../src/db/worker-job-repository.js";
import type { RuntimeSettingsService } from "../src/runtime-settings/service.js";
import type {
  RuntimeSettingsSnapshot,
  RuntimeUploadGenerationSettings
} from "../src/runtime-settings/types.js";
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
  {
    method: "post",
    path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/source-files/task-deletions",
    status: "200"
  },
  { method: "get", path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/tree", status: "200" },
  { method: "get", path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/files/content", status: "200" },
  { method: "get", path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/files/search", status: "200" },
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

type TestRepositoryOptions = {
  staleSourceGeneratedBundleFileId?: boolean;
};

function createRepositories(options: TestRepositoryOptions = {}): AdminRepositories & {
  sourceFiles: Map<string, SourceFileRecord>;
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
    generatedBundleFileId: options.staleSourceGeneratedBundleFileId ? "bundle-stale" : "bundle-guide",
    generatedBundleFilePath: "pages/guide.md",
    retryCount: 0,
    createdAt: now,
    deletedAt: null
  };
  const hiddenSourceFile: SourceFileRecord = {
    ...sourceFile,
    id: "source-hidden",
    originalName: "hidden.md",
    objectKey: "tenant/demo/knowledge-bases/kb-seeded/sources/source-hidden/hidden.md",
    generatedBundleFileId: "bundle-hidden",
    generatedBundleFilePath: "pages/hidden.md",
    taskDeletedAt: now
  };
  const sourceFiles = new Map<string, SourceFileRecord>([
    [sourceFile.id, sourceFile],
    [hiddenSourceFile.id, hiddenSourceFile]
  ]);
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
  const hiddenBundleFile: BundleFileRecord = {
    ...bundleFile,
    id: "bundle-hidden",
    sourceFileId: "source-hidden",
    logicalPath: "pages/hidden.md",
    objectKey: "tenant/demo/knowledge-bases/kb-seeded/releases/release-seeded/bundle/pages/hidden.md",
    title: "Hidden",
    frontmatter: { type: "page", title: "Hidden" }
  };
  const bundleFiles = new Map<string, BundleFileRecord>([
    [bundleFile.id, bundleFile],
    [hiddenBundleFile.id, hiddenBundleFile]
  ]);
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
    sourceFiles,
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
      async createBundleFiles(files) {
        for (const file of files) {
          bundleFiles.set(file.id, file);
        }
      },
      async upsertBundleFileSearchDocuments() {
        return undefined;
      },
      async countBundleFileSearchDocuments({ releaseId }) {
        return Array.from(bundleFiles.values()).filter((file) => file.releaseId === releaseId).length;
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
      async getBundleFileById({ knowledgeBaseId, releaseId, fileId }) {
        const file = bundleFiles.get(fileId) ?? null;
        return file && file.knowledgeBaseId === knowledgeBaseId && file.releaseId === releaseId
          ? file
          : null;
      },
      async listGeneratedOutputsForSourceFiles({ knowledgeBaseId, releaseId, sourceFileIds }) {
        return Array.from(bundleFiles.values())
          .filter(
            (file) =>
              file.knowledgeBaseId === knowledgeBaseId &&
              file.releaseId === releaseId &&
              file.sourceFileId &&
              file.fileKind === "page" &&
              sourceFileIds.includes(file.sourceFileId)
          )
          .map((file) => ({
            sourceFileId: file.sourceFileId as string,
            bundleFileId: file.id,
            logicalPath: file.logicalPath
          }));
      },
      async getSourceFile({ sourceFileId }) {
        const file = sourceFiles.get(sourceFileId) ?? null;
        return file && !file.deletedAt && !file.taskDeletedAt ? file : null;
      },
      async listSourceFiles(request) {
        const filters = request as SourceFileListFilters;
        return {
          items: Array.from(sourceFiles.values())
            .filter((file) => !file.deletedAt && !file.taskDeletedAt)
            .filter((file) => applySourceFileListFilters(file, filters))
            .slice(0, request.limit),
          nextCursor: null
        };
      },
      async deleteSourceFileTasks({ knowledgeBaseId, sourceFileIds, deletedAt }) {
        const results: SourceFileTaskDeletionRepositoryResult[] = [];

        for (const sourceFileId of sourceFileIds) {
          const file = sourceFiles.get(sourceFileId);

          if (!file || file.knowledgeBaseId !== knowledgeBaseId) {
            results.push({ sourceFileId, outcome: "skipped", reason: "missing" });
            continue;
          }

          if (file.processingStatus === "running") {
            results.push({ sourceFileId, outcome: "skipped", reason: "running" });
            continue;
          }

          if (file.generatedOutputStatus === "visible") {
            sourceFiles.set(sourceFileId, {
              ...file,
              taskDeletedAt: deletedAt
            });
            results.push({
              sourceFileId,
              outcome: "hidden",
              generatedFileId: file.generatedBundleFileId ?? null,
              generatedFilePath: file.generatedBundleFilePath ?? null
            });
            continue;
          }

          sourceFiles.set(sourceFileId, {
            ...file,
            deletedAt
          });
          results.push({
            sourceFileId,
            outcome: "deleted",
            objectKey: file.objectKey
          });
        }

        return results;
      },
      async listReleases() {
        return { items: [], nextCursor: null };
      },
      async listBundleFiles() {
        return { items: Array.from(bundleFiles.values()), nextCursor: null };
      },
      async searchBundleFiles({ query, fileKind, limit }) {
        const normalizedQuery = query.toLowerCase();
        const items = Array.from(bundleFiles.values())
          .filter((file) => !fileKind || file.fileKind === fileKind)
          .filter((file) => {
            if (!file.sourceFileId) {
              return true;
            }
            const source = sourceFiles.get(file.sourceFileId);
            return Boolean(source && !source.deletedAt);
          })
          .map((file) => {
            const title = file.title ?? "";
            const description = file.description ?? "";
            const metadata = JSON.stringify(file.frontmatter);
            const matchedFields = [
              file.logicalPath.toLowerCase().includes(normalizedQuery) ? "path" : null,
              title.toLowerCase().includes(normalizedQuery) ? "title" : null,
              description.toLowerCase().includes(normalizedQuery) ? "description" : null,
              metadata.toLowerCase().includes(normalizedQuery) ? "metadata" : null
            ].filter(
              (field): field is "path" | "title" | "description" | "metadata" => Boolean(field)
            );

            return {
              fileId: file.id,
              knowledgeBaseId: file.knowledgeBaseId,
              releaseId: file.releaseId,
              sourceFileId: file.sourceFileId,
              fileKind: file.fileKind,
              path: file.logicalPath,
              title: file.title,
              description: file.description,
              tags: file.tags,
              frontmatter: file.frontmatter,
              matchedFields,
              score: matchedFields.length,
              contentAvailable: true
            };
          })
          .filter((file) => file.score > 0)
          .slice(0, limit);

        return { items, nextCursor: null };
      },
      async softDeleteSourceFile({ sourceFileId, deletedAt }) {
        const source = sourceFiles.get(sourceFileId);

        if (!source || source.deletedAt) {
          return false;
        }

        sourceFiles.set(sourceFileId, {
          ...source,
          deletedAt,
          generatedBundleFileId: null,
          generatedBundleFilePath: null
        });
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
        return undefined;
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

function applySourceFileListFilters(
  file: SourceFileRecord,
  filters: SourceFileListFilters
): boolean {
  if (
    filters.fileNameQuery &&
    !file.originalName.toLowerCase().includes(filters.fileNameQuery.toLowerCase())
  ) {
    return false;
  }

  if (filters.fileIdQuery && !file.id.startsWith(filters.fileIdQuery)) {
    return false;
  }

  if (filters.processingStatus && file.processingStatus !== filters.processingStatus) {
    return false;
  }

  if (filters.processingStage && file.processingStage !== filters.processingStage) {
    return false;
  }

  if (filters.generatedOutputStatus && file.generatedOutputStatus !== filters.generatedOutputStatus) {
    return false;
  }

  return true;
}

function createApp(options: TestRepositoryOptions = {}) {
  const config = createConfig();
  const repositories = createRepositories(options);
  const storage = new MemoryStorage();
  const app = createPublicOpenApiApp({
    config,
    storage,
    redis: createTestRedisCoordinator(),
    repositories
  });

  return { app, repositories, storage };
}

function createAppWithRuntimeUpload(uploadGeneration: RuntimeUploadGenerationSettings) {
  const config = createConfig();
  const repositories = createRepositories();
  const storage = new MemoryStorage();
  const app = createPublicOpenApiApp({
    config,
    storage,
    redis: createTestRedisCoordinator(),
    repositories,
    runtimeSettings: createRuntimeSettingsStub(config, uploadGeneration)
  });

  return { app, repositories, storage };
}

function createFullApp(options: TestRepositoryOptions = {}) {
  const config = createConfig();
  const repositories = createRepositories(options);
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

function createRuntimeSettingsStub(
  config: RuntimeConfig,
  uploadGeneration: RuntimeUploadGenerationSettings
): RuntimeSettingsService {
  const snapshot: RuntimeSettingsSnapshot = {
    rateLimits: resolveSecurityConfig(config).rateLimits,
    worker: resolveWorkerConfig(config) as RuntimeSettingsSnapshot["worker"],
    publication: {
      ...config.publication,
      okfLogMaxEntries: 100,
      okfLogMaxBytes: 65_536
    },
    uploadGeneration,
    activeModel: null
  };

  return {
    async ensureBootstrapped() {
      return;
    },
    async getSnapshot() {
      return snapshot;
    },
    async getPublicSnapshot() {
      return snapshot;
    },
    async updateRateLimits() {
      return snapshot;
    },
    async updateWorker() {
      return snapshot;
    },
    async updatePublication() {
      return snapshot;
    },
    async updateUploadGeneration() {
      return snapshot;
    },
    async listModels() {
      return [];
    },
    async createModel() {
      throw new Error("Not used by Developer OpenAPI tests");
    },
    async activateModel() {
      return null;
    },
    async pauseModel() {
      return null;
    },
    async resumeModel() {
      return null;
    },
    async deleteModel() {
      return null;
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

  it("rejects uploads that exceed runtime file count limits before queueing work", async () => {
    const { app, repositories, storage } = createAppWithRuntimeUpload({
      maxBytes: 1_048_576,
      maxFiles: 1,
      generationBatchSize: 50,
      fileProcessingConcurrency: 1,
      storageConcurrency: 1
    });
    const initialSourceFileCount = repositories.sourceFiles.size;
    const initialStoredObjectCount = storage.objects.size;
    const form = new FormData();
    form.append("files", new File(["# One"], "one.md", { type: "text/markdown" }));
    form.append("files", new File(["# Two"], "two.md", { type: "text/markdown" }));

    const response = await app.request("/openapi/v1/knowledge-bases/kb-seeded/uploads", {
      method: "POST",
      headers: authHeaders(),
      body: form
    });
    const body = (await response.json()) as {
      error: {
        code: string;
        httpStatus: number;
      };
    };

    expect(response.status).toBe(413);
    expect(body.error).toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      httpStatus: 413
    });
    expect(repositories.sourceFiles.size).toBe(initialSourceFileCount);
    expect(storage.objects.size).toBe(initialStoredObjectCount);
    expect(
      await repositories.workerJobs?.countActiveWorkerJobs({
        kinds: ["source_file_processing"],
        knowledgeBaseId: "kb-seeded"
      })
    ).toBe(0);
  });

  it("rejects uploads that exceed runtime total byte limits before queueing work", async () => {
    const { app, repositories, storage } = createAppWithRuntimeUpload({
      maxBytes: 10,
      maxFiles: 24,
      generationBatchSize: 50,
      fileProcessingConcurrency: 1,
      storageConcurrency: 1
    });
    const initialSourceFileCount = repositories.sourceFiles.size;
    const initialStoredObjectCount = storage.objects.size;
    const form = new FormData();
    form.append(
      "files",
      new File(["---\ntitle: Oversized\ntype: page\n---\n# Oversized"], "oversized.md", {
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
      };
    };

    expect(response.status).toBe(413);
    expect(body.error).toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      httpStatus: 413
    });
    expect(repositories.sourceFiles.size).toBe(initialSourceFileCount);
    expect(storage.objects.size).toBe(initialStoredObjectCount);
    expect(
      await repositories.workerJobs?.countActiveWorkerJobs({
        kinds: ["source_file_processing"],
        knowledgeBaseId: "kb-seeded"
      })
    ).toBe(0);
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
      files: Array<{
        fileId: string;
        sourceFileId: string;
        originalFilename: string;
        processingState: string;
      }>;
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
    const singleSourceFileId = singleBody.files[0]?.sourceFileId;

    if (!singleFileId || !singleSourceFileId) {
      throw new Error("Single upload did not return source identifiers.");
    }

    expect(singleSourceFileId).toBe(singleFileId);

    const singleDetailResponse = await single.app.request(
      `/openapi/v1/knowledge-bases/kb-seeded/source-files/${singleSourceFileId}`,
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
      files: Array<{ fileId: string; sourceFileId: string; originalFilename: string; processingState: string }>;
    };

    expect(multiResponse.status).toBe(202);
    expect(multiBody.files.map((file) => file.originalFilename)).toEqual(["alpha.md", "beta.md"]);
    expect(
      multiBody.files.every(
        (file) => file.fileId && file.sourceFileId === file.fileId && file.processingState === "queued"
      )
    ).toBe(true);
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
        sourceFileId: string;
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
    expect(
      body.files.every(
        (file) => file.fileId && file.sourceFileId === file.fileId && file.processingState === "queued"
      )
    ).toBe(true);
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

  it("requires OpenAPI auth for generated file search", async () => {
    const { app } = createApp();
    const response = await app.request(
      "/openapi/v1/knowledge-bases/kb-seeded/files/search?query=guide"
    );

    expect(response.status).toBe(401);
  });

  it("rejects invalid generated file search queries before repository search", async () => {
    const { app, repositories } = createApp();
    let searchCount = 0;

    if (!repositories.files?.searchBundleFiles) {
      throw new Error("Search repository is missing from the test fixture.");
    }

    repositories.files.searchBundleFiles = async () => {
      searchCount += 1;
      return { items: [], nextCursor: null };
    };

    const response = await app.request(
      "/openapi/v1/knowledge-bases/kb-seeded/files/search?query=x",
      {
        headers: authHeaders()
      }
    );
    const body = (await response.json()) as {
      error: { code: string; details?: Record<string, unknown> };
    };

    expect(response.status).toBe(422);
    expect(body.error).toMatchObject({
      code: "VALIDATION_ERROR",
      details: {
        code: "FILE_SEARCH_QUERY_TOO_SHORT"
      }
    });
    expect(searchCount).toBe(0);
  });

  it("rate-limits generated file search before repository search", async () => {
    const baseConfig = createConfig();
    const security = resolveSecurityConfig(baseConfig);
    const repositories = createRepositories();
    const app = createPublicOpenApiApp({
      config: {
        ...baseConfig,
        security: {
          ...security,
          rateLimits: {
            ...security.rateLimits,
            publicOpenApi: {
              max: 1,
              windowSeconds: 60
            }
          }
        }
      },
      storage: new MemoryStorage(),
      redis: createTestRedisCoordinator(),
      repositories
    });
    let searchCount = 0;

    if (!repositories.files?.searchBundleFiles) {
      throw new Error("Search repository is missing from the test fixture.");
    }

    const originalSearch = repositories.files.searchBundleFiles;
    repositories.files.searchBundleFiles = async (request) => {
      searchCount += 1;
      return originalSearch(request);
    };

    const first = await app.request(
      "/openapi/v1/knowledge-bases/kb-seeded/files/search?query=guide",
      {
        headers: authHeaders()
      }
    );
    const second = await app.request(
      "/openapi/v1/knowledge-bases/kb-seeded/files/search?query=guide",
      {
        headers: authHeaders()
      }
    );
    const body = (await second.json()) as {
      error: {
        code: string;
        message: string;
        details?: {
          retryHint?: string;
          retryAfterSeconds?: number;
          retryGuidance?: string;
        };
      };
    };

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("60");
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.message).toBe("Too many requests. Wait briefly and retry.");
    expect(body.error.details).toMatchObject({
      retryHint: "retry_after_short_delay",
      retryAfterSeconds: 60,
      retryGuidance: "Wait briefly before sending the next Developer OpenAPI request."
    });
    expect(searchCount).toBe(1);
  });

  it("returns index-unavailable search status without scanning old active releases", async () => {
    const { app, repositories } = createApp();
    let searchCount = 0;

    if (!repositories.files?.countBundleFileSearchDocuments || !repositories.files.searchBundleFiles) {
      throw new Error("Search repository is missing from the test fixture.");
    }

    repositories.files.countBundleFileSearchDocuments = async () => 0;
    repositories.files.searchBundleFiles = async () => {
      searchCount += 1;
      return { items: [], nextCursor: null };
    };

    const response = await app.request(
      "/openapi/v1/knowledge-bases/kb-seeded/files/search?query=guide",
      {
        headers: authHeaders()
      }
    );
    const body = (await response.json()) as {
      query: { normalizedQuery: string };
      items: unknown[];
      nextCursor: string | null;
      searchStatus: string;
      resultSummary: { resultCount: number; hasMore: boolean; meaning: string };
      nextRequestTemplates: { readIndex: string; listTree: string };
      nextActions?: string[];
    };

    expect(response.status).toBe(200);
    expect(body.query.normalizedQuery).toBe("guide");
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(body.searchStatus).toBe("index_unavailable");
    expect(body.resultSummary).toMatchObject({
      resultCount: 0,
      hasMore: false
    });
    expect(body.nextRequestTemplates.readIndex).toContain("index.md");
    expect(body.nextRequestTemplates.listTree).toContain("parentPath={parentPath}");
    expect(body.nextActions?.length).toBeGreaterThan(0);
    expect(searchCount).toBe(0);
  });

  it("keeps existing Developer OpenAPI reads compatible when search documents are unavailable", async () => {
    const { app, repositories } = createApp();

    if (!repositories.files?.countBundleFileSearchDocuments) {
      throw new Error("Search repository is missing from the test fixture.");
    }

    repositories.files.countBundleFileSearchDocuments = async () => 0;
    const [treeResponse, contentResponse, detailResponse] = await Promise.all([
      app.request("/openapi/v1/knowledge-bases/kb-seeded/tree?parentPath=pages", {
        headers: authHeaders()
      }),
      app.request("/openapi/v1/knowledge-bases/kb-seeded/files/content?path=pages%2Fguide.md", {
        headers: authHeaders()
      }),
      app.request("/openapi/v1/knowledge-bases/kb-seeded/files/bundle-guide", {
        headers: authHeaders()
      })
    ]);

    expect([treeResponse.status, contentResponse.status, detailResponse.status]).toEqual([
      200,
      200,
      200
    ]);
  });

  it("returns no-candidate search status from an available generated file index", async () => {
    const { app } = createApp();
    const response = await app.request(
      "/openapi/v1/knowledge-bases/kb-seeded/files/search?query=missing",
      {
        headers: authHeaders()
      }
    );
    const body = (await response.json()) as {
      query: { normalizedQuery: string };
      items: unknown[];
      searchStatus: string;
      resultSummary: { resultCount: number; meaning: string };
      message?: string;
      nextRequestTemplates: { searchAgain: string };
      nextActions?: string[];
    };

    expect(response.status).toBe(200);
    expect(body.query.normalizedQuery).toBe("missing");
    expect(body.items).toEqual([]);
    expect(body.searchStatus).toBe("no_candidates");
    expect(body.resultSummary.resultCount).toBe(0);
    expect(body.resultSummary.meaning).toContain("Relevant data may still exist");
    expect(body.message).toContain("may still contain relevant data");
    expect(body.nextRequestTemplates.searchAgain).toContain("query={query}");
    expect(body.nextActions?.length).toBeGreaterThan(0);
  });

  it("keeps task-hidden generated files searchable while excluding deleted sources", async () => {
    const { app, repositories } = createApp();
    const guideSource = repositories.sourceFiles.get("source-guide");

    if (!guideSource) {
      throw new Error("Guide source fixture is missing.");
    }

    const hiddenResponse = await app.request(
      "/openapi/v1/knowledge-bases/kb-seeded/files/search?query=hidden&scope=all&fileKind=page&limit=10",
      {
        headers: authHeaders()
      }
    );

    repositories.sourceFiles.set("source-guide", {
      ...guideSource,
      deletedAt: now
    });

    const guideResponse = await app.request(
      "/openapi/v1/knowledge-bases/kb-seeded/files/search?query=guide&scope=all&fileKind=page&limit=10",
      {
        headers: authHeaders()
      }
    );
    const hiddenBody = (await hiddenResponse.json()) as {
      items: Array<{ fileId: string; sourceFileId: string | null }>;
      searchStatus: string;
    };
    const guideBody = (await guideResponse.json()) as {
      items: Array<{ fileId: string }>;
      searchStatus: string;
    };

    expect(hiddenResponse.status).toBe(200);
    expect(hiddenBody.searchStatus).toBe("ok");
    expect(hiddenBody.items).toContainEqual(
      expect.objectContaining({
        fileId: "bundle-hidden",
        sourceFileId: "source-hidden"
      })
    );
    expect(guideResponse.status).toBe(200);
    expect(guideBody.items).not.toContainEqual(expect.objectContaining({ fileId: "bundle-guide" }));
  });

  it("returns generated file search candidates that continue into existing read APIs", async () => {
    const { app } = createApp();
    const searchResponse = await app.request(
      "/openapi/v1/knowledge-bases/kb-seeded/files/search?query=guide&scope=all&fileKind=page&limit=10",
      {
        headers: authHeaders()
      }
    );
    const searchBody = (await searchResponse.json()) as {
      items: Array<{
        fileId: string;
        generatedFileId: string;
        sourceFileId: string | null;
        path: string;
        generatedFilePath: string;
        matchedFields: string[];
        contentAvailable: boolean;
      }>;
      searchStatus: string;
      query: { query: string; normalizedQuery: string; fileKind: string; limit: number };
      resultSummary: { resultCount: number; hasMore: boolean; sort: string[]; meaning: string };
      nextRequestTemplates: {
        fileDetailById: string;
        fileContentById: string;
        fileContentByPath: string;
        relatedFilesById: string;
        sourceFileStatusById: string;
      };
    };
    const candidate = searchBody.items[0];

    if (!candidate) {
      throw new Error("Generated file search did not return a candidate.");
    }

    const [detailResponse, contentByIdResponse, relatedResponse, contentByPathResponse] =
      await Promise.all([
        app.request(`/openapi/v1/knowledge-bases/kb-seeded/files/${candidate.generatedFileId}`, {
          headers: authHeaders()
        }),
        app.request(`/openapi/v1/knowledge-bases/kb-seeded/files/${candidate.generatedFileId}/content`, {
          headers: authHeaders()
        }),
        app.request(`/openapi/v1/knowledge-bases/kb-seeded/files/${candidate.generatedFileId}/related`, {
          headers: authHeaders()
        }),
        app.request(
          `/openapi/v1/knowledge-bases/kb-seeded/files/content?path=${encodeURIComponent(candidate.generatedFilePath)}`,
          {
            headers: authHeaders()
          }
        )
      ]);

    expect(searchResponse.status).toBe(200);
    expect(searchBody.searchStatus).toBe("ok");
    expect(searchBody.query).toMatchObject({
      query: "guide",
      normalizedQuery: "guide",
      fileKind: "page",
      limit: 10
    });
    expect(searchBody.resultSummary).toMatchObject({
      resultCount: searchBody.items.length,
      hasMore: false
    });
    expect(searchBody.resultSummary.sort).toEqual(["score desc", "path asc", "fileId asc"]);
    expect(searchBody.resultSummary.meaning).toContain("Read candidate content");
    expect(searchBody.nextRequestTemplates).toMatchObject({
      fileDetailById: "/openapi/v1/knowledge-bases/kb-seeded/files/{generatedFileId}",
      fileContentById: "/openapi/v1/knowledge-bases/kb-seeded/files/{generatedFileId}/content",
      fileContentByPath: "/openapi/v1/knowledge-bases/kb-seeded/files/content?path={generatedFilePath}",
      relatedFilesById: "/openapi/v1/knowledge-bases/kb-seeded/files/{generatedFileId}/related",
      sourceFileStatusById: "/openapi/v1/knowledge-bases/kb-seeded/source-files/{sourceFileId}"
    });
    expect(candidate).toMatchObject({
      fileId: "bundle-guide",
      generatedFileId: "bundle-guide",
      sourceFileId: "source-guide",
      path: "pages/guide.md",
      generatedFilePath: "pages/guide.md",
      contentAvailable: true
    });
    expect(candidate.matchedFields).toEqual(expect.arrayContaining(["path", "title"]));
    expect([detailResponse.status, contentByIdResponse.status, relatedResponse.status, contentByPathResponse.status]).toEqual([
      200,
      200,
      200,
      200
    ]);
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
      paths: Record<
        string,
        Record<string, { parameters?: Array<{ name: string }>; responses: Record<string, unknown> }>
      >;
    };

    for (const operation of expectedDeveloperOpenApiOperations) {
      expect(contract.paths[operation.path]?.[operation.method]?.responses[operation.status]).toBeDefined();
    }
    expect(
      contract.paths["/openapi/v1/knowledge-bases/{knowledgeBaseId}/source-files"]?.get?.parameters?.map(
        (parameter) => parameter.name
      )
    ).toEqual(
      expect.arrayContaining([
        "fileNameQuery",
        "fileIdQuery",
        "processingStatus",
        "processingStage",
        "modelInvocationStatus",
        "generatedOutputStatus",
        "startedFrom",
        "startedTo",
        "endedFrom",
        "endedTo",
        "errorState",
        "errorCodeQuery",
        "actionState"
      ])
    );
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
      sourceFileId: "source-guide",
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

  it("filters source files through Developer OpenAPI using the shared bounded filters", async () => {
    const { app } = createApp();
    const response = await app.request(
      "/openapi/v1/knowledge-bases/kb-seeded/source-files?fileNameQuery=guide&processingStatus=completed&generatedOutputStatus=visible&limit=10",
      {
        headers: authHeaders()
      }
    );
    const body = (await response.json()) as {
      items: Array<{ fileId: string; originalFilename: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.items).toEqual([
      expect.objectContaining({
        fileId: "source-guide",
        originalFilename: "guide.md"
      })
    ]);
  });

  it("passes every Developer OpenAPI source-file filter to the repository before pagination", async () => {
    const { app, repositories } = createApp();
    const listSourceFiles = repositories.files?.listSourceFiles;
    let capturedInput: (SourceFileListFilters & { cursor: string | null; limit: number }) | null = null;

    if (!listSourceFiles || !repositories.files) {
      throw new Error("Source file list dependency is missing from the test fixture.");
    }

    repositories.files.listSourceFiles = async (input) => {
      capturedInput = input;
      return listSourceFiles(input);
    };

    const response = await app.request(
      "/openapi/v1/knowledge-bases/kb-seeded/source-files?limit=10&fileNameQuery=guide&fileIdQuery=source-g&processingStatus=completed&processingStage=release_activation&modelInvocationStatus=not_recorded&generatedOutputStatus=visible&startedFrom=2026-06-14T00%3A00%3A00.000Z&startedTo=2026-06-15T00%3A00%3A00.000Z&endedFrom=2026-06-14T00%3A00%3A00.000Z&endedTo=2026-06-15T00%3A00%3A00.000Z&errorState=without_error&errorCodeQuery=TIMEOUT&actionState=openable",
      {
        headers: authHeaders()
      }
    );

    expect(response.status).toBe(200);
    expect(capturedInput).toMatchObject({
      limit: 10,
      cursor: null,
      fileNameQuery: "guide",
      fileIdQuery: "source-g",
      processingStatus: "completed",
      processingStage: "release_activation",
      modelInvocationStatus: "not_recorded",
      generatedOutputStatus: "visible",
      startedFrom: "2026-06-14T00:00:00.000Z",
      startedTo: "2026-06-15T00:00:00.000Z",
      endedFrom: "2026-06-14T00:00:00.000Z",
      endedTo: "2026-06-15T00:00:00.000Z",
      errorState: "without_error",
      errorCodeQuery: "TIMEOUT",
      actionState: "openable"
    });
  });

  it("rejects invalid Developer OpenAPI source-file filters before repository reads", async () => {
    const { app, repositories } = createApp();
    const listSourceFiles = repositories.files?.listSourceFiles;
    let listCount = 0;

    if (!listSourceFiles || !repositories.files) {
      throw new Error("Source file list dependency is missing from the test fixture.");
    }

    repositories.files.listSourceFiles = async (input) => {
      listCount += 1;
      return listSourceFiles(input);
    };

    const response = await app.request(
      "/openapi/v1/knowledge-bases/kb-seeded/source-files?processingStatus=archived",
      {
        headers: authHeaders()
      }
    );
    const body = (await response.json()) as {
      error: { code: string; details?: Record<string, unknown> };
    };

    expect(response.status).toBe(422);
    expect(body.error).toMatchObject({
      code: "VALIDATION_ERROR",
      details: {
        code: "INVALID_SOURCE_FILE_FILTER"
      }
    });
    expect(JSON.stringify(body)).not.toContain("focowiki.");
    expect(listCount).toBe(0);
  });

  it("deletes unpublished source-file tasks through Developer OpenAPI and preserves safe results", async () => {
    const { app } = createApp();
    const form = new FormData();
    form.append("files", new File(["# Obsolete"], "obsolete.md", { type: "text/markdown" }));
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
      throw new Error("Upload did not return a source file ID.");
    }

    const missingSourceFileId = "source-file-99999999-9999-4999-8999-999999999999";
    const deletionResponse = await app.request(
      "/openapi/v1/knowledge-bases/kb-seeded/source-files/task-deletions",
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "content-type": "application/json"
        },
        body: JSON.stringify({
          sourceFileIds: [uploadedFileId, missingSourceFileId]
        })
      }
    );
    const deletionBody = (await deletionResponse.json()) as {
      results: Array<{ sourceFileId: string; result: string; reason?: string }>;
      summary: { deleted: number; hidden: number; skipped: number };
    };
    const detailAfterDeletion = await app.request(
      `/openapi/v1/knowledge-bases/kb-seeded/source-files/${uploadedFileId}`,
      {
        headers: authHeaders()
      }
    );

    expect(uploadResponse.status).toBe(202);
    expect(deletionResponse.status).toBe(200);
    expect(deletionBody).toEqual({
      results: [
        {
          sourceFileId: uploadedFileId,
          result: "deleted"
        },
        {
          sourceFileId: missingSourceFileId,
          result: "skipped",
          reason: "missing"
        }
      ],
      summary: {
        deleted: 1,
        hidden: 0,
        skipped: 1
      }
    });
    expect(JSON.stringify(deletionBody)).not.toContain("tenant/demo");
    expect(detailAfterDeletion.status).toBe(404);
  });

  it("hides completed visible source-file tasks while generated file reads remain available", async () => {
    const { app, repositories } = createApp();
    const visibleSourceFileId = "source-file-44444444-4444-4444-8444-444444444444";
    const baseSourceFile = repositories.sourceFiles.get("source-guide");

    if (!baseSourceFile) {
      throw new Error("Visible source file fixture is missing.");
    }

    repositories.sourceFiles.set(visibleSourceFileId, {
      ...baseSourceFile,
      id: visibleSourceFileId,
      originalName: "visible-task.md",
      objectKey: "tenant/demo/knowledge-bases/kb-seeded/sources/visible-task.md",
      taskDeletedAt: null,
      deletedAt: null
    });

    const deletionResponse = await app.request(
      "/openapi/v1/knowledge-bases/kb-seeded/source-files/task-deletions",
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "content-type": "application/json"
        },
        body: JSON.stringify({
          sourceFileIds: [visibleSourceFileId]
        })
      }
    );
    const deletionBody = (await deletionResponse.json()) as {
      results: Array<{
        sourceFileId: string;
        result: string;
        generatedFileId?: string;
        generatedFilePath?: string;
      }>;
    };
    const detailAfterDeletion = await app.request(
      `/openapi/v1/knowledge-bases/kb-seeded/source-files/${visibleSourceFileId}`,
      {
        headers: authHeaders()
      }
    );
    const generatedContent = await app.request(
      "/openapi/v1/knowledge-bases/kb-seeded/files/content?path=pages%2Fguide.md",
      {
        headers: authHeaders()
      }
    );

    expect(deletionResponse.status).toBe(200);
    expect(deletionBody.results).toEqual([
      {
        sourceFileId: visibleSourceFileId,
        result: "hidden",
        generatedFileId: "bundle-guide",
        generatedFilePath: "pages/guide.md"
      }
    ]);
    expect(detailAfterDeletion.status).toBe(404);
    expect(generatedContent.status).toBe(200);
  });

  it("does not expose task-hidden source-file rows through Developer OpenAPI source-file reads", async () => {
    const { app } = createApp();
    const [listResponse, detailResponse] = await Promise.all([
      app.request("/openapi/v1/knowledge-bases/kb-seeded/source-files", {
        headers: authHeaders()
      }),
      app.request("/openapi/v1/knowledge-bases/kb-seeded/source-files/source-hidden", {
        headers: authHeaders()
      })
    ]);
    const listBody = (await listResponse.json()) as {
      items: Array<{ fileId: string }>;
    };

    expect(listResponse.status).toBe(200);
    expect(listBody.items.map((item) => item.fileId)).toEqual(["source-guide"]);
    expect(detailResponse.status).toBe(404);
  });

  it("returns active generated file IDs from source-file reads when stored source metadata is stale", async () => {
    const { app } = createApp({ staleSourceGeneratedBundleFileId: true });
    const listResponse = await app.request("/openapi/v1/knowledge-bases/kb-seeded/source-files", {
      headers: authHeaders()
    });
    const listBody = (await listResponse.json()) as {
      items: Array<{
        sourceFileId: string;
        generatedFileId: string | null;
        generatedFilePath: string | null;
        generatedFileAvailable: boolean;
      }>;
    };
    const sourceFile = listBody.items.find((item) => item.sourceFileId === "source-guide");

    if (!sourceFile?.generatedFileId || !sourceFile.generatedFilePath) {
      throw new Error("Source file fixture did not return a generated output.");
    }

    const [sourceDetailResponse, fileResponse, contentResponse, relatedResponse] =
      await Promise.all([
        app.request("/openapi/v1/knowledge-bases/kb-seeded/source-files/source-guide", {
          headers: authHeaders()
        }),
        app.request(`/openapi/v1/knowledge-bases/kb-seeded/files/${sourceFile.generatedFileId}`, {
          headers: authHeaders()
        }),
        app.request(
          `/openapi/v1/knowledge-bases/kb-seeded/files/${sourceFile.generatedFileId}/content`,
          {
            headers: authHeaders()
          }
        ),
        app.request(
          `/openapi/v1/knowledge-bases/kb-seeded/files/${sourceFile.generatedFileId}/related`,
          {
            headers: authHeaders()
          }
        )
      ]);
    const sourceDetailBody = (await sourceDetailResponse.json()) as {
      file: { generatedFileId: string | null; generatedFilePath: string | null };
    };

    expect(sourceFile).toMatchObject({
      generatedFileId: "bundle-guide",
      generatedFilePath: "pages/guide.md",
      generatedFileAvailable: true
    });
    expect(sourceDetailBody.file).toMatchObject({
      generatedFileId: "bundle-guide",
      generatedFilePath: "pages/guide.md"
    });
    expect(fileResponse.status).toBe(200);
    expect(contentResponse.status).toBe(200);
    expect(relatedResponse.status).toBe(200);
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
