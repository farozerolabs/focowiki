import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AdminRepositories } from "../src/db/admin-repositories.js";
import type { RedisCoordinator } from "../src/redis/coordination.js";
import type { StorageAdapter } from "../src/storage/s3.js";
import { processHardDeleteJob } from "../src/worker/hard-delete-jobs.js";
import type { WorkerJobRecord } from "../src/db/worker-job-repository.js";

const hardDeleteJobsPath = resolve(import.meta.dirname, "../src/worker/hard-delete-jobs.ts");
const storageObjectDeletionPath = resolve(
  import.meta.dirname,
  "../src/worker/storage-object-deletion.ts"
);

function readHardDeleteJobs(): string {
  return readFileSync(hardDeleteJobsPath, "utf8").replace(/\s+/g, " ").toLowerCase();
}

function readStorageObjectDeletion(): string {
  return readFileSync(storageObjectDeletionPath, "utf8").replace(/\s+/g, " ").toLowerCase();
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
    const source = readStorageObjectDeletion();

    expect(source).toContain("if (input.versionpurgeenabled)");
    expect(source).toContain("input.storage.deleteobjectversions");
    expect(source).toContain(
      "versioned object purge is not supported by the active storage adapter"
    );
  });

  it("falls back to single-object cleanup when batch deletion is unavailable", () => {
    const source = readStorageObjectDeletion();

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

  it("keeps source-file database rows retryable when Redis cleanup fails", async () => {
    const purgeSourceFileData = vi.fn(async () => 1);
    const clearSourceFileRuntimeKeys = vi.fn(async () => {
      throw new Error("Redis unavailable");
    });
    const repositories = createRepositories({
      markObjectKeysDeleted: vi.fn(async () => 0),
      purgeSourceFileData,
      hasPendingObjectKeysResults: [false]
    });

    await expect(
      processHardDeleteJob({
        job: createSourceFileHardDeleteJob(),
        repositories,
        storage: createStorage(),
        redis: createRedis({ clearSourceFileRuntimeKeys }),
        cursorTtlSeconds: 900,
        settings: {
          databaseBatchSize: 50,
          objectBatchSize: 2,
          versionPurgeEnabled: false
        }
      })
    ).rejects.toThrow("Redis unavailable");

    expect(purgeSourceFileData).not.toHaveBeenCalled();
  });

  it("keeps directory source rows retryable when Redis cleanup fails", async () => {
    const purgeSourceFileData = vi.fn(async () => 1);
    const completeSourceDirectoryDeletion = vi.fn(async () => 1);
    const clearSourceFileRuntimeKeys = vi.fn(async () => {
      throw new Error("Redis unavailable");
    });
    const repositories = createRepositories({
      markObjectKeysDeleted: vi.fn(async () => 0),
      purgeSourceFileData,
      sourceDirectorySourceFilePages: [["source-file-a"]],
      completeSourceDirectoryDeletion,
      hasPendingObjectKeysResults: [false]
    });

    await expect(
      processHardDeleteJob({
        job: createSourceDirectoryHardDeleteJob(),
        repositories,
        storage: createStorage(),
        redis: createRedis({ clearSourceFileRuntimeKeys }),
        cursorTtlSeconds: 900,
        settings: {
          databaseBatchSize: 50,
          objectBatchSize: 2,
          versionPurgeEnabled: false
        }
      })
    ).rejects.toThrow("Redis unavailable");

    expect(purgeSourceFileData).not.toHaveBeenCalled();
    expect(completeSourceDirectoryDeletion).not.toHaveBeenCalled();
  });

  it("defers directory completion while another delete still owns a file reference", async () => {
    const completeSourceDirectoryDeletion = vi.fn(async () => 1);
    const repositories = createRepositories({
      markObjectKeysDeleted: vi.fn(async () => 0),
      purgeSourceFileData: vi.fn(async () => 0),
      completeSourceDirectoryDeletion,
      hasSourceDirectoryFileReferences: true,
      hasPendingObjectKeysResults: [false]
    });

    await expect(
      processHardDeleteJob({
        job: createSourceDirectoryHardDeleteJob(),
        repositories,
        storage: createStorage(),
        redis: createRedis(),
        cursorTtlSeconds: 900,
        settings: {
          databaseBatchSize: 50,
          objectBatchSize: 2,
          versionPurgeEnabled: false
        }
      })
    ).resolves.toEqual({ workerJobDeleted: false, retryAfter: expect.any(String) });

    expect(completeSourceDirectoryDeletion).not.toHaveBeenCalled();
  });

  it("keeps source-file hard delete idempotent when object cursors are already cleared", async () => {
    const markObjectKeysDeleted = vi.fn();
    const purgeSourceFileData = vi.fn(async () => 0);
    const clearSourceFileRuntimeKeys = vi.fn(async () => 0);
    const repositories = createRepositories({
      markObjectKeysDeleted,
      purgeSourceFileData,
      hasPendingObjectKeysResults: [false]
    });
    const storage = {
      keyspace: {} as StorageAdapter["keyspace"],
      putObject: vi.fn(),
      getObjectText: vi.fn(),
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

    expect(storage.deleteObjects).not.toHaveBeenCalled();
    expect(markObjectKeysDeleted).not.toHaveBeenCalled();
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

  it("defers knowledge-base cleanup until concurrent work is terminal", async () => {
    const clearKnowledgeBaseRuntimeKeys = vi.fn(async () => 8);
    const purgeKnowledgeBaseData = vi.fn(async () => 1);
    const repositories = createRepositories({
      markObjectKeysDeleted: vi.fn(async () => 0),
      purgeSourceFileData: vi.fn(async () => 0),
      purgeKnowledgeBaseData,
      activePublicationCount: 1
    });
    const storage = createStorage();

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
    ).resolves.toEqual({ workerJobDeleted: false, retryAfter: expect.any(String) });

    expect(storage.deleteObjects).not.toHaveBeenCalled();
    expect(clearKnowledgeBaseRuntimeKeys).not.toHaveBeenCalled();
    expect(purgeKnowledgeBaseData).not.toHaveBeenCalled();
  });

  it("clears knowledge-base runtime keys after concurrent work stops and before data is purged", async () => {
    const clearKnowledgeBaseRuntimeKeys = vi.fn(async () => 8);
    const clearSourceFileRuntimeKeys = vi.fn(async () => 2);
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
      deleteObjects: vi.fn(async () => undefined)
    } as unknown as StorageAdapter;

    await expect(
      processHardDeleteJob({
        job: createKnowledgeBaseHardDeleteJob(),
        repositories,
        storage,
        redis: createRedis({ clearKnowledgeBaseRuntimeKeys, clearSourceFileRuntimeKeys }),
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
    expect(clearKnowledgeBaseRuntimeKeys.mock.calls).toEqual([
      [{ knowledgeBaseId: "kb-test" }]
    ]);
    expect(clearKnowledgeBaseRuntimeKeys.mock.invocationCallOrder[0]).toBeLessThan(
      purgeKnowledgeBaseData.mock.invocationCallOrder[0] ?? 0
    );
    expect(clearSourceFileRuntimeKeys.mock.calls).toEqual([
      [{ knowledgeBaseId: "kb-test", sourceFileId: "source-file-a" }],
      [{ knowledgeBaseId: "kb-test", sourceFileId: "source-file-b" }]
    ]);
  });

  it("keeps knowledge-base data retryable when Redis cleanup fails", async () => {
    const purgeKnowledgeBaseData = vi.fn(async () => 1);
    const clearKnowledgeBaseRuntimeKeys = vi.fn(async () => {
      throw new Error("Redis unavailable");
    });
    const repositories = createRepositories({
      markObjectKeysDeleted: vi.fn(async () => 0),
      purgeSourceFileData: vi.fn(async () => 0),
      purgeKnowledgeBaseData,
      hasPendingObjectKeysResults: [false]
    });

    await expect(
      processHardDeleteJob({
        job: createKnowledgeBaseHardDeleteJob(),
        repositories,
        storage: createStorage(),
        redis: createRedis({ clearKnowledgeBaseRuntimeKeys }),
        cursorTtlSeconds: 900,
        settings: {
          databaseBatchSize: 50,
          objectBatchSize: 2,
          versionPurgeEnabled: false
        }
      })
    ).rejects.toThrow("Redis unavailable");

    expect(purgeKnowledgeBaseData).not.toHaveBeenCalled();
  });

  it("registers knowledge-base storage-prefix objects before purging database rows", async () => {
    const trackObjectDeletions = vi.fn(async () => 2);
    const purgeKnowledgeBaseData = vi.fn(async () => 1);
    const repositories = createRepositories({
      markObjectKeysDeleted: vi.fn(async () => 0),
      purgeSourceFileData: vi.fn(async () => 0),
      purgeKnowledgeBaseData,
      trackObjectDeletions,
      knowledgeBaseSourceFilePages: [["source-file-a"]]
    });
    const storage = {
      keyspace: {
        knowledgeBaseRootKey: vi.fn(() => "dev/knowledge-bases/kb-test")
      } as unknown as StorageAdapter["keyspace"],
      putObject: vi.fn(),
      getObjectText: vi.fn(),
      listObjectKeys: vi
        .fn()
        .mockResolvedValueOnce({
          keys: ["dev/knowledge-bases/kb-test/releases/old/index.md"],
          nextContinuationToken: "next-page"
        })
        .mockResolvedValueOnce({
          keys: ["dev/knowledge-bases/kb-test/releases/new/index.md"],
          nextContinuationToken: null
        }),
      deleteObjects: vi.fn(async () => undefined)
    } as unknown as StorageAdapter;

    await expect(
      processHardDeleteJob({
        job: createKnowledgeBaseHardDeleteJob(),
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
    ).resolves.toEqual({ workerJobDeleted: true });

    expect(storage.keyspace.knowledgeBaseRootKey).toHaveBeenCalledWith("kb-test");
    expect(storage.listObjectKeys).toHaveBeenNthCalledWith(1, {
      prefix: "dev/knowledge-bases/kb-test/",
      continuationToken: null,
      limit: 2
    });
    expect(storage.listObjectKeys).toHaveBeenNthCalledWith(2, {
      prefix: "dev/knowledge-bases/kb-test/",
      continuationToken: "next-page",
      limit: 2
    });
    expect(trackObjectDeletions).toHaveBeenNthCalledWith(1, {
      jobId: "worker-job-hard-delete",
      knowledgeBaseId: "kb-test",
      objectKeys: ["dev/knowledge-bases/kb-test/releases/old/index.md"]
    });
    expect(trackObjectDeletions).toHaveBeenNthCalledWith(2, {
      jobId: "worker-job-hard-delete",
      knowledgeBaseId: "kb-test",
      objectKeys: ["dev/knowledge-bases/kb-test/releases/new/index.md"]
    });
    expect(purgeKnowledgeBaseData).toHaveBeenCalledWith({
      jobId: "worker-job-hard-delete",
      knowledgeBaseId: "kb-test",
      batchSize: 50
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

function createSourceDirectoryHardDeleteJob(): WorkerJobRecord {
  return {
    ...createSourceFileHardDeleteJob(),
    payload: {
      targetKind: "source_directory",
      sourceDirectoryId: "source-directory-test",
      deletionIntentId: "deletion-intent-directory"
    }
  };
}

function createStorage(): StorageAdapter {
  return {
    keyspace: {} as StorageAdapter["keyspace"],
    putObject: vi.fn(),
    getObjectText: vi.fn(),
    deleteObjects: vi.fn(async () => undefined)
  } as unknown as StorageAdapter;
}

function createRepositories(input: {
  markObjectKeysDeleted: ReturnType<typeof vi.fn>;
  recordHardDeleteProgress?: ReturnType<typeof vi.fn>;
  trackObjectDeletions?: ReturnType<typeof vi.fn>;
  purgeSourceFileData: ReturnType<typeof vi.fn>;
  purgeKnowledgeBaseData?: ReturnType<typeof vi.fn>;
  activePublicationCount?: number;
  knowledgeBaseSourceFilePages?: string[][];
  sourceDirectorySourceFilePages?: string[][];
  hasSourceDirectoryFileReferences?: boolean;
  completeSourceDirectoryDeletion?: ReturnType<typeof vi.fn>;
  hasPendingObjectKeysResults?: boolean[];
}): AdminRepositories {
  const sourceFilePages = input.knowledgeBaseSourceFilePages ?? [[]];
  const directorySourceFilePages = input.sourceDirectorySourceFilePages ?? [[]];
  const hasPendingObjectKeysResults = input.hasPendingObjectKeysResults ?? [true, false];
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
      prepareSourceDirectoryObjectDeletions: vi.fn(async () => 0),
      purgeSourceDirectoryReleaseData: vi.fn(async () => 0),
      clearObjectDeletionTracking: vi.fn(async () => 0),
      listSourceDirectorySourceFileIds: vi.fn(
        async ({ cursor }: { cursor?: string | null }) => {
          const index = cursor ? Number(cursor) : 0;
          const items = directorySourceFilePages[index] ?? [];
          return {
            items,
            nextCursor:
              index + 1 < directorySourceFilePages.length ? String(index + 1) : null
          };
        }
      ),
      isSourceDirectoryExcludedFromActiveRelease: vi.fn(async () => true),
      hasSourceDirectoryFileReferences: vi.fn(
        async () => input.hasSourceDirectoryFileReferences ?? false
      ),
      isSourceFileExcludedFromActiveRelease: vi.fn(async () => true),
      isDeletionIntentRunnable: vi.fn(async () => true),
      completeSourceFileDeletion: vi.fn(async () => undefined),
      completeSourceDirectoryDeletion:
        input.completeSourceDirectoryDeletion ?? vi.fn(async () => 0),
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
        .mockImplementation(async () => hasPendingObjectKeysResults.shift() ?? false),
      cancelQueuedKnowledgeBaseWork: vi.fn(async () => 0),
      trackObjectDeletions: input.trackObjectDeletions ?? vi.fn(async () => 0),
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
