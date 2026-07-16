import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApiApp, createPublicOpenApiApp } from "../src/server.js";
import type {
  AdminRepositories,
  BundleFileRecord,
  BundleTreeEntryRecord,
  KnowledgeBaseRecord,
  SourceFileListFilters,
  SourceFileEventDraft,
  SourceFileEventRecord,
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
  type RuntimeConfig
} from "../src/config.js";
import type { WorkerJobDraft, WorkerJobRecord, WorkerJobRepository } from "../src/db/worker-job-repository.js";
import type {
  ResourceOperationKind,
  ResourceOperationRecord,
  SourceDirectoryRecord,
  SourceResourceFileRecord
} from "../src/domain/source-resource.js";
import {
  emptyUploadSessionCounts,
  UploadSessionError,
  type UploadSessionEntryRecord,
  type UploadSessionRecord
} from "../src/domain/upload-session.js";
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
  { method: "get", path: "/openapi/v2/health", status: "200" },
  { method: "get", path: "/openapi/v2/version", status: "200" },
  { method: "get", path: "/openapi/v2/openapi.json", status: "200" },
  { method: "get", path: "/openapi/v2/knowledge-bases", status: "200" },
  { method: "post", path: "/openapi/v2/knowledge-bases", status: "201" },
  { method: "get", path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}", status: "200" },
  { method: "patch", path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}", status: "200" },
  { method: "delete", path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}", status: "202" },
  { method: "post", path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions", status: "201" },
  { method: "post", path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions/{uploadSessionId}/entries", status: "200" },
  { method: "post", path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions/{uploadSessionId}/seal", status: "200" },
  { method: "post", path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions/{uploadSessionId}/content", status: "200" },
  { method: "get", path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions/{uploadSessionId}", status: "200" },
  { method: "delete", path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions/{uploadSessionId}", status: "200" },
  { method: "post", path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions/{uploadSessionId}/reconcile", status: "200" },
  { method: "post", path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions/{uploadSessionId}/finalize", status: "202" },
  { method: "get", path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files", status: "200" },
  {
    method: "get",
    path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}",
    status: "200"
  },
  {
    method: "patch",
    path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}",
    status: "202"
  },
  {
    method: "delete",
    path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}",
    status: "202"
  },
  {
    method: "get",
    path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}/content",
    status: "200"
  },
  {
    method: "put",
    path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}/content",
    status: "202"
  },
  {
    method: "get",
    path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}/events",
    status: "200"
  },
  {
    method: "post",
    path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}/retry",
    status: "202"
  },
  { method: "get", path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-directories", status: "200" },
  { method: "get", path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-directories/{directoryId}", status: "200" },
  { method: "patch", path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-directories/{directoryId}", status: "202" },
  { method: "delete", path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-directories/{directoryId}", status: "202" },
  { method: "get", path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/operations", status: "200" },
  { method: "get", path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/operations/{operationId}", status: "200" },
  { method: "get", path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/tree", status: "200" },
  { method: "get", path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/content", status: "200" },
  { method: "get", path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/search", status: "200" },
  { method: "get", path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/graph/expand", status: "200" },
  { method: "get", path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/graph/insights", status: "200" },
  { method: "get", path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/{fileId}", status: "200" },
  {
    method: "get",
    path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/{fileId}/content",
    status: "200"
  },
  {
    method: "get",
    path: "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/{fileId}/related",
    status: "200"
  },
  { method: "post", path: "/openapi/v2/webhooks", status: "201" },
  { method: "get", path: "/openapi/v2/webhooks", status: "200" },
  { method: "delete", path: "/openapi/v2/webhooks/{webhookId}", status: "200" },
  { method: "get", path: "/openapi/v2/webhook-deliveries", status: "200" },
  { method: "post", path: "/openapi/v2/webhook-deliveries/{deliveryId}/redeliver", status: "202" }
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
      generationBatchSize: 50,
      fileProcessingConcurrency: 1,
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
    ],
    [
      "tenant/demo/knowledge-bases/kb-seeded/sources/source-guide/guide.md",
      "# Guide"
    ],
    [
      "tenant/demo/knowledge-bases/kb-seeded/releases/release-seeded/bundle/_graph/insights.json",
      JSON.stringify({
        generated_at: now,
        insights: [
          {
            insightId: "insight-seeded",
            severity: "info",
            title: "Useful graph cluster",
            filePaths: ["pages/guide.md"]
          }
        ]
      })
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

}

type TestRepositoryOptions = {
  staleSourceGeneratedBundleFileId?: boolean;
};

function createRepositories(options: TestRepositoryOptions = {}): AdminRepositories & {
  sourceFiles: Map<string, SourceFileRecord>;
  webhookDeliveries: Map<string, WebhookDeliveryRecord>;
} {
  const keyHash = hashPublicOpenApiKey(developerKey);
  let knowledgeBase: KnowledgeBaseRecord & {
    resourceRevision: number;
    catalogGeneration: number;
  } = {
    id: "kb-seeded",
    name: "Seeded KB",
    description: null,
    activeReleaseId: "release-seeded",
    resourceRevision: 1,
    catalogGeneration: 0,
    createdAt: now,
    updatedAt: now
  };
  let knowledgeBaseDeleted = false;
  const sourceFile: SourceFileRecord = {
    id: "source-guide",
    knowledgeBaseId: "kb-seeded",
    name: "guide.md",
    relativePath: "guide.md",
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
    name: "hidden.md",
    relativePath: "hidden.md",
    objectKey: "tenant/demo/knowledge-bases/kb-seeded/sources/source-hidden/hidden.md",
    generatedBundleFileId: "bundle-hidden",
    generatedBundleFilePath: "pages/hidden.md",
    taskDeletedAt: now
  };
  const deletedSourceFile: SourceFileRecord = {
    ...sourceFile,
    id: "source-deleted",
    name: "deleted.md",
    relativePath: "deleted.md",
    objectKey: "tenant/demo/knowledge-bases/kb-seeded/sources/source-deleted/deleted.md",
    generatedBundleFileId: "bundle-deleted",
    generatedBundleFilePath: "pages/deleted.md",
    deletedAt: now
  };
  const sourceFiles = new Map<string, SourceFileRecord>([
    [sourceFile.id, sourceFile],
    [hiddenSourceFile.id, hiddenSourceFile],
    [deletedSourceFile.id, deletedSourceFile]
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
  const graphInsightsBundleFile: BundleFileRecord = {
    ...bundleFile,
    id: "bundle-graph-insights",
    sourceFileId: null,
    fileKind: "graph_insight",
    logicalPath: "_graph/insights.json",
    objectKey: "tenant/demo/knowledge-bases/kb-seeded/releases/release-seeded/bundle/_graph/insights.json",
    title: "Graph insights",
    description: "Graph quality and navigation insights.",
    frontmatter: {}
  };
  const deletedBundleFile: BundleFileRecord = {
    ...bundleFile,
    id: "bundle-deleted",
    sourceFileId: "source-deleted",
    logicalPath: "pages/deleted.md",
    objectKey: "tenant/demo/knowledge-bases/kb-seeded/releases/release-seeded/bundle/pages/deleted.md",
    title: "Deleted",
    frontmatter: { type: "page", title: "Deleted" }
  };
  const bundleFiles = new Map<string, BundleFileRecord>([
    [bundleFile.id, bundleFile],
    [graphInsightsBundleFile.id, graphInsightsBundleFile],
    [hiddenBundleFile.id, hiddenBundleFile],
    [deletedBundleFile.id, deletedBundleFile]
  ]);
  const sourceFileEvents: SourceFileEventRecord[] = [];
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
  const pagesTreeEntry: BundleTreeEntryRecord = {
    id: "tree-pages",
    knowledgeBaseId: "kb-seeded",
    releaseId: "release-seeded",
    parentPath: "",
    name: "pages",
    logicalPath: "pages",
    sortKey: "0:pages",
    entryType: "directory",
    bundleFileId: null,
    sourceFileId: null,
    fileKind: null,
    childCount: 1
  };
  const deletedTreeEntry: BundleTreeEntryRecord = {
    id: "tree-deleted",
    knowledgeBaseId: "kb-seeded",
    releaseId: "release-seeded",
    parentPath: "pages",
    name: "deleted.md",
    logicalPath: "pages/deleted.md",
    sortKey: "1:deleted.md",
    entryType: "file",
    bundleFileId: "bundle-deleted",
    sourceFileId: "source-deleted",
    fileKind: "page",
    childCount: 0
  };
  const treeEntries = [pagesTreeEntry, deletedTreeEntry, treeEntry];
  const isBundleFileVisible = (file: BundleFileRecord) => {
    if (!file.sourceFileId) {
      return true;
    }

    const source = sourceFiles.get(file.sourceFileId);
    return Boolean(source && !source.deletedAt);
  };
  const isTreeEntryVisible = (entry: BundleTreeEntryRecord) => {
    if (!entry.sourceFileId) {
      return true;
    }

    const source = sourceFiles.get(entry.sourceFileId);
    return Boolean(source && !source.deletedAt);
  };
  const isSourceVisible = (sourceFileId: string) => {
    const source = sourceFiles.get(sourceFileId);
    return Boolean(source && !source.deletedAt && !source.taskDeletedAt);
  };
  const paginateTreeEntries = (
    entries: BundleTreeEntryRecord[],
    limit: number,
    cursor: string | null | undefined
  ) => {
    const sortedEntries = [...entries].sort((left, right) =>
      left.sortKey === right.sortKey ? left.id.localeCompare(right.id) : left.sortKey.localeCompare(right.sortKey)
    );
    const startIndex = cursor
      ? sortedEntries.findIndex((entry) => `${entry.sortKey}:${entry.id}` === cursor) + 1
      : 0;
    const pageEntries = sortedEntries.slice(Math.max(startIndex, 0), Math.max(startIndex, 0) + limit);
    const lastEntry = pageEntries.at(-1);

    return {
      items: pageEntries,
      nextCursor:
        startIndex + pageEntries.length < sortedEntries.length && lastEntry
          ? `${lastEntry.sortKey}:${lastEntry.id}`
          : null
    };
  };
  const webhooks = new Map<string, WebhookSubscriptionRecord>();
  const webhookDeliveries = new Map<string, WebhookDeliveryRecord>();
  const resourceOperations = new Map<string, ResourceOperationRecord>();
  const resourceOperationIdempotency = new Map<string, ResourceOperationRecord>();
  const uploadSessionRecords = new Map<string, UploadSessionRecord>();
  const uploadEntryRecords = new Map<string, UploadSessionEntryRecord>();
  const sourceDirectory: SourceDirectoryRecord = {
    id: "source-directory-pages",
    knowledgeBaseId: knowledgeBase.id,
    parentDirectoryId: null,
    name: "pages",
    relativePath: "pages",
    depth: 1,
    resourceRevision: 1,
    directFileCount: 1,
    descendantFileCount: 1,
    deleting: false,
    createdAt: now,
    updatedAt: now
  };

  const toSourceResource = (file: SourceFileRecord): SourceResourceFileRecord => ({
    id: file.id,
    knowledgeBaseId: file.knowledgeBaseId,
    directoryId: sourceDirectory.id,
    name: file.relativePath,
    relativePath: `pages/${file.relativePath}`,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    checksumSha256: file.checksumSha256,
    resourceRevision: 1,
    contentRevision: 1,
    activeRevisionId: `source-revision-${file.id}`,
    processingState:
      file.processingStatus === "running"
        ? "running"
        : file.processingStatus === "failed"
          ? "failed"
          : file.processingStatus === "completed"
            ? "completed"
            : "queued",
    currentStage: file.processingStage ?? "upload_storage",
    processingErrorCode: file.processingErrorCode ?? null,
    generatedOutputStatus: file.generatedOutputStatus ?? "pending",
    generatedPath: file.generatedBundleFilePath ?? null,
    deleting: Boolean(file.deletedAt || file.taskDeletedAt),
    createdAt: file.createdAt
  });

  const createResourceOperation = (input: {
    operationId: string;
    kind: ResourceOperationKind;
    expectedResourceRevision: number | null;
  }): ResourceOperationRecord => {
    const operation: ResourceOperationRecord = {
      id: input.operationId,
      knowledgeBaseId: knowledgeBase.id,
      kind: input.kind,
      state: "accepted",
      expectedResourceRevision: input.expectedResourceRevision,
      candidateCatalogGeneration: knowledgeBase.catalogGeneration + 1,
      result: null,
      errorCode: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null
    };
    resourceOperations.set(operation.id, operation);
    return operation;
  };

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
        return { items: knowledgeBaseDeleted ? [] : [knowledgeBase], nextCursor: null };
      },
      async createKnowledgeBase(input) {
        return {
          id: "kb-created",
          name: input.name,
          description: input.description,
          activeReleaseId: null,
          catalogGeneration: 0,
          createdAt: now,
          updatedAt: now
        };
      },
      async getKnowledgeBase(id) {
        return id === knowledgeBase.id && !knowledgeBaseDeleted ? knowledgeBase : null;
      }
    },
    uploadSessions: {
      async createSession(input) {
        const replay = Array.from(uploadSessionRecords.values()).find(
          (session) =>
            session.knowledgeBaseId === input.knowledgeBaseId &&
            session.idempotencyKey === input.idempotencyKey
        );
        if (replay) {
          if (
            replay.declaredFileCount !== input.declaredFileCount ||
            replay.declaredByteCount !== input.declaredByteCount
          ) {
            throw new UploadSessionError("UPLOAD_IDEMPOTENCY_CONFLICT");
          }
          return replay;
        }
        const session: UploadSessionRecord = {
          id: input.id,
          knowledgeBaseId: input.knowledgeBaseId,
          state: "draft",
          idempotencyKey: input.idempotencyKey,
          manifestFingerprint: null,
          declaredFileCount: input.declaredFileCount,
          declaredByteCount: input.declaredByteCount,
          counts: emptyUploadSessionCounts(),
          errorCode: null,
          expiresAt: input.expiresAt,
          createdAt: now,
          updatedAt: now,
          completedAt: null
        };
        uploadSessionRecords.set(session.id, session);
        return session;
      },
      async getSession({ knowledgeBaseId, sessionId }) {
        const session = uploadSessionRecords.get(sessionId);
        return session?.knowledgeBaseId === knowledgeBaseId ? session : null;
      },
      async addManifestEntries({ knowledgeBaseId, sessionId, entries }) {
        const session = uploadSessionRecords.get(sessionId);
        if (!session || session.knowledgeBaseId !== knowledgeBaseId) {
          throw new Error("Unknown test upload session");
        }
        for (const entry of entries) {
          uploadEntryRecords.set(entry.id, {
            id: entry.id,
            sessionId,
            relativePath: entry.path.relativePath,
            pathKey: entry.path.pathKey,
            directoryPath: entry.path.directoryPath,
            name: entry.path.name,
            declaredSize: entry.declaredSize,
            receivedSize: null,
            checksumSha256: entry.checksumSha256,
            receivedChecksumSha256: null,
            disposition: "pending",
            transferState: "pending",
            stagingObjectKey: null,
            sourceDirectoryId: entry.path.directoryPath ? sourceDirectory.id : null,
            sourceFileId: entry.sourceFileId,
            existingResourceRevision: null,
            generatedPath: entry.path.generatedPath,
            errorCode: null
          });
        }
        const updated = {
          ...session,
          state: "manifest_building" as const,
          counts: { ...session.counts, selected: session.counts.selected + entries.length },
          updatedAt: now
        };
        uploadSessionRecords.set(sessionId, updated);
        return updated;
      },
      async sealManifest({ knowledgeBaseId, sessionId, manifestFingerprint }) {
        const session = uploadSessionRecords.get(sessionId);
        if (!session || session.knowledgeBaseId !== knowledgeBaseId) {
          throw new Error("Unknown test upload session");
        }
        const entries = Array.from(uploadEntryRecords.values()).filter(
          (entry) => entry.sessionId === sessionId
        );
        for (const entry of entries) {
          uploadEntryRecords.set(entry.id, {
            ...entry,
            disposition: "upload_required",
            transferState: "missing"
          });
        }
        const updated = {
          ...session,
          state: "manifest_sealed" as const,
          manifestFingerprint,
          counts: { ...session.counts, uploadRequired: entries.length },
          updatedAt: now
        };
        uploadSessionRecords.set(sessionId, updated);
        return updated;
      },
      async getEntry({ knowledgeBaseId, sessionId, entryId }) {
        const session = uploadSessionRecords.get(sessionId);
        const entry = uploadEntryRecords.get(entryId);
        return session?.knowledgeBaseId === knowledgeBaseId && entry?.sessionId === sessionId
          ? entry
          : null;
      },
      async markEntryUploaded(input) {
        const entry = uploadEntryRecords.get(input.entryId);
        if (!entry || entry.sessionId !== input.sessionId) {
          throw new Error("Unknown test upload entry");
        }
        const updated = {
          ...entry,
          receivedSize: input.receivedSize,
          receivedChecksumSha256: input.receivedChecksumSha256,
          stagingObjectKey: input.stagingObjectKey,
          transferState: "uploaded" as const
        };
        uploadEntryRecords.set(entry.id, updated);
        const session = uploadSessionRecords.get(input.sessionId);
        if (session) {
          uploadSessionRecords.set(session.id, {
            ...session,
            state: "uploading",
            counts: { ...session.counts, uploaded: session.counts.uploaded + 1 },
            updatedAt: now
          });
        }
        return updated;
      },
      async markEntryFailed({ entryId, errorCode }) {
        const entry = uploadEntryRecords.get(entryId);
        if (entry) {
          uploadEntryRecords.set(entryId, {
            ...entry,
            transferState: "failed",
            errorCode
          });
        }
      },
      async listEntries({ knowledgeBaseId, sessionId, transferState, limit, cursor }) {
        const session = uploadSessionRecords.get(sessionId);
        if (!session || session.knowledgeBaseId !== knowledgeBaseId) {
          return { items: [], nextCursor: null };
        }
        const entries = Array.from(uploadEntryRecords.values())
          .filter(
            (entry) =>
              entry.sessionId === sessionId &&
              (!transferState || entry.transferState === transferState)
          )
          .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
        const start = cursor ? Math.max(0, entries.findIndex((entry) => entry.id === cursor) + 1) : 0;
        const items = entries.slice(start, start + limit);
        return {
          items,
          nextCursor: start + items.length < entries.length ? items.at(-1)?.id ?? null : null
        };
      },
      async reconcileReservations({ knowledgeBaseId, sessionId }) {
        const session = uploadSessionRecords.get(sessionId);
        if (!session || session.knowledgeBaseId !== knowledgeBaseId) {
          throw new Error("Unknown test upload session");
        }
        return session;
      },
      async finalizeSession({ knowledgeBaseId, sessionId }) {
        const session = uploadSessionRecords.get(sessionId);
        if (!session || session.knowledgeBaseId !== knowledgeBaseId) {
          throw new Error("Unknown test upload session");
        }
        const updated = { ...session, state: "finalizing" as const, updatedAt: now };
        uploadSessionRecords.set(sessionId, updated);
        return updated;
      },
      async finalizeEntryBatch({ knowledgeBaseId, sessionId }) {
        const session = uploadSessionRecords.get(sessionId);
        if (!session || session.knowledgeBaseId !== knowledgeBaseId) {
          throw new Error("Unknown test upload session");
        }
        return { session, processedCount: 0, completed: false, cancelled: false };
      },
      async failFinalization({ knowledgeBaseId, sessionId, errorCode, now: failedAt }) {
        const session = uploadSessionRecords.get(sessionId);
        if (!session || session.knowledgeBaseId !== knowledgeBaseId) {
          throw new Error("Unknown test upload session");
        }
        const updated = {
          ...session,
          state: "failed" as const,
          errorCode,
          updatedAt: failedAt
        };
        uploadSessionRecords.set(sessionId, updated);
        return updated;
      },
      async completeSession({ knowledgeBaseId, sessionId, now: completedAt }) {
        const session = uploadSessionRecords.get(sessionId);
        if (!session || session.knowledgeBaseId !== knowledgeBaseId) {
          throw new Error("Unknown test upload session");
        }
        const updated = {
          ...session,
          state: "completed" as const,
          counts: { ...session.counts, finalized: session.counts.uploadRequired },
          updatedAt: completedAt,
          completedAt
        };
        uploadSessionRecords.set(sessionId, updated);
        return updated;
      },
      async cancelSession({ knowledgeBaseId, sessionId, now: cancelledAt }) {
        const session = uploadSessionRecords.get(sessionId);
        if (!session || session.knowledgeBaseId !== knowledgeBaseId) {
          throw new Error("Unknown test upload session");
        }
        const entries = Array.from(uploadEntryRecords.values()).filter(
          (entry) => entry.sessionId === sessionId
        );
        const updated = {
          ...session,
          state: "cancelled" as const,
          updatedAt: cancelledAt,
          completedAt: cancelledAt
        };
        uploadSessionRecords.set(sessionId, updated);
        return {
          session: updated,
          stagingObjectKeys: entries.flatMap((entry) => entry.stagingObjectKey ?? [])
        };
      },
      async expireSessions() {
        return [];
      }
    },
    sourceResources: {
      async updateKnowledgeBase(input) {
        if (
          knowledgeBaseDeleted ||
          input.knowledgeBaseId !== knowledgeBase.id ||
          input.expectedResourceRevision !== knowledgeBase.resourceRevision
        ) {
          return null;
        }
        knowledgeBase = {
          ...knowledgeBase,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined ? {} : { description: input.description }),
          resourceRevision: knowledgeBase.resourceRevision + 1,
          catalogGeneration: knowledgeBase.catalogGeneration + 1,
          updatedAt: now
        };
        return knowledgeBase;
      },
      async listDirectories({ knowledgeBaseId, parentDirectoryId }) {
        return {
          items:
            !knowledgeBaseDeleted &&
            knowledgeBaseId === knowledgeBase.id &&
            parentDirectoryId === null &&
            !sourceDirectory.deleting
              ? [sourceDirectory]
              : [],
          nextCursor: null
        };
      },
      async getDirectory({ knowledgeBaseId, directoryId }) {
        return !knowledgeBaseDeleted &&
          knowledgeBaseId === knowledgeBase.id &&
          directoryId === sourceDirectory.id &&
          !sourceDirectory.deleting
          ? sourceDirectory
          : null;
      },
      async listSourceFiles({ knowledgeBaseId, directoryId, filters, limit }) {
        const items = Array.from(sourceFiles.values())
          .filter(
            (file) =>
              !knowledgeBaseDeleted &&
              file.knowledgeBaseId === knowledgeBaseId &&
              !file.deletedAt &&
              !file.taskDeletedAt &&
              (directoryId === undefined || directoryId === sourceDirectory.id)
          )
          .map(toSourceResource)
          .filter((file) =>
            (!filters.pathQuery || file.relativePath.toLowerCase().includes(filters.pathQuery.toLowerCase()))
            && (!filters.sourceFileIdPrefix || file.id.startsWith(filters.sourceFileIdPrefix))
            && (!filters.processingState || file.processingState === filters.processingState)
            && (!filters.currentStage || file.currentStage === filters.currentStage)
            && (!filters.generatedOutputStatus || file.generatedOutputStatus === filters.generatedOutputStatus)
          )
          .slice(0, limit);
        return { items, nextCursor: null };
      },
      async getSourceFile({ knowledgeBaseId, sourceFileId }) {
        const file = sourceFiles.get(sourceFileId);
        return file &&
          !knowledgeBaseDeleted &&
          file.knowledgeBaseId === knowledgeBaseId &&
          !file.deletedAt &&
          !file.taskDeletedAt
          ? toSourceResource(file)
          : null;
      },
      async getSourceFileContentDescriptor({ knowledgeBaseId, sourceFileId }) {
        const file = sourceFiles.get(sourceFileId);
        return file &&
          !knowledgeBaseDeleted &&
          file.knowledgeBaseId === knowledgeBaseId &&
          !file.deletedAt &&
          !file.taskDeletedAt
          ? {
              objectKey: file.objectKey,
              contentType: file.contentType,
              sizeBytes: file.sizeBytes,
              checksumSha256: file.checksumSha256,
              contentRevision: 1
            }
          : null;
      },
      async createOperation(input) {
        const idempotencyScope = `${input.knowledgeBaseId}:${input.idempotencyKey}`;
        const existing = resourceOperationIdempotency.get(idempotencyScope);
        if (existing) return { operation: existing, replayed: true };
        const operation = createResourceOperation({
          operationId: input.operationId,
          kind: input.kind,
          expectedResourceRevision: input.expectedResourceRevision
        });
        resourceOperationIdempotency.set(idempotencyScope, operation);
        return { operation, replayed: false };
      },
      async prepareOperation({ operationId }) {
        const operation = resourceOperations.get(operationId);
        if (!operation) throw new Error("Unknown test resource operation");
        const prepared = { ...operation, state: "processing" as const, updatedAt: now };
        resourceOperations.set(operationId, prepared);
        return {
          operation: prepared,
          sourceFileId: null,
          requiresSourceProcessing: false,
          requiresPublication: true,
          requiresContinuation: false,
          directoryDeletion: null
        };
      },
      async failOperation({ operationId, errorCode, failedAt }) {
        const operation = resourceOperations.get(operationId);
        if (!operation) return { operation: null, objectKeys: [] };
        const failed = {
          ...operation,
          state: "failed" as const,
          errorCode,
          updatedAt: failedAt,
          completedAt: failedAt
        };
        resourceOperations.set(operationId, failed);
        return { operation: failed, objectKeys: [] };
      },
      async failSourceFileCandidateOperation() {
        return { operation: null, objectKeys: [] };
      },
      async getOperation({ knowledgeBaseId, operationId }) {
        const operation = resourceOperations.get(operationId);
        return operation?.knowledgeBaseId === knowledgeBaseId ? operation : null;
      },
      async listOperations({ knowledgeBaseId, states, limit }) {
        return {
          items: Array.from(resourceOperations.values())
            .filter(
              (operation) =>
                operation.knowledgeBaseId === knowledgeBaseId &&
                (!states?.length || states.includes(operation.state))
            )
            .slice(0, limit),
          nextCursor: null
        };
      },
      async acceptDirectoryDeletion(input) {
        const operation = createResourceOperation({
          operationId: input.operationId,
          kind: "source_directory_delete",
          expectedResourceRevision: input.expectedResourceRevision
        });
        sourceDirectory.deleting = true;
        return {
          operation,
          replayed: false,
          deletionIntentId: input.deletionIntentId,
          effectiveDirectoryId: sourceDirectory.id,
          affectedDirectoryCount: 1,
          affectedFileCount: sourceDirectory.descendantFileCount
        };
      },
      async acceptSourceFileDeletion(input) {
        const file = sourceFiles.get(input.sourceFileId);
        if (file) sourceFiles.set(file.id, { ...file, deletedAt: input.deletedAt });
        return {
          operation: createResourceOperation({
            operationId: input.operationId,
            kind: "source_file_delete",
            expectedResourceRevision: input.expectedResourceRevision
          }),
          replayed: false,
          deletionIntentId: input.deletionIntentId,
          sourceFileId: input.sourceFileId
        };
      },
      async acceptKnowledgeBaseDeletion(input) {
        knowledgeBaseDeleted = true;
        return {
          operation: createResourceOperation({
            operationId: input.operationId,
            kind: "knowledge_base_delete",
            expectedResourceRevision: input.expectedResourceRevision
          }),
          replayed: false,
          deletionIntentId: input.deletionIntentId,
          affectedDirectoryCount: 1,
          affectedFileCount: sourceFiles.size
        };
      }
    },
    files: {
      async createRelease() {
        return undefined;
      },
      async createBundleFiles(files) {
        for (const file of files) {
          bundleFiles.set(file.id, file);
        }
      },
      async getReleaseReadSummary({ knowledgeBaseId, releaseId }) {
        const searchableFileCount = Array.from(bundleFiles.values())
          .filter((file) => file.releaseId === releaseId).length;
        const graphDocumentCount = Array.from(bundleFiles.values())
          .some((file) => file.sourceFileId === "source-guide") ? 1 : 0;
        return {
          releaseId,
          knowledgeBaseId,
          searchableFileCount,
          treeNodeCount: 0,
          graphDocumentCount,
          graphRelationshipCount: graphDocumentCount > 0 ? 1 : 0,
          graphNodeCount: graphDocumentCount,
          graphEdgeCount: graphDocumentCount > 0 ? 1 : 0
        };
      },
      async getReleaseGraphInsights({ knowledgeBaseId, releaseId }) {
        return {
          knowledgeBaseId,
          releaseId,
          generatedAt: now,
          insights: [
            {
              insightId: "insight-seeded",
              severity: "info",
              title: "Useful graph cluster",
              filePaths: ["pages/guide.md"]
            }
          ]
        };
      },
      async createBundleTreeEntries() {
        return undefined;
      },
      async createSourceFileRetryAttempt(input) {
        const sourceFile = sourceFiles.get(input.sourceFileId);

        if (sourceFile) {
          sourceFiles.set(input.sourceFileId, {
            ...sourceFile,
            processingStatus: "queued",
            processingStage: "upload_storage",
            processingStartedAt: input.startedAt,
            processingEndedAt: null,
            processingErrorCode: null,
            processingErrorMessage: null,
            retryCount: (sourceFile.retryCount ?? 0) + 1
          });
        }

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
      async listBundleTreeEntries({ parentPath, entryType, limit, cursor }) {
        const entries = treeEntries.filter(
          (entry) =>
            entry.parentPath === parentPath &&
            (!entryType || entry.entryType === entryType) &&
            isTreeEntryVisible(entry)
        );
        return paginateTreeEntries(entries, limit, cursor);
      },
      async searchBundleTreeEntries({ query, entryType, limit, cursor }) {
        const normalizedQuery = query.toLowerCase();
        const entries = treeEntries.filter(
          (entry) =>
            (!entryType || entry.entryType === entryType) &&
            isTreeEntryVisible(entry) &&
            `${entry.name} ${entry.logicalPath}`.toLowerCase().includes(normalizedQuery)
        );
        const page = paginateTreeEntries(entries, limit, cursor);

        return {
          items: page.items.map((entry) => ({
            entry,
            ancestors: entry.logicalPath === "pages/guide.md" ? [pagesTreeEntry] : []
          })),
          nextCursor: page.nextCursor
        };
      },
      async getBundleFile({ knowledgeBaseId, releaseId, logicalPath }) {
        return (
          Array.from(bundleFiles.values()).find(
            (file) =>
              file.knowledgeBaseId === knowledgeBaseId &&
              file.releaseId === releaseId &&
              file.logicalPath === logicalPath &&
              isBundleFileVisible(file)
          ) ?? null
        );
      },
      async getBundleFileById({ knowledgeBaseId, releaseId, fileId }) {
        const file = bundleFiles.get(fileId) ?? null;
        return file &&
          file.knowledgeBaseId === knowledgeBaseId &&
          file.releaseId === releaseId &&
          isBundleFileVisible(file)
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
      async createSourceFileEvent(input: SourceFileEventDraft) {
        const event: SourceFileEventRecord = {
          id: `source-file-event-${sourceFileEvents.length + 1}`,
          ...input,
          createdAt: now
        };
        sourceFileEvents.push(event);
        return event;
      },
      async listSourceFileEvents({ knowledgeBaseId, sourceFileId, limit }) {
        return {
          items: sourceFileEvents
            .filter(
              (event) =>
                event.knowledgeBaseId === knowledgeBaseId && event.sourceFileId === sourceFileId
            )
            .slice(0, limit),
          nextCursor: null
        };
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
        return { items: Array.from(bundleFiles.values()).filter(isBundleFileVisible), nextCursor: null };
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
      async searchBundleGraphFiles({ query, fileKind, graphDepth, graphFanout, limit }) {
        if (fileKind && fileKind !== "page") {
          return { items: [], nextCursor: null };
        }

        const normalizedQuery = query.toLowerCase();
        const file = bundleFiles.get("bundle-guide");

        if (!file || !isBundleFileVisible(file) || !file.sourceFileId) {
          return { items: [], nextCursor: null };
        }

        const source = sourceFiles.get(file.sourceFileId);

        if (!source || source.deletedAt) {
          return { items: [], nextCursor: null };
        }

        const graphText = [
          file.logicalPath,
          file.title,
          file.description,
          "reference",
          "both files share a topic"
        ].join(" ").toLowerCase();

        if (!graphText.includes(normalizedQuery)) {
          return { items: [], nextCursor: null };
        }

        return {
          items: [
            {
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
              matchedFields: ["title"] as Array<"path" | "title" | "description" | "metadata">,
              score: 11,
              contentAvailable: true,
              matchType: "graph_edge" as const,
              graphContext: {
                graphRef: "_graph/by-file/source-guide.json",
                depth: graphDepth,
                seedSourceFileId: "source-guide",
                matchedNodeFields: ["title"],
                matchedRelationshipFields: ["relationship"],
                relationships: [
                  {
                    fileId: "source-reference",
                    sourceFileId: "source-reference",
                    bundleFileId: "bundle-reference",
                    path: "pages/reference.md",
                    title: "Reference",
                    relationType: "shared_tag",
                    direction: "outgoing" as const,
                    weight: 0.8,
                    reason: "Both files share a topic.",
                    source: "deterministic",
                    contentAvailable: true
                  }
                ].slice(0, graphFanout),
                graphPaths: ["_graph/by-file/source-guide.json", "_graph/by-file/source-reference.json"]
              }
            }
          ].slice(0, limit),
          nextCursor: null
        };
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
      async listActiveGraphNodes() {
        return { items: [], nextCursor: null };
      },
      async listGraphEdges() {
        return { items: [], nextCursor: null };
      },
      async listActiveGraphEdges() {
        return { items: [], nextCursor: null };
      },
      async getGraphEdge({ edgeId }) {
        return edgeId === "edge-guide-reference" && isSourceVisible("source-guide")
          ? {
              fromFileId: "source-guide",
              toFileId: "source-reference",
              relationType: "shared_tag",
              weight: 0.8,
              reason: "Both files share a topic.",
              source: "deterministic"
            }
          : null;
      },
      async getActiveGraphEdge({ edgeId }) {
        return edgeId === "edge-guide-reference" && isSourceVisible("source-guide")
          ? {
              id: "edge-guide-reference",
              fromFileId: "source-guide",
              toFileId: "source-reference",
              relationType: "shared_tag",
              weight: 0.8,
              reason: "Both files share a topic.",
              source: "deterministic"
            }
          : null;
      },
      async listGraphNeighborhood({ sourceFileId }) {
        return {
          items:
            sourceFileId === "source-guide" && isSourceVisible(sourceFileId)
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
      async listActiveGraphNeighborhood({ sourceFileId }) {
        return {
          items:
            sourceFileId === "source-guide" && isSourceVisible(sourceFileId)
              ? [
                  {
                    fileId: "source-reference",
                    sourceFileId: "source-reference",
                    bundleFileId: "bundle-reference",
                    path: "pages/reference.md",
                    title: "Reference",
                    relationType: "shared_tag",
                    direction: "outgoing" as const,
                    weight: 0.8,
                    reason: "Both files share a topic.",
                    source: "deterministic" as const,
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
    !file.relativePath.toLowerCase().includes(filters.fileNameQuery.toLowerCase())
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
    async enqueueUploadSessionFinalizationJob(input) {
      const record = createWorkerJob({
        kind: "upload_session_finalization",
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFileId: null,
        payload: { sessionId: input.sessionId },
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
    async enqueueResourceOperationJob(input) {
      const record = createWorkerJob({
        kind: "resource_operation",
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFileId: null,
        payload: { operationId: input.operationId },
        runAfter: input.runAfter,
        maxAttempts: input.maxAttempts
      });
      workerJobs.push(record);
      return record;
    },
    async enqueueHardDeleteJob(input) {
      const record = createWorkerJob({
        kind: "hard_delete",
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFileId: input.sourceFileId ?? null,
        payload: {
          targetKind: input.targetKind,
          sourceDirectoryId: input.sourceDirectoryId ?? null,
          deletionIntentId: input.deletionIntentId ?? null,
          reason: input.reason
        },
        runAfter: input.runAfter,
        maxAttempts: input.maxAttempts
      });
      workerJobs.push(record);
      return record;
    },
    async cancelQueuedSourceFileJobs() {
      return [];
    },
    async cancelQueuedSourceDirectoryJobs() {
      return [];
    },
    async cancelQueuedKnowledgeBaseJobs() {
      return [];
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

async function stageDeveloperUploadSession(input: {
  app: ReturnType<typeof createPublicOpenApiApp>;
  relativePath: string;
  content: string;
  idempotencyKey: string;
}) {
  const bytes = new TextEncoder().encode(input.content);
  const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
  const createResponse = await input.app.request(
    "/openapi/v2/knowledge-bases/kb-seeded/upload-sessions",
    {
      method: "POST",
      headers: {
        ...authHeaders(),
        "content-type": "application/json",
        "idempotency-key": input.idempotencyKey
      },
      body: JSON.stringify({ declaredFileCount: 1, declaredByteCount: bytes.byteLength })
    }
  );
  const createBody = (await createResponse.json()) as {
    session: { id: string; state: string };
    limits: Record<string, number>;
  };
  expect(createResponse.status).toBe(201);

  const entriesResponse = await input.app.request(
    `/openapi/v2/knowledge-bases/kb-seeded/upload-sessions/${createBody.session.id}/entries`,
    {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        entries: [
          {
            relativePath: input.relativePath,
            declaredSize: bytes.byteLength,
            checksumSha256
          }
        ]
      })
    }
  );
  expect(entriesResponse.status).toBe(200);

  const sealResponse = await input.app.request(
    `/openapi/v2/knowledge-bases/kb-seeded/upload-sessions/${createBody.session.id}/seal`,
    { method: "POST", headers: authHeaders() }
  );
  expect(sealResponse.status).toBe(200);

  const statusResponse = await input.app.request(
    `/openapi/v2/knowledge-bases/kb-seeded/upload-sessions/${createBody.session.id}?transferState=missing&limit=10`,
    { headers: authHeaders() }
  );
  const statusBody = (await statusResponse.json()) as {
    session: Record<string, unknown>;
    entries: { items: Array<{ id: string; relativePath: string; generatedPath: string }> };
  };
  expect(statusResponse.status).toBe(200);
  expect(statusBody.entries.items).toHaveLength(1);

  const form = new FormData();
  form.append(
    statusBody.entries.items[0]!.id,
    new File([bytes], input.relativePath.split("/").at(-1) ?? "source.md", {
      type: "text/markdown"
    })
  );
  const contentResponse = await input.app.request(
    `/openapi/v2/knowledge-bases/kb-seeded/upload-sessions/${createBody.session.id}/content`,
    { method: "POST", headers: authHeaders(), body: form }
  );
  expect(contentResponse.status).toBe(200);

  return {
    sessionId: createBody.session.id,
    createBody,
    entry: statusBody.entries.items[0]!
  };
}

describe("Developer OpenAPI", () => {
  it("returns only health status", async () => {
    const { app } = createApp();
    const response = await app.request("/openapi/v2/health", {
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
        app.request("/openapi/v2/version", {
          headers: authHeaders()
        }),
        app.request("/openapi/v2/openapi.json", {
          headers: authHeaders()
        }),
        app.request("/openapi/v2/health", {
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
          "/openapi/v2/version": {
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
          "/openapi/v2/openapi.json": {
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
        apiVersion: "v2"
      });
      expect(contract.info.version).toBe("9.8.7");
      expect(
        contract.paths["/openapi/v2/version"].get.responses["200"].content["application/json"].example
      ).toMatchObject({
        version: "9.8.7",
        apiVersion: "v2"
      });
      expect(
        contract.paths["/openapi/v2/openapi.json"].get.responses["200"].content["application/json"].example
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

  it("keeps the runtime and documented version-two operation inventories identical", async () => {
    const { app } = createApp();
    const response = await app.request("/openapi/v2/openapi.json", {
      headers: authHeaders()
    });
    const contract = (await response.json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const methods = new Set(["get", "post", "put", "patch", "delete"]);
    const documented = new Set(
      Object.entries(contract.paths).flatMap(([path, pathItem]) =>
        Object.keys(pathItem)
          .filter((method) => methods.has(method))
          .map((method) => `${method.toUpperCase()} ${path}`)
      )
    );
    const runtime = new Set(
      app.routes
        .filter(
          (route) =>
            route.path.startsWith("/openapi/v2/") &&
            !route.path.includes("*") &&
            methods.has(route.method.toLowerCase())
        )
        .map(
          (route) =>
            `${route.method.toUpperCase()} ${route.path.replace(/:([A-Za-z][A-Za-z0-9_]*)/gu, "{$1}")}`
        )
    );

    expect([...runtime].sort()).toEqual([...documented].sort());
  });

  it("requires a valid OpenAPI key", async () => {
    const { app } = createApp();
    const response = await app.request("/openapi/v2/knowledge-bases");

    expect(response.status).toBe(401);
  });

  it("returns knowledge base list and metadata reads with stable identifiers", async () => {
    const { app } = createApp();
    const [listResponse, detailResponse] = await Promise.all([
      app.request("/openapi/v2/knowledge-bases?limit=10", { headers: authHeaders() }),
      app.request("/openapi/v2/knowledge-bases/kb-seeded", { headers: authHeaders() })
    ]);
    const listBody = (await listResponse.json()) as {
      items: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };
    const detailBody = (await detailResponse.json()) as {
      knowledgeBase: Record<string, unknown>;
    };
    const expectedKnowledgeBase = {
      knowledgeBaseId: "kb-seeded",
      name: "Seeded KB",
      description: null,
      activeReleaseId: "release-seeded",
      resourceRevision: 1,
      catalogGeneration: 0,
      createdAt: now,
      updatedAt: now
    };

    expect(listResponse.status).toBe(200);
    expect(detailResponse.status).toBe(200);
    expect(listBody).toEqual({
      items: [expectedKnowledgeBase],
      nextCursor: null
    });
    expect(detailBody).toEqual({
      knowledgeBase: expectedKnowledgeBase
    });
  });

  it("serves bounded first-page reads when Redis is unavailable", async () => {
    const config = createConfig();
    const repositories = createRepositories();
    const app = createPublicOpenApiApp({
      config,
      storage: new MemoryStorage(),
      repositories
    });
    const headers = authHeaders();
    const [list, tree, search, graph] = await Promise.all([
      app.request("/openapi/v2/knowledge-bases?limit=10", { headers }),
      app.request("/openapi/v2/knowledge-bases/kb-seeded/tree?parentPath=pages&limit=10", {
        headers
      }),
      app.request("/openapi/v2/knowledge-bases/kb-seeded/files/search?query=guide&limit=10", {
        headers
      }),
      app.request("/openapi/v2/knowledge-bases/kb-seeded/graph/insights", { headers })
    ]);

    expect([list.status, tree.status, search.status, graph.status]).toEqual([200, 200, 200, 200]);
    await expect(list.json()).resolves.toMatchObject({ nextCursor: null });
    await expect(tree.json()).resolves.toMatchObject({ nextCursor: null });
    await expect(search.json()).resolves.toMatchObject({ searchStatus: "ok", nextCursor: null });
  });

  it("hides deleted knowledge bases from Developer OpenAPI read surfaces", async () => {
    const { app } = createApp();
    const headers = authHeaders();

    const [listBefore, detailBefore, treeBefore, searchBefore, contentBefore, sourceFilesBefore] =
      await Promise.all([
        app.request("/openapi/v2/knowledge-bases", { headers }),
        app.request("/openapi/v2/knowledge-bases/kb-seeded", { headers }),
        app.request("/openapi/v2/knowledge-bases/kb-seeded/tree?parentPath=pages&limit=10", {
          headers
        }),
        app.request("/openapi/v2/knowledge-bases/kb-seeded/files/search?query=guide&limit=10", {
          headers
        }),
        app.request("/openapi/v2/knowledge-bases/kb-seeded/files/content?path=pages%2Fguide.md", {
          headers
        }),
        app.request("/openapi/v2/knowledge-bases/kb-seeded/source-files?limit=10", { headers })
      ]);

    expect([
      listBefore.status,
      detailBefore.status,
      treeBefore.status,
      searchBefore.status,
      contentBefore.status,
      sourceFilesBefore.status
    ]).toEqual([200, 200, 200, 200, 200, 200]);

    const deleteResponse = await app.request("/openapi/v2/knowledge-bases/kb-seeded", {
      method: "DELETE",
      headers: {
        ...headers,
        "idempotency-key": "delete-kb-seeded",
        "if-match": '"1"'
      }
    });
    const deleteBody = (await deleteResponse.json()) as {
      deletion: {
        knowledgeBaseId: string;
        accepted: boolean;
        affectedDirectoryCount: number;
        affectedFileCount: number;
      };
    };
    const [
      listAfter,
      detailAfter,
      treeAfter,
      searchAfter,
      contentAfter,
      sourceFilesAfter,
      relatedAfter
    ] = await Promise.all([
      app.request("/openapi/v2/knowledge-bases", { headers }),
      app.request("/openapi/v2/knowledge-bases/kb-seeded", { headers }),
      app.request("/openapi/v2/knowledge-bases/kb-seeded/tree?parentPath=pages&limit=10", {
        headers
      }),
      app.request("/openapi/v2/knowledge-bases/kb-seeded/files/search?query=guide&limit=10", {
        headers
      }),
      app.request("/openapi/v2/knowledge-bases/kb-seeded/files/content?path=pages%2Fguide.md", {
        headers
      }),
      app.request("/openapi/v2/knowledge-bases/kb-seeded/source-files?limit=10", { headers }),
      app.request("/openapi/v2/knowledge-bases/kb-seeded/files/bundle-guide/related", { headers })
    ]);
    const listAfterBody = (await listAfter.json()) as {
      items: Array<{ knowledgeBaseId: string }>;
    };

    expect(deleteResponse.status).toBe(202);
    expect(deleteBody).toEqual({
      deletion: {
        knowledgeBaseId: "kb-seeded",
        accepted: true,
        affectedDirectoryCount: 1,
        affectedFileCount: 3
      }
    });
    expect(listAfter.status).toBe(200);
    expect(listAfterBody.items).not.toContainEqual(
      expect.objectContaining({ knowledgeBaseId: "kb-seeded" })
    );
    expect([
      detailAfter.status,
      treeAfter.status,
      searchAfter.status,
      contentAfter.status,
      sourceFilesAfter.status,
      relatedAfter.status
    ]).toEqual([404, 404, 404, 404, 404, 404]);
  });

  it("rejects invalid manifest paths before content transfer", async () => {
    const { app, repositories } = createApp();
    const createResponse = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/upload-sessions",
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
          "idempotency-key": "invalid-manifest-path"
        },
        body: JSON.stringify({ declaredFileCount: 1, declaredByteCount: 10 })
      }
    );
    const createBody = (await createResponse.json()) as { session: { id: string } };
    const manifestResponse = await app.request(
      `/openapi/v2/knowledge-bases/kb-seeded/upload-sessions/${createBody.session.id}/entries`,
      {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          entries: [
            {
              relativePath: "handbook/guide.txt",
              declaredSize: 10,
              checksumSha256: "0".repeat(64)
            }
          ]
        })
      }
    );

    expect(createResponse.status).toBe(201);
    expect(manifestResponse.status).toBe(422);
    expect(repositories.sourceFiles.size).toBe(3);
    expect(await repositories.workerJobs?.countActiveWorkerJobs({})).toBe(0);
  });

  it("rejects manifest entries that exceed the configured per-file byte limit", async () => {
    const { app } = createApp();
    const declaredSize = 1_048_577;
    const createResponse = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/upload-sessions",
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
          "idempotency-key": "oversized-manifest-entry"
        },
        body: JSON.stringify({ declaredFileCount: 1, declaredByteCount: declaredSize })
      }
    );
    const createBody = (await createResponse.json()) as { session: { id: string } };
    expect(createResponse.status).toBe(201);

    const response = await app.request(
      `/openapi/v2/knowledge-bases/kb-seeded/upload-sessions/${createBody.session.id}/entries`,
      {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          entries: [
            {
              relativePath: "oversized.md",
              declaredSize,
              checksumSha256: "0".repeat(64)
            }
          ]
        })
      }
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "PAYLOAD_TOO_LARGE" }
    });
  });

  it("rejects Unicode-equivalent paths within one manifest page", async () => {
    const { app } = createApp();
    const createResponse = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/upload-sessions",
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
          "idempotency-key": "unicode-manifest-collision"
        },
        body: JSON.stringify({ declaredFileCount: 2, declaredByteCount: 2 })
      }
    );
    const createBody = (await createResponse.json()) as { session: { id: string } };

    const response = await app.request(
      `/openapi/v2/knowledge-bases/kb-seeded/upload-sessions/${createBody.session.id}/entries`,
      {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          entries: [
            {
              relativePath: "Root/Cafe\u0301.md",
              declaredSize: 1,
              checksumSha256: "0".repeat(64)
            },
            {
              relativePath: "root/caf\u00e9.MD",
              declaredSize: 1,
              checksumSha256: "1".repeat(64)
            }
          ]
        })
      }
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        message: "UPLOAD_MANIFEST_DUPLICATE_PATH"
      }
    });
  });

  it("rejects manifest and content pages above their configured batch limits", async () => {
    const { app, storage } = createApp();
    const createResponse = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/upload-sessions",
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
          "idempotency-key": "oversized-upload-batches"
        },
        body: JSON.stringify({ declaredFileCount: 501, declaredByteCount: 501 })
      }
    );
    const createBody = (await createResponse.json()) as { session: { id: string } };
    const manifestResponse = await app.request(
      `/openapi/v2/knowledge-bases/kb-seeded/upload-sessions/${createBody.session.id}/entries`,
      {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          entries: Array.from({ length: 501 }, (_, index) => ({
            relativePath: `bulk/file-${index}.md`,
            declaredSize: 1,
            checksumSha256: "0".repeat(64)
          }))
        })
      }
    );
    const content = new FormData();
    for (let index = 0; index < 25; index += 1) {
      content.append(`upload-entry-${index}`, new File(["x"], `file-${index}.md`));
    }
    const contentResponse = await app.request(
      `/openapi/v2/knowledge-bases/kb-seeded/upload-sessions/${createBody.session.id}/content`,
      {
        method: "POST",
        headers: authHeaders(),
        body: content
      }
    );

    expect(manifestResponse.status).toBe(422);
    expect(contentResponse.status).toBe(422);
    expect([...storage.objects.keys()].some((key) => key.includes(createBody.session.id))).toBe(false);
  });

  it("rejects upload bodies that do not match the sealed manifest", async () => {
    const { app } = createApp();
    const expected = new TextEncoder().encode("expected");
    const createResponse = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/upload-sessions",
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
          "idempotency-key": "body-mismatch"
        },
        body: JSON.stringify({ declaredFileCount: 1, declaredByteCount: expected.byteLength })
      }
    );
    const createBody = (await createResponse.json()) as { session: { id: string } };
    const entriesResponse = await app.request(
      `/openapi/v2/knowledge-bases/kb-seeded/upload-sessions/${createBody.session.id}/entries`,
      {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          entries: [
            {
              relativePath: "mismatch.md",
              declaredSize: expected.byteLength,
              checksumSha256: createHash("sha256").update(expected).digest("hex")
            }
          ]
        })
      }
    );
    expect(entriesResponse.status).toBe(200);
    const sealResponse = await app.request(
      `/openapi/v2/knowledge-bases/kb-seeded/upload-sessions/${createBody.session.id}/seal`,
      { method: "POST", headers: authHeaders() }
    );
    expect(sealResponse.status).toBe(200);
    const statusResponse = await app.request(
      `/openapi/v2/knowledge-bases/kb-seeded/upload-sessions/${createBody.session.id}?transferState=missing`,
      { headers: authHeaders() }
    );
    const statusBody = (await statusResponse.json()) as {
      entries: { items: Array<{ id: string }> };
    };
    const form = new FormData();
    form.append(statusBody.entries.items[0]!.id, new File(["different"], "mismatch.md"));
    const response = await app.request(
      `/openapi/v2/knowledge-bases/kb-seeded/upload-sessions/${createBody.session.id}/content`,
      { method: "POST", headers: authHeaders(), body: form }
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR" }
    });
  });

  it("returns not found for a stale upload session identifier", async () => {
    const { app } = createApp();
    const response = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/upload-sessions/upload-session-stale",
      { headers: authHeaders() }
    );

    expect(response.status).toBe(404);
  });

  it("replays identical upload-session requests and rejects changed payloads", async () => {
    const { app } = createApp();
    const request = (declaredFileCount: number) => app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/upload-sessions",
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
          "idempotency-key": "replayed-upload-session"
        },
        body: JSON.stringify({ declaredFileCount, declaredByteCount: 10 })
      }
    );
    const first = await request(1);
    const replay = await request(1);
    const conflictResponse = await request(2);
    const firstBody = (await first.json()) as { session: { id: string } };
    const replayBody = (await replay.json()) as { session: { id: string } };

    expect([first.status, replay.status, conflictResponse.status]).toEqual([201, 201, 409]);
    expect(replayBody.session.id).toBe(firstBody.session.id);
  });

  it("requires authentication before accepting source and directory deletion", async () => {
    const { app } = createApp();
    const [sourceResponse, directoryResponse] = await Promise.all([
      app.request("/openapi/v2/knowledge-bases/kb-seeded/source-files/source-guide", {
        method: "DELETE",
        headers: { "idempotency-key": "unauthorized-source", "if-match": '"1"' }
      }),
      app.request(
        "/openapi/v2/knowledge-bases/kb-seeded/source-directories/source-directory-pages",
        {
          method: "DELETE",
          headers: { "idempotency-key": "unauthorized-directory", "if-match": '"1"' }
        }
      )
    ]);

    expect([sourceResponse.status, directoryResponse.status]).toEqual([401, 401]);
  });

  it("runs the resumable nested upload-session lifecycle with connected identifiers", async () => {
    const { app, repositories } = createApp();
    const staged = await stageDeveloperUploadSession({
      app,
      relativePath: "handbook/onboarding/guide.md",
      content: "# Onboarding guide\n\nComplete setup steps.",
      idempotencyKey: "nested-upload-session"
    });

    expect(staged.createBody.session).toEqual(
      expect.objectContaining({ id: staged.sessionId, state: "draft" })
    );
    expect(staged.createBody.session).not.toHaveProperty("idempotencyKey");
    expect(staged.createBody.session).not.toHaveProperty("manifestFingerprint");
    expect(staged.entry).toMatchObject({
      relativePath: "handbook/onboarding/guide.md",
      generatedPath: "pages/handbook/onboarding/guide.md"
    });

    const uploadedStatusResponse = await app.request(
      `/openapi/v2/knowledge-bases/kb-seeded/upload-sessions/${staged.sessionId}?transferState=uploaded&limit=10`,
      { headers: authHeaders() }
    );
    const uploadedStatus = (await uploadedStatusResponse.json()) as {
      session: Record<string, unknown>;
      entries: { items: Array<{ sourceFileId: string }> };
    };
    expect(uploadedStatusResponse.status).toBe(200);
    expect(uploadedStatus.entries.items).toHaveLength(1);
    expect(uploadedStatus.session).not.toHaveProperty("idempotencyKey");
    expect(uploadedStatus.session).not.toHaveProperty("manifestFingerprint");

    const reconcileResponse = await app.request(
      `/openapi/v2/knowledge-bases/kb-seeded/upload-sessions/${staged.sessionId}/reconcile`,
      { method: "POST", headers: authHeaders() }
    );
    const finalizeResponse = await app.request(
      `/openapi/v2/knowledge-bases/kb-seeded/upload-sessions/${staged.sessionId}/finalize`,
      { method: "POST", headers: authHeaders() }
    );
    const finalizeBody = (await finalizeResponse.json()) as {
      session: { state: string; counts: { finalized: number } };
    };
    const sourceFilesResponse = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/source-files?limit=10",
      { headers: authHeaders() }
    );
    const sourceFilesBody = (await sourceFilesResponse.json()) as {
      items: Array<{ sourceFileId: string }>;
    };

    expect(reconcileResponse.status).toBe(200);
    expect(finalizeResponse.status).toBe(202);
    expect(finalizeBody.session).toMatchObject({
      state: "finalizing",
      counts: { finalized: 0 }
    });
    expect(sourceFilesResponse.status).toBe(200);
    expect(sourceFilesBody.items).not.toContainEqual(
      expect.objectContaining({ sourceFileId: uploadedStatus.entries.items[0]!.sourceFileId })
    );
    expect(
      await repositories.workerJobs?.countActiveWorkerJobs({
        kinds: ["upload_session_finalization"],
        knowledgeBaseId: "kb-seeded"
      })
    ).toBe(1);
  });

  it("accepts finalization without loading source queue work into the API request", async () => {
    const { app, repositories } = createApp();
    const staged = await stageDeveloperUploadSession({
      app,
      relativePath: "handbook/queued.md",
      content: "# Queued",
      idempotencyKey: "backpressure-upload-session"
    });
    if (!repositories.workerJobs) throw new Error("Missing Worker test repository");
    const countActiveWorkerJobs = repositories.workerJobs.countActiveWorkerJobs.bind(
      repositories.workerJobs
    );
    repositories.workerJobs.countActiveWorkerJobs = async (input) =>
      input.kinds?.includes("source_file_processing")
        ? 10_000
        : countActiveWorkerJobs(input);

    const response = await app.request(
      `/openapi/v2/knowledge-bases/kb-seeded/upload-sessions/${staged.sessionId}/finalize`,
      { method: "POST", headers: authHeaders() }
    );
    expect(response.status).toBe(202);
    expect(
      await repositories.workerJobs.countActiveWorkerJobs({
        kinds: ["upload_session_finalization"],
        knowledgeBaseId: "kb-seeded"
      })
    ).toBe(1);
  });

  it("cancels an unfinished upload session without exposing internal fields", async () => {
    const { app } = createApp();
    const staged = await stageDeveloperUploadSession({
      app,
      relativePath: "handbook/cancelled.md",
      content: "# Cancelled",
      idempotencyKey: "cancel-upload-session"
    });
    const response = await app.request(
      `/openapi/v2/knowledge-bases/kb-seeded/upload-sessions/${staged.sessionId}`,
      { method: "DELETE", headers: authHeaders() }
    );
    const body = (await response.json()) as { session: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.session).toMatchObject({ id: staged.sessionId, state: "cancelled" });
    expect(body.session).not.toHaveProperty("idempotencyKey");
    expect(body.session).not.toHaveProperty("manifestFingerprint");
  });
  it("searches the generated file tree and returns ancestor chains", async () => {
    const { app } = createApp();
    const response = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/tree?query=guide&limit=10",
      {
        headers: authHeaders()
      }
    );
    const body = (await response.json()) as {
      items: Array<{
        path: string;
        entryType: string;
        readActions?: {
          fileContentByPath: string;
          graphExpansionByFileId: string | null;
        } | null;
        ancestors?: Array<{ path: string; entryType: string }>;
      }>;
      nextCursor: string | null;
    };

    expect(response.status).toBe(200);
    expect(body.nextCursor).toBeNull();
    expect(body.items).toContainEqual(
      expect.objectContaining({
        path: "pages/guide.md",
        entryType: "file",
        readActions: expect.objectContaining({
          fileContentByPath: "/openapi/v2/knowledge-bases/kb-seeded/files/content?path=pages%2Fguide.md",
          graphExpansionByFileId: "/openapi/v2/knowledge-bases/kb-seeded/graph/expand?fileId=bundle-guide"
        }),
        ancestors: [
          expect.objectContaining({
            path: "pages",
            entryType: "directory"
          })
        ]
      })
    );
  });

  it("filters generated file tree search by entry type", async () => {
    const { app } = createApp();
    const [directoryResponse, fileResponse] = await Promise.all([
      app.request("/openapi/v2/knowledge-bases/kb-seeded/tree?query=pages&entryType=directory&limit=10", {
        headers: authHeaders()
      }),
      app.request("/openapi/v2/knowledge-bases/kb-seeded/tree?query=pages&entryType=file&limit=10", {
        headers: authHeaders()
      })
    ]);
    const directoryBody = (await directoryResponse.json()) as {
      items: Array<{ path: string; entryType: string; readActions: unknown }>;
    };
    const fileBody = (await fileResponse.json()) as {
      items: Array<{ path: string; entryType: string; readActions: { fileContentByPath: string } | null }>;
    };

    expect(directoryResponse.status).toBe(200);
    expect(fileResponse.status).toBe(200);
    expect(directoryBody.items).toEqual([
      expect.objectContaining({
        path: "pages",
        entryType: "directory",
        readActions: null
      })
    ]);
    expect(fileBody.items).toEqual([
      expect.objectContaining({
        path: "pages/guide.md",
        entryType: "file",
        readActions: expect.objectContaining({
          fileContentByPath: "/openapi/v2/knowledge-bases/kb-seeded/files/content?path=pages%2Fguide.md"
        })
      })
    ]);
  });

  it("paginates generated file tree search without exposing deleted source files", async () => {
    const { app } = createApp();
    const firstResponse = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/tree?query=pages&limit=1",
      {
        headers: authHeaders()
      }
    );
    const firstBody = (await firstResponse.json()) as {
      items: Array<{ path: string }>;
      nextCursor: string | null;
    };

    expect(firstResponse.status).toBe(200);
    expect(firstBody.items).toEqual([expect.objectContaining({ path: "pages" })]);
    expect(firstBody.nextCursor).toEqual(expect.any(String));

    const secondResponse = await app.request(
      `/openapi/v2/knowledge-bases/kb-seeded/tree?query=pages&limit=1&cursor=${encodeURIComponent(
        firstBody.nextCursor ?? ""
      )}`,
      {
        headers: authHeaders()
      }
    );
    const secondBody = (await secondResponse.json()) as {
      items: Array<{ path: string; ancestors?: Array<{ path: string }> }>;
      nextCursor: string | null;
    };
    const deletedResponse = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/tree?query=deleted&limit=10",
      {
        headers: authHeaders()
      }
    );
    const deletedBody = (await deletedResponse.json()) as {
      items: Array<{ path: string }>;
    };

    expect(secondResponse.status).toBe(200);
    expect(secondBody.items).toEqual([
      expect.objectContaining({
        path: "pages/guide.md",
        ancestors: [expect.objectContaining({ path: "pages" })]
      })
    ]);
    expect(secondBody.nextCursor).toBeNull();
    expect(deletedResponse.status).toBe(200);
    expect(deletedBody.items).toEqual([]);
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
        app.request("/openapi/v2/knowledge-bases/kb-seeded/source-files", {
          headers: authHeaders()
        }),
        app.request("/openapi/v2/knowledge-bases/kb-seeded/tree?parentPath=pages", {
          headers: authHeaders()
        }),
        app.request("/openapi/v2/knowledge-bases/kb-seeded/files/content?path=pages%2Fguide.md", {
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
      sourceFileId: "source-guide",
      directoryId: "source-directory-pages",
      relativePath: "pages/guide.md",
      generatedPath: "pages/guide.md",
      resourceRevision: 1,
      contentRevision: 1
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
      "/openapi/v2/knowledge-bases/kb-seeded/files/search?query=guide"
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
      "/openapi/v2/knowledge-bases/kb-seeded/files/search?query=x",
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
      "/openapi/v2/knowledge-bases/kb-seeded/files/search?query=guide",
      {
        headers: authHeaders()
      }
    );
    const second = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/files/search?query=guide",
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

  it("keeps read, upload-session, and directory-deletion rate-limit scopes independent", async () => {
    const baseConfig = createConfig();
    const security = resolveSecurityConfig(baseConfig);
    const app = createPublicOpenApiApp({
      config: {
        ...baseConfig,
        security: {
          ...security,
          rateLimits: {
            ...security.rateLimits,
            publicOpenApi: { max: 1, windowSeconds: 60 }
          }
        }
      },
      storage: new MemoryStorage(),
      redis: createTestRedisCoordinator(),
      repositories: createRepositories()
    });

    const createUpload = (key: string) => app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/upload-sessions",
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
          "idempotency-key": key
        },
        body: JSON.stringify({ declaredFileCount: 0, declaredByteCount: 0 })
      }
    );
    const firstUpload = await createUpload("scope-upload-1");
    const secondUpload = await createUpload("scope-upload-2");
    const read = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/files/search?query=guide",
      { headers: authHeaders() }
    );
    const directoryDelete = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/source-directories/source-directory-pages",
      {
        method: "DELETE",
        headers: {
          ...authHeaders(),
          "idempotency-key": "scope-directory-delete",
          "if-match": "1"
        }
      }
    );

    expect(firstUpload.status).toBe(201);
    expect(secondUpload.status).toBe(429);
    expect(read.status).toBe(200);
    expect(directoryDelete.status).toBe(202);
  });

  it("records safe upload-session and directory-deletion audit events", async () => {
    const repositories = createRepositories();
    const events: Array<{ eventType: string; result: string; errorCode: string | null }> = [];
    repositories.securityAudit = {
      async createSecurityAuditEvent(event) {
        events.push({
          eventType: event.eventType,
          result: event.result,
          errorCode: event.errorCode
        });
      }
    };
    const app = createPublicOpenApiApp({
      config: createConfig(),
      storage: new MemoryStorage(),
      redis: createTestRedisCoordinator(),
      repositories
    });

    const createResponse = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/upload-sessions",
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
          "idempotency-key": "audit-upload"
        },
        body: JSON.stringify({ declaredFileCount: 1, declaredByteCount: 10 })
      }
    );
    const sessionId = ((await createResponse.json()) as { session: { id: string } }).session.id;
    const invalidManifest = await app.request(
      `/openapi/v2/knowledge-bases/kb-seeded/upload-sessions/${sessionId}/entries`,
      {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          entries: [{ relativePath: "unsafe.txt", declaredSize: 10, checksumSha256: "0".repeat(64) }]
        })
      }
    );
    const directoryDelete = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/source-directories/source-directory-pages",
      {
        method: "DELETE",
        headers: {
          ...authHeaders(),
          "idempotency-key": "audit-directory-delete",
          "if-match": "1"
        }
      }
    );

    expect(createResponse.status).toBe(201);
    expect(invalidManifest.status).toBe(422);
    expect(directoryDelete.status).toBe(202);
    expect(events).toEqual(expect.arrayContaining([
      { eventType: "upload_session_created", result: "success", errorCode: null },
      { eventType: "upload_session_invalid_path", result: "failure", errorCode: "INVALID_RELATIVE_PATH" },
      { eventType: "source_directory_delete_accepted", result: "success", errorCode: null }
    ]));
  });

  it("returns index-unavailable search status without scanning release files when file search index is missing", async () => {
    const { app, repositories } = createApp();
    let searchCount = 0;

    if (!repositories.files?.getReleaseReadSummary || !repositories.files.searchBundleFiles) {
      throw new Error("Search repository is missing from the test fixture.");
    }

    repositories.files.getReleaseReadSummary = async () => null;
    repositories.files.searchBundleFiles = async () => {
      searchCount += 1;
      return { items: [], nextCursor: null };
    };

    const response = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/files/search?query=guide&mode=file",
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

  it("keeps Developer OpenAPI read routes available when search documents are unavailable", async () => {
    const { app, repositories } = createApp();

    if (!repositories.files?.getReleaseReadSummary) {
      throw new Error("Search repository is missing from the test fixture.");
    }

    repositories.files.getReleaseReadSummary = async () => null;
    const [treeResponse, contentResponse, detailResponse] = await Promise.all([
      app.request("/openapi/v2/knowledge-bases/kb-seeded/tree?parentPath=pages", {
        headers: authHeaders()
      }),
      app.request("/openapi/v2/knowledge-bases/kb-seeded/files/content?path=pages%2Fguide.md", {
        headers: authHeaders()
      }),
      app.request("/openapi/v2/knowledge-bases/kb-seeded/files/bundle-guide", {
        headers: authHeaders()
      })
    ]);

    expect([treeResponse.status, contentResponse.status, detailResponse.status]).toEqual([
      200,
      200,
      200
    ]);
  });

  it("keeps Developer OpenAPI read routes hidden for task-deleted files while hard-delete work is queued", async () => {
    const { app, repositories } = createApp();

    await repositories.workerJobs?.enqueueWorkerJob({
      kind: "hard_delete",
      knowledgeBaseId: "kb-seeded",
      sourceFileId: null,
      payload: {
        targetKind: "source_file",
        sourceFileId: "source-deleted"
      },
      runAfter: now,
      maxAttempts: 3
    });

    const [treeResponse, contentResponse, detailResponse, searchResponse, sourceFilesResponse] =
      await Promise.all([
        app.request("/openapi/v2/knowledge-bases/kb-seeded/tree?parentPath=pages", {
          headers: authHeaders()
        }),
        app.request("/openapi/v2/knowledge-bases/kb-seeded/files/content?path=pages%2Fguide.md", {
          headers: authHeaders()
        }),
        app.request("/openapi/v2/knowledge-bases/kb-seeded/files/bundle-guide", {
          headers: authHeaders()
        }),
        app.request("/openapi/v2/knowledge-bases/kb-seeded/files/search?query=guide&limit=10", {
          headers: authHeaders()
        }),
        app.request("/openapi/v2/knowledge-bases/kb-seeded/source-files?limit=10", {
          headers: authHeaders()
        })
      ]);

    expect([
      treeResponse.status,
      contentResponse.status,
      detailResponse.status,
      searchResponse.status,
      sourceFilesResponse.status
    ]).toEqual([200, 200, 200, 200, 200]);
  });

  it("returns no-candidate search status from an available generated file index", async () => {
    const { app } = createApp();
    const response = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/files/search?query=missing",
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
      "/openapi/v2/knowledge-bases/kb-seeded/files/search?query=hidden&scope=all&fileKind=page&limit=10",
      {
        headers: authHeaders()
      }
    );

    repositories.sourceFiles.set("source-guide", {
      ...guideSource,
      deletedAt: now
    });

    const guideResponse = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/files/search?query=guide&scope=all&fileKind=page&limit=10",
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

  it("keeps generated files read-only and connects source deletion to an operation", async () => {
    const { app } = createApp();
    const [generatedById, generatedByPath] = await Promise.all([
      app.request("/openapi/v2/knowledge-bases/kb-seeded/files/bundle-guide", {
        method: "DELETE",
        headers: authHeaders()
      }),
      app.request("/openapi/v2/knowledge-bases/kb-seeded/files?path=pages%2Fguide.md", {
        method: "DELETE",
        headers: authHeaders()
      })
    ]);

    expect(generatedById.status).toBe(404);
    expect(generatedByPath.status).toBe(404);

    const deletionResponse = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/source-files/source-guide",
      {
        method: "DELETE",
        headers: {
          ...authHeaders(),
          "idempotency-key": "delete-source-guide",
          "if-match": '"1"'
        }
      }
    );
    const deletionBody = (await deletionResponse.json()) as {
      operation: { operationId: string; kind: string; state: string; result?: Record<string, unknown> };
      deletion: { sourceFileId: string };
    };
    expect(deletionResponse.status).toBe(202);
    expect(deletionBody.operation).toMatchObject({
      kind: "source_file_delete",
      state: "accepted"
    });
    expect(deletionBody.deletion.sourceFileId).toBe("source-guide");
    expect(deletionBody.deletion).not.toHaveProperty("deletionIntentId");
    expect(deletionBody.operation.result ?? {}).not.toHaveProperty("deletionIntentId");

    const operationResponse = await app.request(
      `/openapi/v2/knowledge-bases/kb-seeded/operations/${deletionBody.operation.operationId}`,
      { headers: authHeaders() }
    );
    const operationBody = (await operationResponse.json()) as {
      operation: { operationId: string };
    };
    expect(operationResponse.status).toBe(200);
    expect(operationBody.operation.operationId).toBe(deletionBody.operation.operationId);
  });
  it("returns generated file search candidates with concrete read actions", async () => {
    const { app } = createApp();
    const searchResponse = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/files/search?query=guide&scope=all&fileKind=page&limit=10",
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
        readActions: {
          fileDetailById: string;
          fileContentById: string;
          fileContentByPath: string;
          relatedFilesById: string;
          graphExpansionByFileId: string;
          sourceFileStatusById: string | null;
          sourceFileEventsById: string | null;
        };
      }>;
      searchStatus: string;
      query: { query: string; normalizedQuery: string; fileKind: string; limit: number };
      resultSummary: { resultCount: number; hasMore: boolean; sort: string[]; meaning: string };
      nextRequestTemplates: {
        fileDetailById: string;
        fileContentById: string;
        fileContentByPath: string;
        relatedFilesById: string;
        graphExpansionByFileId: string;
        sourceFileStatusById: string;
      };
    };
    const candidate = searchBody.items[0];

    if (!candidate) {
      throw new Error("Generated file search did not return a candidate.");
    }

    const [detailResponse, contentByIdResponse, relatedResponse, contentByPathResponse] =
      await Promise.all([
        app.request(`/openapi/v2/knowledge-bases/kb-seeded/files/${candidate.generatedFileId}`, {
          headers: authHeaders()
        }),
        app.request(`/openapi/v2/knowledge-bases/kb-seeded/files/${candidate.generatedFileId}/content`, {
          headers: authHeaders()
        }),
        app.request(`/openapi/v2/knowledge-bases/kb-seeded/files/${candidate.generatedFileId}/related`, {
          headers: authHeaders()
        }),
        app.request(
          `/openapi/v2/knowledge-bases/kb-seeded/files/content?path=${encodeURIComponent(candidate.generatedFilePath)}`,
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
      fileDetailById: "/openapi/v2/knowledge-bases/kb-seeded/files/{generatedFileId}",
      fileContentById: "/openapi/v2/knowledge-bases/kb-seeded/files/{generatedFileId}/content",
      fileContentByPath: "/openapi/v2/knowledge-bases/kb-seeded/files/content?path={generatedFilePath}",
      relatedFilesById: "/openapi/v2/knowledge-bases/kb-seeded/files/{generatedFileId}/related",
      graphExpansionByFileId: "/openapi/v2/knowledge-bases/kb-seeded/graph/expand?fileId={generatedFileId}",
      sourceFileStatusById: "/openapi/v2/knowledge-bases/kb-seeded/source-files/{sourceFileId}"
    });
    expect(candidate).toMatchObject({
      fileId: "bundle-guide",
      generatedFileId: "bundle-guide",
      sourceFileId: "source-guide",
      path: "pages/guide.md",
      generatedFilePath: "pages/guide.md",
      contentAvailable: true
    });
    expect(candidate.readActions).toMatchObject({
      fileDetailById: "/openapi/v2/knowledge-bases/kb-seeded/files/bundle-guide",
      fileContentById: "/openapi/v2/knowledge-bases/kb-seeded/files/bundle-guide/content",
      fileContentByPath: "/openapi/v2/knowledge-bases/kb-seeded/files/content?path=pages%2Fguide.md",
      relatedFilesById: "/openapi/v2/knowledge-bases/kb-seeded/files/bundle-guide/related",
      graphExpansionByFileId: "/openapi/v2/knowledge-bases/kb-seeded/graph/expand?fileId=bundle-guide",
      sourceFileStatusById: "/openapi/v2/knowledge-bases/kb-seeded/source-files/source-guide",
      sourceFileEventsById: "/openapi/v2/knowledge-bases/kb-seeded/source-files/source-guide/events"
    });
    expect(candidate.matchedFields).toEqual(expect.arrayContaining(["path", "title"]));
    expect([detailResponse.status, contentByIdResponse.status, relatedResponse.status, contentByPathResponse.status]).toEqual([
      200,
      200,
      200,
      200
    ]);
  });

  it("returns graph search candidates with bounded graph context", async () => {
    const { app } = createApp();
    const response = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/files/search?query=reference&mode=graph&graphDepth=2&graphFanout=1&limit=10",
      {
        headers: authHeaders()
      }
    );
    const body = (await response.json()) as {
      searchStatus: string;
      searchMode: string;
      graphStatus: string;
      graphSummary: {
        available: boolean;
        indexedDocumentCount: number;
        indexedRelationshipCount: number;
        depth: number;
        fanout: number;
      };
      items: Array<{
        fileId: string;
        sourceFileId: string | null;
        generatedFilePath: string;
        readActions: {
          fileContentByPath: string;
          relatedFilesById: string;
          graphExpansionByFileId: string;
        };
        matchType?: string;
        graphContext?: {
          graphRef: string;
          depth: number;
          relationships: Array<{
            path: string;
            readActions: {
              fileContentByPath: string;
              graphExpansionByFileId: string;
            };
          }>;
          graphPaths: string[];
        };
      }>;
    };

    expect(response.status).toBe(200);
    expect(body.searchStatus).toBe("ok");
    expect(body.searchMode).toBe("graph");
    expect(body.graphStatus).toBe("available");
    expect(body.graphSummary).toMatchObject({
      available: true,
      indexedDocumentCount: 1,
      indexedRelationshipCount: 1,
      depth: 2,
      fanout: 1
    });
    expect(body.items[0]).toMatchObject({
      fileId: "bundle-guide",
      sourceFileId: "source-guide",
      generatedFilePath: "pages/guide.md",
      readActions: {
        fileContentByPath: "/openapi/v2/knowledge-bases/kb-seeded/files/content?path=pages%2Fguide.md",
        relatedFilesById: "/openapi/v2/knowledge-bases/kb-seeded/files/bundle-guide/related",
        graphExpansionByFileId: "/openapi/v2/knowledge-bases/kb-seeded/graph/expand?fileId=bundle-guide"
      },
      matchType: "graph_edge",
      graphContext: {
        graphRef: "_graph/by-file/source-guide.json",
        depth: 2,
        relationships: [{ path: "pages/reference.md" }]
      }
    });
    expect(body.items[0]?.graphContext?.relationships).toHaveLength(1);
    expect(body.items[0]?.graphContext?.relationships[0]?.readActions.fileContentByPath).toBe(
      "/openapi/v2/knowledge-bases/kb-seeded/files/content?path=pages%2Freference.md"
    );
    expect(body.items[0]?.graphContext?.relationships[0]?.readActions.graphExpansionByFileId).toBe(
      "/openapi/v2/knowledge-bases/kb-seeded/graph/expand?fileId=bundle-reference"
    );
    expect(body.items[0]?.graphContext?.graphPaths).toContain("_graph/by-file/source-reference.json");
  });

  it("expands graph relationships from a generated file seed", async () => {
    const { app } = createApp();
    const response = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/graph/expand?fileId=bundle-guide&depth=1&fanout=1&limit=10",
      {
        headers: authHeaders()
      }
    );
    const body = (await response.json()) as {
      query: {
        fileId: string | null;
        query: string | null;
        depth: number;
        fanout: number;
      };
      seedFile: {
        fileId: string;
        path: string;
      } | null;
      relationships: Array<{
        path: string;
        readActions: {
          fileContentByPath: string;
          relatedFilesById: string;
          graphExpansionByFileId: string;
        };
      }>;
      graphPaths: string[];
      resultSummary: {
        seedCount: number;
        relationshipCount: number;
      };
    };

    expect(response.status).toBe(200);
    expect(body.query).toMatchObject({
      fileId: "bundle-guide",
      query: null,
      depth: 1,
      fanout: 1
    });
    expect(body.seedFile).toMatchObject({
      fileId: "bundle-guide",
      path: "pages/guide.md"
    });
    expect(body.relationships).toHaveLength(1);
    expect(body.relationships[0]).toMatchObject({
      path: "pages/reference.md",
      readActions: {
        fileContentByPath: "/openapi/v2/knowledge-bases/kb-seeded/files/content?path=pages%2Freference.md",
        relatedFilesById: "/openapi/v2/knowledge-bases/kb-seeded/files/bundle-reference/related",
        graphExpansionByFileId: "/openapi/v2/knowledge-bases/kb-seeded/graph/expand?fileId=bundle-reference"
      }
    });
    expect(body.graphPaths).toContain("_graph/by-file/source-guide.json");
    expect(body.graphPaths).toContain("_graph/by-file/source-reference.json");
    expect(body.resultSummary).toMatchObject({
      seedCount: 1,
      relationshipCount: 1
    });
  });

  it("does not return the seed or duplicate files when a second graph hop loops back", async () => {
    const { app, repositories } = createApp();

    if (!repositories.graph?.listActiveGraphNeighborhood) {
      throw new Error("Graph repository is missing from the test fixture.");
    }

    const originalListGraphNeighborhood = repositories.graph.listActiveGraphNeighborhood;
    repositories.graph.listActiveGraphNeighborhood = async (input) => {
      if (input.sourceFileId === "source-reference") {
        return {
          items: [
            {
              fileId: "source-guide",
              sourceFileId: "source-guide",
              bundleFileId: "bundle-guide",
              path: "pages/guide.md",
              title: "Guide",
              relationType: "shared_tag",
              direction: "incoming" as const,
              weight: 0.8,
              reason: "Both files share a topic.",
              source: "deterministic" as const,
              contentAvailable: true
            }
          ],
          nextCursor: null
        };
      }

      return originalListGraphNeighborhood(input);
    };

    const response = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/graph/expand?fileId=bundle-guide&depth=2&fanout=2&limit=10",
      { headers: authHeaders() }
    );
    const body = (await response.json()) as {
      relationships: Array<{ sourceFileId: string; path: string }>;
      resultSummary: { relationshipCount: number };
    };

    expect(response.status).toBe(200);
    expect(body.relationships).toEqual([
      expect.objectContaining({
        sourceFileId: "source-reference",
        path: "pages/reference.md"
      })
    ]);
    expect(body.resultSummary.relationshipCount).toBe(1);
  });

  it("returns graph insights with file-first read actions", async () => {
    const { app } = createApp();
    const response = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/graph/insights",
      {
        headers: authHeaders()
      }
    );
    const body = (await response.json()) as {
      file: {
        fileId: string;
        path: string;
        fileKind: string;
        contentAvailable: boolean;
      };
      contentPath: string;
      insights: Array<Record<string, unknown>>;
      generatedAt: string | null;
      resultSummary: { insightCount: number; meaning: string };
      readActions: {
        graphIndex: string;
        graphManifest: string;
        graphInsightsFile: string;
        graphInsightsContent: string;
      };
    };

    expect(response.status).toBe(200);
    expect(body.file).toMatchObject({
      fileId: "bundle-graph-insights",
      path: "_graph/insights.json",
      fileKind: "graph_insight",
      contentAvailable: true
    });
    expect(body.contentPath).toBe("_graph/insights.json");
    expect(body.generatedAt).toBe(now);
    expect(body.insights).toEqual([
      expect.objectContaining({
        insightId: "insight-seeded",
        title: "Useful graph cluster",
        filePaths: ["pages/guide.md"]
      })
    ]);
    expect(body.resultSummary).toMatchObject({
      insightCount: 1
    });
    expect(body.readActions).toEqual({
      graphIndex: "/openapi/v2/knowledge-bases/kb-seeded/files/content?path=_graph%2Findex.md",
      graphManifest: "/openapi/v2/knowledge-bases/kb-seeded/files/content?path=_graph%2Fmanifest.json",
      graphInsightsFile: "/openapi/v2/knowledge-bases/kb-seeded/files/content?path=_graph%2Finsights.json",
      graphInsightsContent: "/openapi/v2/knowledge-bases/kb-seeded/files/content?path=_graph%2Finsights.json"
    });

    const contentResponse = await app.request(body.readActions.graphInsightsContent, {
      headers: authHeaders()
    });

    expect(contentResponse.status).toBe(200);
  });

  it("caches graph insight responses for the immutable active release", async () => {
    const { app, storage } = createApp();
    const getObjectText = storage.getObjectText.bind(storage);
    let insightObjectReads = 0;
    storage.getObjectText = async (key) => {
      if (key.endsWith("/_graph/insights.json")) {
        insightObjectReads += 1;
      }
      return getObjectText(key);
    };

    const requestPath = "/openapi/v2/knowledge-bases/kb-seeded/graph/insights";
    const firstResponse = await app.request(requestPath, { headers: authHeaders() });
    const secondResponse = await app.request(requestPath, { headers: authHeaders() });

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.json()).toMatchObject({
      contentPath: "_graph/insights.json",
      resultSummary: { insightCount: 1 }
    });
    expect(insightObjectReads).toBe(0);
  });

  it("caches repeated graph expansion pages for the same file seed", async () => {
    const { app, repositories } = createApp();
    const originalListGraphNeighborhood = repositories.graph?.listActiveGraphNeighborhood;
    let graphReadCount = 0;

    if (!originalListGraphNeighborhood || !repositories.graph) {
      throw new Error("Graph repository is missing from the test fixture.");
    }

    repositories.graph.listActiveGraphNeighborhood = async (input) => {
      graphReadCount += 1;
      return originalListGraphNeighborhood(input);
    };

    const requestPath =
      "/openapi/v2/knowledge-bases/kb-seeded/graph/expand?fileId=bundle-guide&depth=1&fanout=1&limit=10";
    const firstResponse = await app.request(requestPath, {
      headers: authHeaders()
    });
    const secondResponse = await app.request(requestPath, {
      headers: authHeaders()
    });
    const secondBody = (await secondResponse.json()) as {
      relationships: Array<{ path: string }>;
    };

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(secondBody.relationships[0]?.path).toBe("pages/reference.md");
    expect(graphReadCount).toBe(1);
  });

  it("expands graph relationships from a graph node seed", async () => {
    const { app } = createApp();
    const response = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/graph/expand?nodeId=source-guide&depth=1&fanout=1&limit=10",
      {
        headers: authHeaders()
      }
    );
    const body = (await response.json()) as {
      query: {
        fileId: string | null;
        nodeId: string | null;
        edgeId: string | null;
      };
      seedFile: {
        fileId: string;
        sourceFileId: string;
      } | null;
      relationships: Array<{ path: string }>;
      graphPaths: string[];
    };

    expect(response.status).toBe(200);
    expect(body.query).toMatchObject({
      fileId: null,
      nodeId: "source-guide",
      edgeId: null
    });
    expect(body.seedFile).toMatchObject({
      fileId: "bundle-guide",
      sourceFileId: "source-guide"
    });
    expect(body.relationships[0]?.path).toBe("pages/reference.md");
    expect(body.graphPaths).toContain("_graph/by-file/source-guide.json");
  });

  it("expands graph relationships from a graph edge seed", async () => {
    const { app } = createApp();
    const response = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/graph/expand?edgeId=edge-guide-reference&depth=1&fanout=1&limit=10",
      {
        headers: authHeaders()
      }
    );
    const body = (await response.json()) as {
      query: {
        fileId: string | null;
        nodeId: string | null;
        edgeId: string | null;
      };
      seedFile: null;
      relationships: Array<{
        path: string;
        readActions: {
          fileContentByPath: string;
          graphExpansionByFileId: string;
        };
      }>;
      graphPaths: string[];
    };

    expect(response.status).toBe(200);
    expect(body.query).toMatchObject({
      fileId: null,
      nodeId: null,
      edgeId: "edge-guide-reference"
    });
    expect(body.seedFile).toBeNull();
    expect(body.relationships[0]).toMatchObject({
      path: "pages/reference.md",
      readActions: {
        fileContentByPath: "/openapi/v2/knowledge-bases/kb-seeded/files/content?path=pages%2Freference.md",
        graphExpansionByFileId: "/openapi/v2/knowledge-bases/kb-seeded/graph/expand?fileId=bundle-reference"
      }
    });
    expect(body.graphPaths).toEqual(
      expect.arrayContaining([
        "_graph/by-file/source-guide.json",
        "_graph/by-file/source-reference.json"
      ])
    );
  });

  it("expands graph relationships from a search query seed", async () => {
    const { app } = createApp();
    const response = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/graph/expand?query=reference&depth=1&fanout=1&limit=10",
      {
        headers: authHeaders()
      }
    );
    const body = (await response.json()) as {
      query: {
        fileId: string | null;
        query: string | null;
        normalizedQuery: string | null;
      };
      seedFile: null;
      seedResults: Array<{
        fileId: string;
        path: string;
        readActions: {
          fileContentByPath: string;
          graphExpansionByFileId: string;
        };
      }>;
      relationships: Array<{
        path: string;
        readActions: {
          fileContentByPath: string;
          graphExpansionByFileId: string;
        };
      }>;
      graphPaths: string[];
      resultSummary: {
        seedCount: number;
        relationshipCount: number;
      };
    };

    expect(response.status).toBe(200);
    expect(body.query).toMatchObject({
      fileId: null,
      query: "reference",
      normalizedQuery: "reference"
    });
    expect(body.seedFile).toBeNull();
    expect(body.seedResults[0]).toMatchObject({
      fileId: "bundle-guide",
      path: "pages/guide.md",
      readActions: {
        fileContentByPath: "/openapi/v2/knowledge-bases/kb-seeded/files/content?path=pages%2Fguide.md",
        graphExpansionByFileId: "/openapi/v2/knowledge-bases/kb-seeded/graph/expand?fileId=bundle-guide"
      }
    });
    expect(body.relationships[0]).toMatchObject({
      path: "pages/reference.md",
      readActions: {
        fileContentByPath: "/openapi/v2/knowledge-bases/kb-seeded/files/content?path=pages%2Freference.md",
        graphExpansionByFileId: "/openapi/v2/knowledge-bases/kb-seeded/graph/expand?fileId=bundle-reference"
      }
    });
    expect(body.graphPaths).toContain("_graph/by-file/source-guide.json");
    expect(body.resultSummary).toMatchObject({
      seedCount: 1,
      relationshipCount: 1
    });
  });

  it("returns graph expansion no-result guidance without claiming the corpus is empty", async () => {
    const { app, repositories } = createApp();

    if (!repositories.files?.searchBundleGraphFiles) {
      throw new Error("Graph search repository is missing from the test fixture.");
    }

    repositories.files.searchBundleGraphFiles = async () => ({ items: [], nextCursor: null });

    const response = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/graph/expand?query=unmatched-topic&depth=1&fanout=1&limit=10",
      {
        headers: authHeaders()
      }
    );
    const body = (await response.json()) as {
      seedResults: unknown[];
      relationships: unknown[];
      message?: string;
      nextActions?: string[];
      resultSummary: {
        seedCount: number;
        relationshipCount: number;
      };
    };

    expect(response.status).toBe(200);
    expect(body.seedResults).toEqual([]);
    expect(body.relationships).toEqual([]);
    expect(body.message).toContain("Relevant data may still exist");
    expect(body.nextActions).toEqual(
      expect.arrayContaining([
        "Read index.md through the file content endpoint.",
        "List the file tree and continue from visible directories."
      ])
    );
    expect(body.resultSummary).toMatchObject({
      seedCount: 0,
      relationshipCount: 0
    });
  });

  it("rejects graph expansion when file and query seeds are both provided", async () => {
    const { app } = createApp();
    const response = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/graph/expand?fileId=bundle-guide&query=reference",
      {
        headers: authHeaders()
      }
    );
    const body = (await response.json()) as {
      error: {
        code: string;
        details?: {
          code?: string;
        };
      };
    };

    expect(response.status).toBe(422);
    expect(body.error).toMatchObject({
      code: "VALIDATION_ERROR",
      details: {
        code: "GRAPH_EXPANSION_SEED_CONFLICT"
      }
    });
  });

  it("rejects graph expansion when no seed is provided", async () => {
    const { app } = createApp();
    const response = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/graph/expand?depth=1&fanout=1&limit=10",
      {
        headers: authHeaders()
      }
    );
    const body = (await response.json()) as {
      error: {
        code: string;
        details?: {
          code?: string;
        };
      };
    };

    expect(response.status).toBe(422);
    expect(body.error).toMatchObject({
      code: "VALIDATION_ERROR",
      details: {
        code: "GRAPH_EXPANSION_SEED_REQUIRED"
      }
    });
  });

  it("rejects invalid graph expansion bounds before repository search", async () => {
    const { app, repositories } = createApp();
    let graphSearchCount = 0;

    if (!repositories.files?.searchBundleGraphFiles) {
      throw new Error("Graph search repository is missing from the test fixture.");
    }

    repositories.files.searchBundleGraphFiles = async () => {
      graphSearchCount += 1;
      return { items: [], nextCursor: null };
    };

    const response = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/graph/expand?query=reference&depth=9&fanout=1&limit=10",
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
        code: "INVALID_GRAPH_EXPANSION_DEPTH"
      }
    });
    expect(graphSearchCount).toBe(0);
  });

  it("preserves file search as the default search mode", async () => {
    const { app } = createApp();
    const response = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/files/search?query=guide&limit=10",
      {
        headers: authHeaders()
      }
    );
    const body = (await response.json()) as {
      searchMode: string;
      graphStatus: string;
      items: Array<{ matchType?: string; graphContext?: unknown }>;
    };

    expect(response.status).toBe(200);
    expect(body.searchMode).toBe("file");
    expect(body.graphStatus).toBe("disabled_for_file_mode");
    expect(body.items[0]).toMatchObject({
      generatedFilePath: "pages/guide.md",
      contentAvailable: true
    });
    expect(body.items[0]).not.toHaveProperty("graphContext");
  });

  it("rejects invalid graph search parameters before repository search", async () => {
    const { app, repositories } = createApp();
    let graphSearchCount = 0;

    if (!repositories.files?.searchBundleGraphFiles) {
      throw new Error("Graph search repository is missing from the test fixture.");
    }

    repositories.files.searchBundleGraphFiles = async () => {
      graphSearchCount += 1;
      return { items: [], nextCursor: null };
    };

    const response = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/files/search?query=guide&mode=graph&graphDepth=9",
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
        code: "INVALID_FILE_SEARCH_GRAPH_DEPTH"
      }
    });
    expect(graphSearchCount).toBe(0);
  });

  it("keeps upload finalization work durable after recreating the API app", async () => {
    const config = createConfig();
    const repositories = createRepositories();
    const storage = new MemoryStorage();
    const firstApp = createPublicOpenApiApp({
      config,
      storage,
      redis: createTestRedisCoordinator(),
      repositories
    });
    const staged = await stageDeveloperUploadSession({
      app: firstApp,
      relativePath: "restart/restart.md",
      content: "# Restart",
      idempotencyKey: "restart-upload-session"
    });
    const finalizeResponse = await firstApp.request(
      `/openapi/v2/knowledge-bases/kb-seeded/upload-sessions/${staged.sessionId}/finalize`,
      { method: "POST", headers: authHeaders() }
    );

    createPublicOpenApiApp({
      config,
      storage,
      redis: createTestRedisCoordinator(),
      repositories
    });
    const activeQueuedWork = await repositories.workerJobs?.countActiveWorkerJobs({
      kinds: ["upload_session_finalization"],
      knowledgeBaseId: "kb-seeded"
    });

    expect(finalizeResponse.status).toBe(202);
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
      "/openapi/v2/knowledge-bases/kb-seeded/source-files/source-guide/retry",
      {
        method: "POST",
        headers: authHeaders()
      }
    );
    const body = (await response.json()) as {
      sourceFile: {
        sourceFileId: string;
        processingState: string;
        currentStage: string;
      };
    };

    expect(response.status).toBe(202);
    expect(body.sourceFile).toMatchObject({
      sourceFileId: "source-guide",
      processingState: "queued",
      currentStage: "upload_storage"
    });
    expect(enqueueCount).toBe(1);
  });

  it("exposes source file endpoints in the OpenAPI contract", async () => {
    const { app } = createApp();
    const response = await app.request("/openapi/v2/openapi.json", {
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
      contract.paths["/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files"]?.get?.parameters?.map(
        (parameter) => parameter.name
      )
    ).toEqual(
      expect.arrayContaining([
        "directoryId",
        "pathQuery",
        "sourceFileIdPrefix",
        "processingState",
        "currentStage",
        "generatedOutputStatus"
      ])
    );
    expect(contract.paths["/openapi/v2/knowledge-bases/{knowledgeBaseId}/tasks"]).toBeUndefined();
  });

  it("publishes operation-specific errors without documentation-only continuity metadata", async () => {
    const { app } = createApp();
    const response = await app.request("/openapi/v2/openapi.json", {
      headers: authHeaders()
    });
    const contract = (await response.json()) as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
      "x-field-continuity"?: unknown;
    };

    expect(Object.keys(contract.paths["/openapi/v2/health"]?.get?.responses ?? {})).toEqual([
      "200",
      "401",
      "429",
      "500"
    ]);
    expect(Object.keys(contract.paths["/openapi/v2/knowledge-bases/{knowledgeBaseId}"]?.get?.responses ?? {})).toEqual([
      "200",
      "401",
      "404",
      "429",
      "500"
    ]);
    expect(
      Object.keys(contract.paths["/openapi/v2/knowledge-bases/{knowledgeBaseId}"]?.delete?.responses ?? {})
    ).toEqual(["202", "401", "404", "409", "422", "429", "500"]);
    expect(contract["x-field-continuity"]).toBeUndefined();
  });

  it("uses current resource identifier formats in every public contract example", async () => {
    const { app } = createApp();
    const response = await app.request("/openapi/v2/openapi.json", {
      headers: authHeaders()
    });
    const contract = await response.json() as Record<string, unknown>;
    const serialized = JSON.stringify(contract);

    expect(serialized).not.toMatch(
      /\b(?:kb|release|webhook|delivery|event|insight|tree|req|file_source|file_page)_\d+\b/u
    );
    expect(serialized).not.toContain("/knowledge-bases/kb_");
  });

  it("lists stable source resources with connected directory and read actions", async () => {
    const { app } = createApp();
    const [directoriesResponse, sourceFilesResponse, sourceFileResponse, contentResponse] =
      await Promise.all([
        app.request(
          "/openapi/v2/knowledge-bases/kb-seeded/source-directories?parentDirectoryId=root&limit=10",
          { headers: authHeaders() }
        ),
        app.request(
          "/openapi/v2/knowledge-bases/kb-seeded/source-files?directoryId=source-directory-pages&limit=10",
          { headers: authHeaders() }
        ),
        app.request(
          "/openapi/v2/knowledge-bases/kb-seeded/source-files/source-guide",
          { headers: authHeaders() }
        ),
        app.request(
          "/openapi/v2/knowledge-bases/kb-seeded/source-files/source-guide/content",
          { headers: authHeaders() }
        )
      ]);
    const directoriesBody = (await directoriesResponse.json()) as {
      items: Array<Record<string, unknown>>;
    };
    const sourceFilesBody = (await sourceFilesResponse.json()) as {
      items: Array<Record<string, unknown>>;
    };
    const sourceFileBody = (await sourceFileResponse.json()) as {
      sourceFile: Record<string, unknown>;
    };

    expect([directoriesResponse.status, sourceFilesResponse.status, sourceFileResponse.status]).toEqual([
      200,
      200,
      200
    ]);
    expect(contentResponse.status).toBe(200);
    await expect(contentResponse.text()).resolves.toBe("# Guide");
    expect(directoriesBody.items[0]).toMatchObject({
      directoryId: "source-directory-pages",
      relativePath: "pages",
      resourceRevision: 1,
      directFileCount: 1,
      descendantFileCount: 1
    });
    expect(sourceFilesBody.items).toHaveLength(1);
    expect(sourceFilesBody.items[0]).toMatchObject({
      sourceFileId: "source-guide",
      directoryId: "source-directory-pages",
      name: "guide.md",
      relativePath: "pages/guide.md",
      generatedPath: "pages/guide.md",
      resourceRevision: 1,
      contentRevision: 1,
      activeRevisionId: "source-revision-source-guide"
    });
    expect(sourceFileBody.sourceFile).toEqual(sourceFilesBody.items[0]);
    expect(sourceFileBody.sourceFile).not.toHaveProperty("objectKey");
    expect(sourceFileBody.sourceFile).not.toHaveProperty("idempotencyKey");
  });

  it("keeps generated file IDs and source file IDs in separate read routes", async () => {
    const { app } = createApp();
    const [generatedResponse, sourceAsGeneratedResponse, sourceResponse] = await Promise.all([
      app.request("/openapi/v2/knowledge-bases/kb-seeded/files/bundle-guide", {
        headers: authHeaders()
      }),
      app.request("/openapi/v2/knowledge-bases/kb-seeded/files/source-guide", {
        headers: authHeaders()
      }),
      app.request("/openapi/v2/knowledge-bases/kb-seeded/source-files/source-guide", {
        headers: authHeaders()
      })
    ]);

    expect(generatedResponse.status).toBe(200);
    expect(sourceAsGeneratedResponse.status).toBe(404);
    expect(sourceResponse.status).toBe(200);
  });

  it("applies documented source-resource filters and rejects invalid filter values", async () => {
    const { app } = createApp();
    const [matchedResponse, missingResponse, invalidResponse] = await Promise.all([
      app.request(
        "/openapi/v2/knowledge-bases/kb-seeded/source-files?pathQuery=guide&processingState=completed&generatedOutputStatus=visible",
        { headers: authHeaders() }
      ),
      app.request(
        "/openapi/v2/knowledge-bases/kb-seeded/source-files?pathQuery=missing",
        { headers: authHeaders() }
      ),
      app.request(
        "/openapi/v2/knowledge-bases/kb-seeded/source-files?processingState=unknown",
        { headers: authHeaders() }
      )
    ]);
    const matched = await matchedResponse.json() as { items: unknown[] };
    const missing = await missingResponse.json() as { items: unknown[] };

    expect(matchedResponse.status).toBe(200);
    expect(matched.items).toHaveLength(1);
    expect(missingResponse.status).toBe(200);
    expect(missing.items).toHaveLength(0);
    expect(invalidResponse.status).toBe(422);
  });

  it("accepts source file and directory moves as connected asynchronous operations", async () => {
    const { app } = createApp();
    const fileMove = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/source-files/source-guide",
      {
        method: "PATCH",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
          "idempotency-key": "move-source-guide",
          "if-match": '"1"'
        },
        body: JSON.stringify({ relativePath: "handbook/setup/guide.md" })
      }
    );
    const directoryMove = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/source-directories/source-directory-pages",
      {
        method: "PATCH",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
          "idempotency-key": "move-source-directory-pages",
          "if-match": '"1"'
        },
        body: JSON.stringify({ relativePath: "handbook" })
      }
    );
    const fileMoveBody = (await fileMove.json()) as {
      operation: { operationId: string; kind: string; actions: { self: string } };
    };
    const directoryMoveBody = (await directoryMove.json()) as {
      operation: { operationId: string; kind: string; actions: { self: string } };
    };

    expect([fileMove.status, directoryMove.status]).toEqual([202, 202]);
    expect(fileMoveBody.operation).toMatchObject({ kind: "source_file_move" });
    expect(directoryMoveBody.operation).toMatchObject({ kind: "source_directory_move" });
    expect(fileMoveBody.operation.actions.self).toContain(fileMoveBody.operation.operationId);
    expect(directoryMoveBody.operation.actions.self).toContain(directoryMoveBody.operation.operationId);

    const operationsResponse = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/operations?state=accepted&limit=10",
      { headers: authHeaders() }
    );
    const operationsBody = (await operationsResponse.json()) as {
      items: Array<{ operationId: string }>;
    };
    expect(operationsResponse.status).toBe(200);
    expect(operationsBody.items.map((item) => item.operationId)).toEqual(
      expect.arrayContaining([
        fileMoveBody.operation.operationId,
        directoryMoveBody.operation.operationId
      ])
    );
  });

  it("accepts complete Markdown replacement without exposing the immutable object key", async () => {
    const { app, storage } = createApp();
    const replacement = "# Updated guide\n\nCurrent content.";
    const response = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/source-files/source-guide/content",
      {
        method: "PUT",
        headers: {
          ...authHeaders(),
          "content-type": "text/markdown; charset=utf-8",
          "idempotency-key": "replace-source-guide",
          "if-match": '"1"',
          "x-source-relative-path": "handbook/updated-guide.md"
        },
        body: replacement
      }
    );
    const body = (await response.json()) as {
      operation: {
        operationId: string;
        kind: string;
        result: Record<string, unknown> | null;
      };
    };

    expect(response.status).toBe(202);
    expect(body.operation.kind).toBe("source_file_replace");
    expect(JSON.stringify(body)).not.toContain("objectKey");
    expect(Array.from(storage.objects.values())).toContain(replacement);
  });

  it("rejects source mutation requests without conditional and idempotency headers", async () => {
    const { app } = createApp();
    const [moveResponse, replaceResponse, deleteResponse] = await Promise.all([
      app.request("/openapi/v2/knowledge-bases/kb-seeded/source-files/source-guide", {
        method: "PATCH",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ relativePath: "moved.md" })
      }),
      app.request("/openapi/v2/knowledge-bases/kb-seeded/source-files/source-guide/content", {
        method: "PUT",
        headers: { ...authHeaders(), "content-type": "text/markdown" },
        body: "# Replacement"
      }),
      app.request("/openapi/v2/knowledge-bases/kb-seeded/source-files/source-guide", {
        method: "DELETE",
        headers: authHeaders()
      })
    ]);

    expect([moveResponse.status, replaceResponse.status, deleteResponse.status]).toEqual([
      422,
      422,
      422
    ]);
  });

  it("documents every returned source resource field in the OpenAPI contract", async () => {
    const { app } = createApp();
    const [contractResponse, sourceResponse, directoryResponse] = await Promise.all([
      app.request("/openapi/v2/openapi.json", { headers: authHeaders() }),
      app.request("/openapi/v2/knowledge-bases/kb-seeded/source-files/source-guide", {
        headers: authHeaders()
      }),
      app.request(
        "/openapi/v2/knowledge-bases/kb-seeded/source-directories/source-directory-pages",
        { headers: authHeaders() }
      )
    ]);
    const contract = (await contractResponse.json()) as {
      components: {
        schemas: Record<string, { properties?: Record<string, unknown> }>;
      };
    };
    const source = (await sourceResponse.json()) as {
      sourceFile: Record<string, unknown>;
    };
    const directory = (await directoryResponse.json()) as {
      directory: Record<string, unknown>;
    };
    const sourceProperties = contract.components.schemas.SourceResourceFile?.properties ?? {};
    const directoryProperties = contract.components.schemas.SourceDirectory?.properties ?? {};

    expect([contractResponse.status, sourceResponse.status, directoryResponse.status]).toEqual([
      200,
      200,
      200
    ]);
    expect(Object.keys(source.sourceFile).filter((key) => key !== "actions")).toEqual(
      expect.arrayContaining(Object.keys(sourceProperties).filter((key) => key !== "actions"))
    );
    expect(Object.keys(source.sourceFile).every((key) => key in sourceProperties)).toBe(true);
    expect(Object.keys(directory.directory).every((key) => key in directoryProperties)).toBe(true);
  });
  it("returns bounded related files for a generated source-backed file", async () => {
    const { app } = createApp();
    const response = await app.request(
      "/openapi/v2/knowledge-bases/kb-seeded/files/bundle-guide/related",
      {
        headers: authHeaders()
      }
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      fileId: string;
      sourceFileId: string;
      items: Array<{
        fileId: string;
        sourceFileId: string;
        bundleFileId: string | null;
        readActions: {
          fileDetailById: string | null;
          fileContentById: string | null;
        };
      }>;
      nextCursor: string | null;
    };

    expect(body).toMatchObject({
      fileId: "bundle-guide",
      sourceFileId: "source-guide",
      nextCursor: null,
      items: [
        {
          fileId: "bundle-reference",
          sourceFileId: "source-reference",
          bundleFileId: "bundle-reference",
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
    expect(body.items[0]?.readActions).toMatchObject({
      fileDetailById: "/openapi/v2/knowledge-bases/kb-seeded/files/bundle-reference",
      fileContentById: "/openapi/v2/knowledge-bases/kb-seeded/files/bundle-reference/content"
    });
  });
});
