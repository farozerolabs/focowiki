import { describe, expect, it, vi } from "vitest";
import type { GenerationCleanupRepository } from "../src/application/ports/generation-cleanup-repository.js";
import type { RoleJobRecord } from "../src/domain/role-job.js";
import type { StorageAdapter } from "../src/storage/s3.js";
import { createHardDeleteJobProcessor } from "../src/worker/hard-delete-jobs.js";

describe("maintenance hard delete processor", () => {
  it("waits until the deletion is absent from the active generation", async () => {
    const cleanup = createCleanup({ isReady: vi.fn().mockResolvedValue(false) });
    const process = createProcessor(cleanup);

    await expect(process(createJob())).rejects.toMatchObject({
      name: "RoleJobReschedule",
      runAfter: "2026-07-17T12:00:05.000Z"
    });
    expect(cleanup.discoverSourceObjectKeys).not.toHaveBeenCalled();
  });

  it("persists a bounded discovery cursor before continuing", async () => {
    const cleanup = createCleanup({
      discoverSourceObjectKeys: vi.fn().mockResolvedValue({
        objectKeys: ["source/a.md"],
        nextCursor: "source/a.md"
      })
    });
    const process = createProcessor(cleanup);

    await expect(process(createJob())).rejects.toMatchObject({ name: "RoleJobReschedule" });
    expect(cleanup.trackObjectKeys).toHaveBeenCalledWith(expect.objectContaining({
      objectKeys: ["source/a.md"]
    }));
    expect(cleanup.saveCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      checkpoint: expect.objectContaining({
        discoveryCursor: "source/a.md",
        discoveryCompleted: false
      })
    }));
  });

  it("does not advance database cleanup when object deletion fails", async () => {
    const cleanup = createCleanup({
      getCheckpoint: vi.fn().mockResolvedValue({
        phase: "object_deletion",
        discoveryCursor: null,
        discoveryCompleted: true
      }),
      listPendingObjectKeys: vi.fn().mockResolvedValue(["source/a.md"])
    });
    const storage = createStorage();
    storage.deleteObjects = vi.fn().mockRejectedValue(new Error("S3 unavailable"));
    const process = createProcessor(cleanup, storage);

    await expect(process(createJob())).rejects.toThrow("S3 unavailable");
    expect(cleanup.markObjectKeysDeleted).not.toHaveBeenCalled();
    expect(cleanup.purgeTargetBatch).not.toHaveBeenCalled();
  });

  it("continues into database cleanup when an object batch exhausts pending work", async () => {
    const cleanup = createCleanup({
      getCheckpoint: vi.fn().mockResolvedValue({
        phase: "object_deletion",
        discoveryCursor: null,
        discoveryCompleted: true
      }),
      listPendingObjectKeys: vi.fn()
        .mockResolvedValueOnce(["source/a.md"])
        .mockResolvedValueOnce([])
    });
    const process = createProcessor(cleanup);

    await process(createJob());

    expect(cleanup.markObjectKeysDeleted).toHaveBeenCalledWith(expect.objectContaining({
      objectKeys: ["source/a.md"]
    }));
    expect(cleanup.purgeTargetBatch).toHaveBeenCalledOnce();
    expect(cleanup.complete).toHaveBeenCalledOnce();
  });

  it("purges one bounded database page and completes Redis cleanup", async () => {
    const cleanup = createCleanup({
      getCheckpoint: vi.fn().mockResolvedValue({
        phase: "database_cleanup",
        discoveryCursor: null,
        discoveryCompleted: true
      })
    });
    const redis = {
      clearKnowledgeBaseRuntimeKeys: vi.fn(),
      clearSourceFileRuntimeKeys: vi.fn()
    };
    const process = createProcessor(cleanup, createStorage(), redis);

    await process(createJob());

    expect(cleanup.purgeTargetBatch).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
    expect(redis.clearSourceFileRuntimeKeys).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-1",
      sourceFileId: "source-1"
    });
    expect(cleanup.complete).toHaveBeenCalledOnce();
  });

  it("continues before Redis cleanup when database cleanup exposes object deletions", async () => {
    const cleanup = createCleanup({
      getCheckpoint: vi.fn().mockResolvedValue({
        phase: "database_cleanup",
        discoveryCursor: null,
        discoveryCompleted: true
      }),
      purgeTargetBatch: vi.fn().mockResolvedValue({ deletedRows: 0, hasMore: true })
    });
    const redis = {
      clearKnowledgeBaseRuntimeKeys: vi.fn(),
      clearSourceFileRuntimeKeys: vi.fn()
    };
    const process = createProcessor(cleanup, createStorage(), redis);

    await expect(process(createJob({
      sourceFileId: null,
      payload: { targetKind: "knowledge_base", deletionIntentId: "deletion-1" }
    }))).rejects.toMatchObject({ name: "RoleJobReschedule" });

    expect(redis.clearKnowledgeBaseRuntimeKeys).not.toHaveBeenCalled();
    expect(cleanup.complete).not.toHaveBeenCalled();
  });

  it("discovers a knowledge base prefix without per-file fan-out", async () => {
    const cleanup = createCleanup();
    const storage = createStorage();
    storage.listObjectKeys = vi.fn().mockResolvedValue({
      keys: ["generated/kb-1/a"],
      nextContinuationToken: "next"
    });
    const process = createProcessor(cleanup, storage);

    await expect(process(createJob({
      sourceFileId: null,
      payload: { targetKind: "knowledge_base", deletionIntentId: "deletion-1" }
    }))).rejects.toMatchObject({ name: "RoleJobReschedule" });

    expect(storage.listObjectKeys).toHaveBeenCalledWith(expect.objectContaining({ limit: 2 }));
    expect(cleanup.discoverSourceObjectKeys).not.toHaveBeenCalled();
  });
});

function createProcessor(
  cleanup: GenerationCleanupRepository,
  storage = createStorage(),
  redis = {
    clearKnowledgeBaseRuntimeKeys: vi.fn(),
    clearSourceFileRuntimeKeys: vi.fn()
  }
) {
  return createHardDeleteJobProcessor({
    cleanup,
    storage,
    redis,
    settings: {
      databaseBatchSize: 50,
      objectBatchSize: 2,
      versionPurgeEnabled: false,
      continuationDelayMs: 5_000
    },
    now: () => new Date("2026-07-17T12:00:00.000Z")
  });
}

function createCleanup(overrides: Partial<GenerationCleanupRepository> = {}): GenerationCleanupRepository {
  return {
    supersedeTargetWork: vi.fn(),
    getCheckpoint: vi.fn().mockResolvedValue(null),
    saveCheckpoint: vi.fn(),
    isReady: vi.fn().mockResolvedValue(true),
    discoverSourceObjectKeys: vi.fn().mockResolvedValue({ objectKeys: [], nextCursor: null }),
    trackObjectKeys: vi.fn(),
    listPendingObjectKeys: vi.fn().mockResolvedValue([]),
    markObjectKeysDeleted: vi.fn(),
    purgeTargetBatch: vi.fn().mockResolvedValue({ deletedRows: 1, hasMore: false }),
    complete: vi.fn(),
    claimUnreferencedImmutableObjects: vi.fn().mockResolvedValue({ objects: [], nextCursor: null }),
    listClaimedImmutableObjects: vi.fn().mockResolvedValue([]),
    completeImmutableObjectDeletions: vi.fn().mockResolvedValue(0),
    deleteExpiredGenerations: vi.fn().mockResolvedValue(0),
    ...overrides
  };
}

function createStorage(): StorageAdapter {
  return {
    keyspace: {
      knowledgeBaseRootKey: (knowledgeBaseId: string) => `generated/${knowledgeBaseId}`
    } as StorageAdapter["keyspace"],
    putObject: vi.fn(),
    getObjectText: vi.fn(),
    deleteObjects: vi.fn(),
    listObjectKeys: vi.fn().mockResolvedValue({ keys: [], nextContinuationToken: null })
  };
}

function createJob(overrides: Partial<RoleJobRecord> = {}): RoleJobRecord {
  return {
    id: "job-1",
    role: "maintenance",
    kind: "hard_delete",
    knowledgeBaseId: "kb-1",
    sourceFileId: "source-1",
    sourceRevisionId: null,
    generationId: null,
    payload: {
      targetKind: "source_file",
      sourceFileId: "source-1",
      deletionIntentId: "deletion-1"
    },
    settingsSnapshot: {},
    status: "running",
    runAfter: "2026-07-17T12:00:00.000Z",
    attemptCount: 1,
    maxAttempts: 3,
    lockedBy: "maintenance-worker-1",
    lockedAt: "2026-07-17T12:00:00.000Z",
    heartbeatAt: "2026-07-17T12:00:00.000Z",
    createdAt: "2026-07-17T12:00:00.000Z",
    updatedAt: "2026-07-17T12:00:00.000Z",
    ...overrides
  };
}
