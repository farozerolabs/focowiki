import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AdminRepositories } from "../src/db/admin-repositories.js";
import type { RedisCoordinator } from "../src/redis/coordination.js";
import type { StorageAdapter } from "../src/storage/s3.js";
import { processHardDeleteJob } from "../src/worker/hard-delete-jobs.js";
import type { WorkerJobRecord } from "../src/db/worker-job-repository.js";

const hardDeleteJobsPath = resolve(import.meta.dirname, "../src/worker/hard-delete-jobs.ts");

function readHardDeleteJobs(): string {
  return readFileSync(hardDeleteJobsPath, "utf8").replace(/\s+/g, " ").toLowerCase();
}

describe("hard delete worker job contract", () => {
  it("uses bounded object batches and runtime database batches", () => {
    const source = readHardDeleteJobs();

    expect(source).toContain("batchsize: input.settings.databasebatchsize");
    expect(source).toContain("math.min(math.max(input.settings.objectbatchsize, 1), 1_000)");
    expect(source).toContain("limit: objectbatchsize");
    expect(source).toContain("markobjectkeysdeleted");
  });

  it("keeps versioned object purge disabled until the storage adapter supports it", () => {
    const source = readHardDeleteJobs();

    expect(source).toContain("if (input.versionpurgeenabled)");
    expect(source).toContain("input.storage.deleteobjectversions");
    expect(source).toContain(
      "versioned object purge is not supported by the active storage adapter"
    );
  });

  it("falls back to single-object cleanup when batch deletion is unavailable", () => {
    const source = readHardDeleteJobs();

    expect(source).toContain("if (input.storage.deleteobjects)");
    expect(source).toContain("if (!input.storage.deleteobject)");
    expect(source).toContain("for (const objectkey of input.objectkeys)");
    expect(source).toContain("await input.storage.deleteobject(objectkey)");
  });

  it("keeps object cursors pending when storage batch deletion fails", async () => {
    const markObjectKeysDeleted = vi.fn();
    const purgeSourceFileData = vi.fn();
    const repositories = createRepositories({
      markObjectKeysDeleted,
      purgeSourceFileData
    });
    const storage = {
      keyspace: {} as StorageAdapter["keyspace"],
      putObject: vi.fn(),
      getObjectText: vi.fn(),
      writeCurrentPointer: vi.fn(),
      readCurrentPointer: vi.fn(),
      deleteObjects: vi.fn(async () => {
        throw new Error("Storage delete failed");
      })
    } as unknown as StorageAdapter;

    await expect(
      processHardDeleteJob({
        job: createSourceFileHardDeleteJob(),
        repositories,
        storage,
        redis: createRedis(),
        cursorTtlSeconds: 900,
        settings: {
          databaseBatchSize: 50,
          objectBatchSize: 2,
          versionPurgeEnabled: false
        }
      })
    ).rejects.toThrow("Storage delete failed");

    expect(storage.deleteObjects).toHaveBeenCalledWith(["objects/a.md", "objects/b.md"]);
    expect(markObjectKeysDeleted).not.toHaveBeenCalled();
    expect(purgeSourceFileData).not.toHaveBeenCalled();
  });

  it("marks deleted object cursors before purging database rows", async () => {
    const markObjectKeysDeleted = vi.fn(async () => 2);
    const recordHardDeleteProgress = vi.fn(async () => undefined);
    const purgeSourceFileData = vi.fn(async () => 1);
    const clearSourceFileRuntimeKeys = vi.fn(async () => 3);
    const repositories = createRepositories({
      markObjectKeysDeleted,
      recordHardDeleteProgress,
      purgeSourceFileData
    });
    const storage = {
      keyspace: {} as StorageAdapter["keyspace"],
      putObject: vi.fn(),
      getObjectText: vi.fn(),
      writeCurrentPointer: vi.fn(),
      readCurrentPointer: vi.fn(),
      deleteObjects: vi.fn(async () => undefined)
    } as unknown as StorageAdapter;

    await expect(
      processHardDeleteJob({
        job: createSourceFileHardDeleteJob(),
        repositories,
        storage,
        redis: createRedis({ clearSourceFileRuntimeKeys }),
        cursorTtlSeconds: 900,
        settings: {
          databaseBatchSize: 50,
          objectBatchSize: 2,
          versionPurgeEnabled: false
        }
      })
    ).resolves.toEqual({ workerJobDeleted: false });

    expect(markObjectKeysDeleted).toHaveBeenCalledWith({
      jobId: "worker-job-hard-delete",
      objectKeys: ["objects/a.md", "objects/b.md"],
      deletedAt: expect.any(String)
    });
    expect(recordHardDeleteProgress).toHaveBeenCalledWith({
      jobId: "worker-job-hard-delete",
      stageKey: "object_cleanup",
      cursor: {
        lastObjectKey: "objects/b.md",
        batchSize: 2
      },
      updatedAt: expect.any(String)
    });
    expect(purgeSourceFileData).toHaveBeenCalledWith({
      jobId: "worker-job-hard-delete",
      knowledgeBaseId: "kb-test",
      sourceFileId: "source-file-test",
      batchSize: 50
    });
    expect(clearSourceFileRuntimeKeys).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-test",
      sourceFileId: "source-file-test"
    });
  });

  it("defers source-file hard delete while publication is still active", async () => {
    const purgeSourceFileData = vi.fn();
    const repositories = createRepositories({
      markObjectKeysDeleted: vi.fn(),
      purgeSourceFileData,
      activePublicationCount: 1
    });
    const storage = {
      keyspace: {} as StorageAdapter["keyspace"],
      putObject: vi.fn(),
      getObjectText: vi.fn(),
      writeCurrentPointer: vi.fn(),
      readCurrentPointer: vi.fn(),
      deleteObjects: vi.fn()
    } as unknown as StorageAdapter;

    await expect(
      processHardDeleteJob({
        job: createSourceFileHardDeleteJob(),
        repositories,
        storage,
        redis: createRedis(),
        cursorTtlSeconds: 900,
        settings: {
          databaseBatchSize: 50,
          objectBatchSize: 2,
          versionPurgeEnabled: false
        }
      })
    ).resolves.toEqual({
      workerJobDeleted: false,
      retryAfter: expect.any(String)
    });

    expect(storage.deleteObjects).not.toHaveBeenCalled();
    expect(purgeSourceFileData).not.toHaveBeenCalled();
  });

  it("clears knowledge-base runtime keys after knowledge-base data is purged", async () => {
    const clearKnowledgeBaseRuntimeKeys = vi.fn(async () => 8);
    const purgeKnowledgeBaseData = vi.fn(async () => 1);
    const repositories = createRepositories({
      markObjectKeysDeleted: vi.fn(async () => 0),
      purgeSourceFileData: vi.fn(async () => 0),
      purgeKnowledgeBaseData,
      knowledgeBaseSourceFilePages: [["source-file-a", "source-file-b"]]
    });
    const storage = {
      keyspace: {} as StorageAdapter["keyspace"],
      putObject: vi.fn(),
      getObjectText: vi.fn(),
      writeCurrentPointer: vi.fn(),
      readCurrentPointer: vi.fn(),
      deleteObjects: vi.fn(async () => undefined)
    } as unknown as StorageAdapter;

    await expect(
      processHardDeleteJob({
        job: createKnowledgeBaseHardDeleteJob(),
        repositories,
        storage,
        redis: createRedis({ clearKnowledgeBaseRuntimeKeys }),
        cursorTtlSeconds: 900,
        settings: {
          databaseBatchSize: 50,
          objectBatchSize: 2,
          versionPurgeEnabled: false
        }
      })
    ).resolves.toEqual({ workerJobDeleted: true });

    expect(purgeKnowledgeBaseData).toHaveBeenCalledWith({
      jobId: "worker-job-hard-delete",
      knowledgeBaseId: "kb-test",
      batchSize: 50
    });
    expect(clearKnowledgeBaseRuntimeKeys).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-test",
      sourceFileIds: ["source-file-a", "source-file-b"]
    });
  });

  it("fails safely when versioned object cleanup is requested without adapter support", async () => {
    const markObjectKeysDeleted = vi.fn();
    const purgeSourceFileData = vi.fn();
    const repositories = createRepositories({
      markObjectKeysDeleted,
      purgeSourceFileData
    });
    const storage = {
      keyspace: {} as StorageAdapter["keyspace"],
      putObject: vi.fn(),
      getObjectText: vi.fn(),
      writeCurrentPointer: vi.fn(),
      readCurrentPointer: vi.fn(),
      deleteObjects: vi.fn()
    } as unknown as StorageAdapter;

    await expect(
      processHardDeleteJob({
        job: createSourceFileHardDeleteJob(),
        repositories,
        storage,
        redis: createRedis(),
        cursorTtlSeconds: 900,
        settings: {
          databaseBatchSize: 50,
          objectBatchSize: 2,
          versionPurgeEnabled: true
        }
      })
    ).rejects.toThrow("Versioned object purge is not supported by the active storage adapter.");

    expect(storage.deleteObjects).not.toHaveBeenCalled();
    expect(markObjectKeysDeleted).not.toHaveBeenCalled();
    expect(purgeSourceFileData).not.toHaveBeenCalled();
  });

  it("uses adapter version cleanup when versioned object purge is enabled", async () => {
    const markObjectKeysDeleted = vi.fn(async () => 2);
    const purgeSourceFileData = vi.fn(async () => 1);
    const repositories = createRepositories({
      markObjectKeysDeleted,
      purgeSourceFileData
    });
    const storage = {
      keyspace: {} as StorageAdapter["keyspace"],
      putObject: vi.fn(),
      getObjectText: vi.fn(),
      writeCurrentPointer: vi.fn(),
      readCurrentPointer: vi.fn(),
      deleteObjects: vi.fn(),
      deleteObjectVersions: vi.fn(async () => undefined)
    } as unknown as StorageAdapter;

    await processHardDeleteJob({
      job: createSourceFileHardDeleteJob(),
      repositories,
      storage,
      redis: createRedis(),
      cursorTtlSeconds: 900,
      settings: {
        databaseBatchSize: 50,
        objectBatchSize: 2,
        versionPurgeEnabled: true
      }
    });

    expect(storage.deleteObjectVersions).toHaveBeenCalledWith(["objects/a.md", "objects/b.md"]);
    expect(storage.deleteObjects).not.toHaveBeenCalled();
  });
});

function createSourceFileHardDeleteJob(): WorkerJobRecord {
  return {
    id: "worker-job-hard-delete",
    kind: "hard_delete",
    status: "running",
    knowledgeBaseId: "kb-test",
    sourceFileId: null,
    payload: {
      targetKind: "source_file",
      sourceFileId: "source-file-test"
    },
    runAfter: "2026-06-14T00:00:00.000Z",
    attemptCount: 1,
    maxAttempts: 3,
    lockedBy: "worker-test",
    lockedAt: "2026-06-14T00:00:00.000Z",
    heartbeatAt: null,
    startedAt: "2026-06-14T00:00:00.000Z",
    completedAt: null,
    failedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z"
  };
}

function createKnowledgeBaseHardDeleteJob(): WorkerJobRecord {
  return {
    ...createSourceFileHardDeleteJob(),
    payload: {
      targetKind: "knowledge_base"
    }
  };
}

function createRepositories(input: {
  markObjectKeysDeleted: ReturnType<typeof vi.fn>;
  recordHardDeleteProgress?: ReturnType<typeof vi.fn>;
  purgeSourceFileData: ReturnType<typeof vi.fn>;
  purgeKnowledgeBaseData?: ReturnType<typeof vi.fn>;
  activePublicationCount?: number;
  knowledgeBaseSourceFilePages?: string[][];
}): AdminRepositories {
  const sourceFilePages = input.knowledgeBaseSourceFilePages ?? [[]];
  return {
    knowledgeBases: {
      async getKnowledgeBase(id: string) {
        return id === "kb-test"
          ? {
              id,
              name: "Test knowledge base",
              description: null,
              activeReleaseId: "release-test",
              createdAt: "2026-06-14T00:00:00.000Z",
              updatedAt: "2026-06-14T00:00:00.000Z"
            }
          : null;
      }
    },
    hardDelete: {
      prepareSourceFileObjectDeletions: vi.fn(async () => 2),
      prepareKnowledgeBaseObjectDeletions: vi.fn(async () => 0),
      listKnowledgeBaseSourceFileIds: vi.fn(async ({ cursor }: { cursor?: string | null }) => {
        const index = cursor ? Number(cursor) : 0;
        const items = sourceFilePages[index] ?? [];
        return {
          items,
          nextCursor: index + 1 < sourceFilePages.length ? String(index + 1) : null
        };
      }),
      listPendingObjectKeys: vi.fn(async () => ["objects/a.md", "objects/b.md"]),
      markObjectKeysDeleted: input.markObjectKeysDeleted,
      recordHardDeleteProgress: input.recordHardDeleteProgress ?? vi.fn(async () => undefined),
      hasPendingObjectKeys: vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      cancelQueuedKnowledgeBaseWork: vi.fn(async () => 0),
      purgeSourceFileData: input.purgeSourceFileData,
      purgeKnowledgeBaseData: input.purgeKnowledgeBaseData ?? vi.fn(async () => 0)
    },
    workerJobs: {
      countActiveWorkerJobs: vi.fn(async () => input.activePublicationCount ?? 0)
    }
  } as unknown as AdminRepositories;
}

function createRedis(input: {
  clearSourceFileRuntimeKeys?: ReturnType<typeof vi.fn>;
  clearKnowledgeBaseRuntimeKeys?: ReturnType<typeof vi.fn>;
} = {}): RedisCoordinator {
  return {
    markPaginationInvalid: vi.fn(async () => undefined),
    clearSourceFileRuntimeKeys: input.clearSourceFileRuntimeKeys ?? vi.fn(async () => 0),
    clearKnowledgeBaseRuntimeKeys: input.clearKnowledgeBaseRuntimeKeys ?? vi.fn(async () => 0)
  } as unknown as RedisCoordinator;
}
