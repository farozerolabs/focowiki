import { describe, expect, it } from "vitest";
import type { OkfGraphEdge, OkfGraphNode } from "@focowiki/okf";
import { createApiApp } from "../src/server.js";
import type { RuntimeConfig } from "../src/config.js";
import type {
  BundleFileRecord,
  BundleTreeEntryDraft,
  SourceFileEventDraft,
  SourceFileRecord
} from "../src/db/admin-repositories.js";
import type { WorkerJobRecord, WorkerJobRepository } from "../src/db/worker-job-repository.js";
import { hashPublicOpenApiKey } from "../src/public-openapi/keys.js";
import { createRedisCoordinator } from "../src/redis/coordination.js";
import { createStorageKeyspace } from "../src/storage/keys.js";
import type { StorageAdapter, StoredObject } from "../src/storage/s3.js";
import {
  loginAndReadSessionCookie,
  MemoryRedisCommandClient,
  withTrustedAdminOrigin
} from "./support/session.js";

const now = "2026-06-14T00:00:00.000Z";

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
    publication: {
      mode: "batch",
      batchSize: 300,
      intervalSeconds: 300,
      indexShardSize: 1,
      linkIndexShardSize: 1,
      manifestShardSize: 1,
      graphEdgeShardSize: 1,
      graphCandidateLimit: 1,
      graphMaintenanceBatchSize: 1,
      rootSummaryLimit: 1
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
    ["tenant/demo/source/intro.md", "---\ntype: page\ntitle: Intro\n---\n# Intro"],
    ["tenant/demo/source/setup.md", "---\ntype: page\ntitle: Setup\n---\n# Setup"],
    ["tenant/demo/source/advanced.md", "---\ntype: page\ntitle: Advanced\n---\n# Advanced"],
    [
      "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/pages/intro.md",
      "---\ntype: page\ntitle: Intro\n---\n# Intro"
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
    throw new Error("Not used by admin deletion tests");
  }

  public async readCurrentPointer(): Promise<null> {
    return null;
  }
}

function createRepositories() {
  const knowledgeBase = {
    id: "kb-001",
    name: "Developer docs",
    description: null,
    activeReleaseId: "release-001",
    createdAt: now,
    updatedAt: now,
    deletedAt: null as string | null
  };
  const sourceFiles: SourceFileRecord[] = [
    {
      id: "source-001",
      knowledgeBaseId: "kb-001",
      originalName: "intro.md",
      objectKey: "tenant/demo/source/intro.md",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 42,
      checksumSha256: "checksum-intro",
      metadata: { type: "page", title: "Intro" },
      modelSuggestions: null,
      processingStatus: "completed",
      processingStage: "release_activation",
      processingStartedAt: now,
      processingEndedAt: now,
      processingErrorCode: null,
      processingErrorMessage: null,
      retryCount: 0,
      createdAt: now,
      deletedAt: null
    },
    {
      id: "source-002",
      knowledgeBaseId: "kb-001",
      originalName: "setup.md",
      objectKey: "tenant/demo/source/setup.md",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 42,
      checksumSha256: "checksum-setup",
      metadata: { type: "page", title: "Setup" },
      modelSuggestions: null,
      processingStatus: "completed",
      processingStage: "release_activation",
      processingStartedAt: now,
      processingEndedAt: now,
      processingErrorCode: null,
      processingErrorMessage: null,
      retryCount: 0,
      createdAt: now,
      deletedAt: null
    },
    {
      id: "source-003",
      knowledgeBaseId: "kb-001",
      originalName: "advanced.md",
      objectKey: "tenant/demo/source/advanced.md",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 48,
      checksumSha256: "checksum-advanced",
      metadata: { type: "page", title: "Advanced" },
      modelSuggestions: null,
      processingStatus: "completed",
      processingStage: "release_activation",
      processingStartedAt: now,
      processingEndedAt: now,
      processingErrorCode: null,
      processingErrorMessage: null,
      retryCount: 0,
      createdAt: now,
      deletedAt: null
    }
  ];
  const bundleFiles: BundleFileRecord[] = [
    {
      id: "bundle-file-page",
      knowledgeBaseId: "kb-001",
      releaseId: "release-001",
      sourceFileId: "source-001",
      fileKind: "page",
      logicalPath: "pages/intro.md",
      objectKey: "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/pages/intro.md",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 42,
      checksumSha256: "checksum",
      okfType: "page",
      title: "Intro",
      description: null,
      tags: [],
      frontmatter: { type: "page", title: "Intro" }
    }
  ];
  const sourceEvents: SourceFileEventDraft[] = [];
  const publicationJobs: Array<{
    id: string;
    knowledgeBaseId: string;
    mode: "batch" | "manual" | "per_file";
    reason: "bootstrap" | "batch_threshold" | "batch_interval" | "manual" | "per_file" | "deletion";
    status: "queued" | "running" | "completed" | "failed";
    dirtySourceCount: number;
    releaseId: string | null;
    startedAt: string | null;
    endedAt: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: string;
    updatedAt: string;
  }> = [];
  const workerJobs: Array<{
    kind: "publication";
    knowledgeBaseId: string;
    payload: { reason: "deletion" };
    runAfter: string;
    maxAttempts: number;
  }> = [];
  const graphNodes = new Map<string, OkfGraphNode>([
    ["source-001", createGraphNode("source-001", "pages/intro.md", "Intro")],
    ["source-002", createGraphNode("source-002", "pages/setup.md", "Setup")],
    ["source-003", createGraphNode("source-003", "pages/advanced.md", "Advanced")]
  ]);
  const graphEdges: OkfGraphEdge[] = [
    {
      fromFileId: "source-001",
      toFileId: "source-002",
      relationType: "shared_tag",
      weight: 0.8,
      reason: "Both files share tags.",
      source: "deterministic"
    }
  ];
  const graphDeletedSourceFileIds: string[] = [];

  return {
    records: {
      knowledgeBase,
      sourceFiles,
      bundleFiles,
      sourceEvents,
      graphNodes,
      graphEdges,
      graphDeletedSourceFileIds,
      publicationJobs,
      workerJobs,
      storageObjects: [] as string[]
    },
    repositories: {
      knowledgeBases: {
        async listKnowledgeBases() {
          return { items: [knowledgeBase], nextCursor: null };
        },
        async createKnowledgeBase() {
          return knowledgeBase;
        },
        async getKnowledgeBase(id: string) {
          return id === knowledgeBase.id && !knowledgeBase.deletedAt ? knowledgeBase : null;
        },
        async softDeleteKnowledgeBase(input: { id: string; deletedAt: string }) {
          if (input.id !== knowledgeBase.id) {
            return false;
          }

          knowledgeBase.deletedAt = input.deletedAt;
          return true;
        }
      },
      files: {
        async getBundleFile(input: { logicalPath: string }) {
          return bundleFiles.find((file) => file.logicalPath === input.logicalPath) ?? null;
        },
        async createRelease(release: {
          id: string;
          knowledgeBaseId: string;
          bundleRootKey: string;
          generatedAt: string;
          publishedAt: string | null;
          fileCount: number;
          manifestChecksumSha256: string;
        }) {
          knowledgeBase.activeReleaseId = release.id;
        },
        async createBundleFiles(files: BundleFileRecord[]) {
          bundleFiles.push(...files);
        },
        async createBundleTreeEntries(_entries: BundleTreeEntryDraft[]) {
          return undefined;
        },
        async activateRelease(input: { releaseId: string }) {
          knowledgeBase.activeReleaseId = input.releaseId;
        },
        async listSourceFiles(input: { limit: number; cursor: string | null }) {
          const active = sourceFiles.filter((file) => !file.deletedAt);
          return {
            items: active.slice(0, input.limit),
            nextCursor: null
          };
        },
        async softDeleteSourceFile(input: { sourceFileId: string; deletedAt: string }) {
          const source = sourceFiles.find((file) => file.id === input.sourceFileId);

          if (!source || source.deletedAt) {
            return false;
          }

          source.deletedAt = input.deletedAt;
          return true;
        },
        async createSourceFileEvent(input: SourceFileEventDraft) {
          sourceEvents.push(input);
          return {
            id: `event-${sourceEvents.length}`,
            ...input,
            createdAt: now
          };
        },
        async listBundleTreeEntries() {
          return { items: [], nextCursor: null };
        },
        async listReleases() {
          return { items: [], nextCursor: null };
        },
        async listBundleFiles() {
          return { items: bundleFiles, nextCursor: null };
        },
        async listPublicationLogHistory() {
          return { entries: [], summaries: [] };
        },
        async markSourceFilesPublicationDirty() {
          return undefined;
        },
        async countDirtySourceFiles() {
          return { count: 0, oldestDirtyAt: null };
        },
        async listDirtySourceFiles() {
          return { items: [], nextCursor: null };
        },
        async markSourceFilesPublicationVisible() {
          return undefined;
        },
        async markSourceFilesPublicationFailed() {
          return undefined;
        },
        async createPublicationJob(input: {
          id: string;
          knowledgeBaseId: string;
          mode: "batch" | "manual" | "per_file";
          reason: "bootstrap" | "batch_threshold" | "batch_interval" | "manual" | "per_file" | "deletion";
          dirtySourceCount: number;
        }) {
          const job = {
            ...input,
            status: "queued" as const,
            releaseId: null,
            startedAt: null,
            endedAt: null,
            errorCode: null,
            errorMessage: null,
            createdAt: now,
            updatedAt: now
          };
          publicationJobs.push(job);
          return job;
        },
        async startPublicationJob(input: { id: string; startedAt: string }) {
          const job = publicationJobs.find((item) => item.id === input.id);
          if (!job) {
            return null;
          }
          job.status = "running";
          job.startedAt = input.startedAt;
          job.updatedAt = input.startedAt;
          return job;
        },
        async completePublicationJob(input: { id: string; releaseId: string; endedAt: string }) {
          const job = publicationJobs.find((item) => item.id === input.id);
          if (!job) {
            return null;
          }
          job.status = "completed";
          job.releaseId = input.releaseId;
          job.endedAt = input.endedAt;
          job.updatedAt = input.endedAt;
          return job;
        },
        async failPublicationJob(input: {
          id: string;
          endedAt: string;
          errorCode: string;
          errorMessage: string;
        }) {
          const job = publicationJobs.find((item) => item.id === input.id);
          if (!job) {
            return null;
          }
          job.status = "failed";
          job.endedAt = input.endedAt;
          job.errorCode = input.errorCode;
          job.errorMessage = input.errorMessage;
          job.updatedAt = input.endedAt;
          return job;
        }
      },
      publicApiKeys: {
        async countActivePublicOpenApiKeys() {
          return 1;
        },
        async listPublicOpenApiKeys() {
          return { items: [], nextCursor: null };
        },
        async createPublicOpenApiKey() {
          throw new Error("Not used by admin deletion tests");
        },
        async findActivePublicOpenApiKeyByHash(candidateHash: string) {
          const hash = hashPublicOpenApiKey("fwok_test-public-secret");
          return candidateHash === hash
            ? {
                id: "key-001",
                name: "Default",
                keyHash: hash,
                keyPrefix: "fwok",
                keySuffix: "cret",
                status: "active" as const,
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
      graph: {
        async upsertGraphNode(input: { node: OkfGraphNode }) {
          graphNodes.set(input.node.fileId, input.node);
        },
        async upsertGraphEdges(input: { edges: OkfGraphEdge[] }) {
          graphEdges.push(...input.edges);
        },
        async listGraphNodes(input: { limit: number }) {
          return {
            items: Array.from(graphNodes.values()).slice(0, input.limit),
            nextCursor: null
          };
        },
        async listGraphEdges(input: { limit: number }) {
          return {
            items: graphEdges.slice(0, input.limit),
            nextCursor: null
          };
        },
        async listGraphNeighborhood() {
          return { items: [], nextCursor: null };
        },
        async deleteGraphForSourceFile(input: { sourceFileId: string }) {
          graphDeletedSourceFileIds.push(input.sourceFileId);
          graphNodes.delete(input.sourceFileId);
          for (let index = graphEdges.length - 1; index >= 0; index -= 1) {
            const edge = graphEdges[index];

            if (edge?.fromFileId === input.sourceFileId || edge?.toFileId === input.sourceFileId) {
              graphEdges.splice(index, 1);
            }
          }
        }
      },
      workerJobs: {
        async enqueueWorkerJob() {
          throw new Error("Not used by admin deletion tests");
        },
        async enqueueSourceFileJob() {
          throw new Error("Not used by admin deletion tests");
        },
        async enqueuePublicationJob(input: {
          knowledgeBaseId: string;
          reason: string;
          runAfter: string;
          maxAttempts: number;
        }) {
          if (input.reason !== "deletion") {
            throw new Error("Admin deletion tests only accept deletion publication jobs");
          }
          const job = {
            kind: "publication" as const,
            knowledgeBaseId: input.knowledgeBaseId,
            payload: { reason: "deletion" as const },
            runAfter: input.runAfter,
            maxAttempts: input.maxAttempts
          };
          workerJobs.push(job);
          const record: WorkerJobRecord = {
            id: `worker-job-${workerJobs.length}`,
            kind: job.kind,
            status: "queued",
            knowledgeBaseId: job.knowledgeBaseId,
            sourceFileId: null,
            payload: job.payload,
            runAfter: job.runAfter,
            attemptCount: 0,
            maxAttempts: job.maxAttempts,
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
          return record;
        },
        async claimWorkerJobs() {
          return [];
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
        async releaseWorkerJob() {
          return null;
        },
        async heartbeatWorkerJob() {
          return null;
        },
        async recordWorkerHeartbeat(input: {
          workerId: string;
          lastSeenAt: string;
          activeJobCount: number;
          metadata?: Record<string, unknown>;
        }) {
          return {
            workerId: input.workerId,
            lastSeenAt: input.lastSeenAt,
            activeJobCount: input.activeJobCount,
            metadata: input.metadata ?? {},
            createdAt: now,
            updatedAt: now
          };
        },
        async listWorkerHeartbeats() {
          return [];
        },
        async getWorkerQueueSummary() {
          return {
            queuedCount: 0,
            runningCount: 0,
            completedCount: 0,
            failedCount: 0,
            deadLetterCount: 0,
            oldestQueuedAt: null,
            oldestQueuedAgeSeconds: null
          };
        },
        async cleanupWorkerJobs() {
          return 0;
        },
        async countActiveWorkerJobs() {
          return 0;
        }
      } satisfies WorkerJobRepository
    }
  };
}

describe("admin source deletion", () => {
  it("deletes a source-backed page and queues release publication", async () => {
    const config = createConfig();
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const { records, repositories } = createRepositories();
    const app = createApiApp({
      config,
      storage,
      redis,
      repositories
    });
    const sessionCookie = await loginAndReadSessionCookie(app);
    const storageObjectCountBeforeDelete = storage.objects.size;
    const response = await app.request(
      "/admin/api/knowledge-bases/kb-001/files/detail?path=pages/intro.md",
      {
        method: "DELETE",
        headers: withTrustedAdminOrigin({
          cookie: sessionCookie
        })
      }
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { deleted: boolean; publicationQueued: boolean };
    expect(body.deleted).toBe(true);
    expect(body.publicationQueued).toBe(true);
    expect(records.sourceFiles.find((file) => file.id === "source-001")?.deletedAt).toEqual(
      expect.any(String)
    );
    expect(records.knowledgeBase.activeReleaseId).toBe("release-001");
    expect(records.sourceEvents.some((event) => event.stageKey === "source_deletion")).toBe(true);
    expect(records.graphDeletedSourceFileIds).toContain("source-001");
    expect(records.graphNodes.has("source-001")).toBe(false);
    expect(records.graphEdges).toHaveLength(0);
    expect(records.publicationJobs).toHaveLength(0);
    expect(records.workerJobs).toHaveLength(1);
    expect(records.workerJobs[0]?.payload.reason).toBe("deletion");
    expect(storage.objects.size).toBe(storageObjectCountBeforeDelete);
  });
});

function createGraphNode(fileId: string, filePath: string, title: string): OkfGraphNode {
  return {
    fileId,
    path: filePath,
    title,
    type: "page",
    tags: [],
    headings: [title],
    keywords: [title.toLowerCase()],
    metadata: {
      type: "page",
      title
    }
  };
}
