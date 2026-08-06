import { describe, expect, it, vi } from "vitest";
import type {
  SearchEngineTransport
} from "../src/application/ports/search-engine-transport.js";
import type {
  StorageVnextSearchCleanupRepository
} from "../src/storage-vnext/search/cleanup-repository.js";
import {
  createStorageVnextSearchCleanup
} from "../src/storage-vnext/search/search-cleanup.js";

describe("storage vNext unified search cleanup", () => {
  it("accepts the validated runtime task timeout and poll interval ratio", () => {
    expect(() => createCleanup(
      createRepository(),
      createTransport(),
      { maxPollAttempts: 1_200 }
    )).not.toThrow();
  });

  it("durably deletes one failed candidate index and its staging documents", async () => {
    const repository = createRepository({
      failedCandidate: {
        publicId: "candidate-failed",
        providerIndexUid: "owned_vnext_kb_candidate_failed",
        correlationPublicId: "cleanup-cycle-a",
        providerTaskUid: null
      }
    });
    const transport = createTransport();
    const cleanup = createCleanup(repository, transport);

    await expect(cleanup.cleanupFailedCandidate({
      failedBefore: "2026-08-01T00:00:00.000Z",
      correlationPublicId: "cleanup-cycle-a"
    })).resolves.toEqual({ outcome: "deleted", candidatePublicId: "candidate-failed" });

    expect(transport.deleteIndex).toHaveBeenCalledWith(
      "owned_vnext_kb_candidate_failed"
    );
    expect(repository.recordCleanupTask).toHaveBeenCalledWith({
      projectionPublicId: "candidate-failed",
      correlationPublicId: "cleanup-cycle-a",
      providerTaskUid: 11
    });
    expect(repository.completeFailedCandidateCleanup).toHaveBeenCalledOnce();
  });

  it("converges a failed candidate whose provider index is already absent", async () => {
    const repository = createRepository({
      failedCandidate: {
        publicId: "candidate-failed",
        providerIndexUid: "owned_vnext_kb_candidate_failed",
        correlationPublicId: "cleanup-cycle-b",
        providerTaskUid: null
      }
    });
    const transport = createTransport({
      getIndex: vi.fn(async () => null)
    });

    await createCleanup(repository, transport).cleanupFailedCandidate({
      failedBefore: "2026-08-01T00:00:00.000Z",
      correlationPublicId: "cleanup-cycle-b"
    });

    expect(transport.deleteIndex).not.toHaveBeenCalled();
    expect(repository.completeFailedCandidateCleanup).toHaveBeenCalledOnce();
  });

  it("deletes only old unreferenced indexes inside the owned namespace", async () => {
    const repository = createRepository({
      retainedProviderIndexUids: ["owned_vnext_active"]
    });
    const transport = createTransport({
      listIndexes: vi.fn(async () => ({
        indexes: [
          index("owned_vnext_active", "2026-07-01T00:00:00.000Z"),
          index("owned_vnext_old_staging", "2026-07-01T00:00:00.000Z"),
          index("owned_vnext_recent_staging", "2026-08-01T01:00:00.000Z"),
          index("foreign_old_staging", "2026-07-01T00:00:00.000Z")
        ],
        total: 4,
        offset: 0
      }))
    });

    await expect(createCleanup(repository, transport).cleanupOrphanIndexes({
      updatedBefore: "2026-08-01T00:00:00.000Z",
      offset: 0
    })).resolves.toEqual({ deleted: 1, nextOffset: 0 });

    expect(transport.deleteIndex).toHaveBeenCalledTimes(1);
    expect(transport.deleteIndex).toHaveBeenCalledWith("owned_vnext_old_staging");
  });

  it("deletes only bounded finished tasks associated with owned indexes", async () => {
    const repository = createRepository();
    const transport = createTransport({
      listFinishedTasks: vi.fn(async () => ({
        tasks: [
          finishedTask(20, "owned_vnext_active"),
          finishedTask(19, "foreign_active"),
          finishedTask(18, null)
        ],
        next: 17
      }))
    });

    await expect(createCleanup(repository, transport).cleanupFinishedTasks({
      finishedBefore: "2026-08-01T00:00:00.000Z",
      from: null
    })).resolves.toEqual({ deleted: 1, next: 17 });

    expect(transport.listFinishedTasks).toHaveBeenCalledWith({
      statuses: ["succeeded", "failed", "canceled"],
      beforeFinishedAt: "2026-08-01T00:00:00.000Z",
      from: null,
      limit: 100
    });
    expect(transport.deleteFinishedTasks).toHaveBeenCalledWith({ taskUids: [20] });
  });

  it("compacts one idle active index after measured high-water and disk gates pass", async () => {
    const repository = createRepository({
      compactionTarget: {
        publicId: "projection-active",
        providerIndexUid: "owned_vnext_active",
        correlationPublicId: "compaction-cycle-a",
        providerTaskUid: null
      }
    });
    const getDatabaseStats = vi
      .fn()
      .mockResolvedValueOnce({ databaseSizeBytes: 100, usedDatabaseSizeBytes: 60 })
      .mockResolvedValueOnce({ databaseSizeBytes: 70, usedDatabaseSizeBytes: 60 });
    const transport = createTransport({ getDatabaseStats });

    await expect(createCleanup(repository, transport).compactHighWater({
      compactedBefore: "2026-08-01T00:00:00.000Z",
      correlationPublicId: "compaction-cycle-a",
      availableDiskBytes: 120
    })).resolves.toEqual({
      outcome: "compacted",
      providerIndexUid: "owned_vnext_active",
      before: { databaseSizeBytes: 100, usedDatabaseSizeBytes: 60 },
      after: { databaseSizeBytes: 70, usedDatabaseSizeBytes: 60 }
    });

    expect(transport.compactIndex).toHaveBeenCalledWith("owned_vnext_active");
    expect(repository.completeCompaction).toHaveBeenCalledWith(expect.objectContaining({
      projectionPublicId: "projection-active",
      databaseSizeBytes: 70,
      usedDatabaseSizeBytes: 60
    }));
  });

  it("requires controlled rebuild when high-water is measured but disk is insufficient", async () => {
    const repository = createRepository();
    const transport = createTransport({
      getDatabaseStats: vi.fn(async () => ({
        databaseSizeBytes: 100,
        usedDatabaseSizeBytes: 60
      }))
    });

    await expect(createCleanup(repository, transport).compactHighWater({
      compactedBefore: "2026-08-01T00:00:00.000Z",
      correlationPublicId: "compaction-cycle-b",
      availableDiskBytes: 99
    })).resolves.toEqual({
      outcome: "rebuild_required",
      before: { databaseSizeBytes: 100, usedDatabaseSizeBytes: 60 }
    });
    expect(transport.compactIndex).not.toHaveBeenCalled();
    expect(repository.claimActiveCompaction).not.toHaveBeenCalled();
  });
});

function createCleanup(
  repository: StorageVnextSearchCleanupRepository,
  transport: SearchEngineTransport,
  overrides: { maxPollAttempts?: number } = {}
) {
  return createStorageVnextSearchCleanup({
    repository,
    transport,
    indexUidPrefix: "owned_vnext",
    indexPageSize: 100,
    taskPageSize: 100,
    maxDeletesPerRun: 10,
    maxPollAttempts: overrides.maxPollAttempts ?? 3,
    pollIntervalMs: 1,
    highWaterRatio: 0.3,
    minimumReclaimableBytes: 1,
    sleep: async () => undefined
  });
}

function createRepository(overrides: {
  failedCandidate?: Awaited<ReturnType<StorageVnextSearchCleanupRepository["claimFailedCandidate"]>>;
  retainedProviderIndexUids?: string[];
  compactionTarget?: Awaited<ReturnType<StorageVnextSearchCleanupRepository["claimActiveCompaction"]>>;
} = {}): StorageVnextSearchCleanupRepository & Record<string, ReturnType<typeof vi.fn>> {
  return {
    claimFailedCandidate: vi.fn(async () => overrides.failedCandidate ?? null),
    listRetainedProviderIndexUids: vi.fn(async () =>
      overrides.retainedProviderIndexUids ?? []),
    claimActiveCompaction: vi.fn(async () => overrides.compactionTarget ?? null),
    recordCleanupTask: vi.fn(async () => undefined),
    clearCleanupTask: vi.fn(async () => undefined),
    completeFailedCandidateCleanup: vi.fn(async () => undefined),
    completeCompaction: vi.fn(async () => undefined)
  };
}

function createTransport(overrides: Partial<SearchEngineTransport> = {}): SearchEngineTransport {
  const deletedIndexes = new Set<string>();
  return {
    health: vi.fn(async () => ({ available: true })),
    getPressure: vi.fn(async () => ({
      queueLatencyMs: 0,
      residentMemoryBytes: 0,
      databaseSizeBytes: 0,
      taskQueueSizeBytes: 0
    })),
    createIndex: vi.fn(async () => ({ taskUid: 1 })),
    getIndex: vi.fn(async ({ indexUid }) => deletedIndexes.has(indexUid)
      ? null
      : { uid: indexUid, primaryKey: "id" }),
    getDocument: vi.fn(async () => null),
    getSettings: vi.fn(async () => { throw new Error("unused"); }),
    updateSettings: vi.fn(async () => ({ taskUid: 2 })),
    addDocuments: vi.fn(async () => ({ taskUid: 3 })),
    deleteDocuments: vi.fn(async () => ({ taskUid: 4 })),
    deleteIndex: vi.fn(async (indexUid) => {
      deletedIndexes.add(indexUid);
      return { taskUid: 11 };
    }),
    listIndexes: vi.fn(async () => ({ indexes: [], total: 0, offset: 0 })),
    listFinishedTasks: vi.fn(async () => ({ tasks: [], next: null })),
    deleteFinishedTasks: vi.fn(async () => ({ taskUid: 12 })),
    getDatabaseStats: vi.fn(async () => ({
      databaseSizeBytes: 0,
      usedDatabaseSizeBytes: 0
    })),
    compactIndex: vi.fn(async () => ({ taskUid: 13 })),
    swapIndexes: vi.fn(async () => ({ taskUid: 6 })),
    getTask: vi.fn(async (taskUid) => ({
      taskUid,
      status: "succeeded" as const,
      errorCode: null
    })),
    search: vi.fn(async () => ({
      hits: [],
      estimatedTotalHits: 0,
      processingTimeMs: 0
    })),
    ...overrides
  };
}

function index(uid: string, updatedAt: string) {
  return { uid, createdAt: updatedAt, updatedAt };
}

function finishedTask(taskUid: number, indexUid: string | null) {
  return {
    taskUid,
    indexUid,
    status: "succeeded" as const,
    finishedAt: "2026-07-01T00:00:00.000Z"
  };
}
