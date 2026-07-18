import { describe, expect, it, vi } from "vitest";
import type { GenerationCleanupRepository } from "../src/application/ports/generation-cleanup-repository.js";
import type { RoleJobRecord } from "../src/domain/role-job.js";
import type { StorageAdapter } from "../src/storage/s3.js";
import { createGarbageCollectionJobProcessor } from "../src/worker/garbage-collection-jobs.js";

describe("garbage collection job processor", () => {
  it("deletes retained generation references before immutable objects", async () => {
    const cleanup = createCleanup({ deleteExpiredGenerations: vi.fn().mockResolvedValue(2) });
    const processor = createProcessor(cleanup, 2);

    await expect(processor(createJob())).rejects.toMatchObject({ name: "RoleJobReschedule" });
    expect(cleanup.claimUnreferencedImmutableObjects).not.toHaveBeenCalled();
  });

  it("retries an already claimed object batch after storage failure", async () => {
    const cleanup = createCleanup({
      listClaimedImmutableObjects: vi.fn().mockResolvedValue([{ checksumSha256: "a".repeat(64), formatVersion: 1, objectKey: "generated/a" }])
    });
    const storage = createStorage();
    storage.deleteObjects = vi.fn().mockRejectedValue(new Error("S3 unavailable"));
    const processor = createProcessor(cleanup, 10, storage);

    await expect(processor(createJob())).rejects.toThrow("S3 unavailable");
    expect(cleanup.claimUnreferencedImmutableObjects).not.toHaveBeenCalled();
    expect(cleanup.completeImmutableObjectDeletions).not.toHaveBeenCalled();
  });

  it("removes database identities only after storage deletion succeeds", async () => {
    const object = { checksumSha256: "a".repeat(64), formatVersion: 1, objectKey: "generated/a" };
    const cleanup = createCleanup({
      claimUnreferencedImmutableObjects: vi.fn().mockResolvedValue({ objects: [object], nextCursor: null })
    });
    const storage = createStorage();
    const processor = createProcessor(cleanup, 10, storage);

    await processor(createJob());

    expect(storage.deleteObjects).toHaveBeenCalledWith(["generated/a"]);
    expect(cleanup.completeImmutableObjectDeletions).toHaveBeenCalledWith({
      jobId: "gc-job",
      objects: [{ checksumSha256: "a".repeat(64), formatVersion: 1 }]
    });
  });
});

function createProcessor(
  cleanup: GenerationCleanupRepository,
  batchSize: number,
  storage = createStorage()
) {
  return createGarbageCollectionJobProcessor({
    cleanup,
    storage,
    batchSize,
    retentionDays: 7,
    versionPurgeEnabled: false,
    continuationDelayMs: 1_000,
    now: () => new Date("2026-07-17T12:00:00.000Z")
  });
}

function createCleanup(overrides: Partial<GenerationCleanupRepository> = {}): GenerationCleanupRepository {
  return {
    getCheckpoint: vi.fn(), saveCheckpoint: vi.fn(), isReady: vi.fn(),
    discoverSourceObjectKeys: vi.fn(), trackObjectKeys: vi.fn(),
    listPendingObjectKeys: vi.fn(), markObjectKeysDeleted: vi.fn(),
    purgeTargetBatch: vi.fn(), complete: vi.fn(),
    claimUnreferencedImmutableObjects: vi.fn().mockResolvedValue({ objects: [], nextCursor: null }),
    listClaimedImmutableObjects: vi.fn().mockResolvedValue([]),
    completeImmutableObjectDeletions: vi.fn().mockResolvedValue(0),
    deleteExpiredGenerations: vi.fn().mockResolvedValue(0),
    ...overrides
  } as GenerationCleanupRepository;
}

function createStorage(): StorageAdapter {
  return {
    keyspace: {} as StorageAdapter["keyspace"],
    putObject: vi.fn(),
    getObjectText: vi.fn(),
    deleteObjects: vi.fn()
  };
}

function createJob(): RoleJobRecord {
  return {
    id: "gc-job", role: "maintenance", kind: "garbage_collection",
    knowledgeBaseId: "kb-maintenance", sourceFileId: null, sourceRevisionId: null,
    generationId: null, payload: {}, settingsSnapshot: {}, status: "running",
    runAfter: "2026-07-17T12:00:00.000Z", attemptCount: 1, maxAttempts: 3,
    lockedBy: "maintenance-worker", lockedAt: null, heartbeatAt: null,
    createdAt: "2026-07-17T12:00:00.000Z", updatedAt: "2026-07-17T12:00:00.000Z"
  };
}
