import { describe, expect, it, vi } from "vitest";
import type {
  SearchEngineTransport
} from "../src/application/ports/search-engine-transport.js";
import type {
  SearchProjectionStateRepository,
  SearchProjectionWork
} from "../src/application/ports/search-projection-state-repository.js";
import { processSearchIndexingWork } from "../src/search/search-indexing-worker.js";

describe("search indexing worker", () => {
  it("persists the task UID before polling an accepted document task", async () => {
    const events: string[] = [];
    const work = createWork({ state: "queued", taskUid: null });
    const repository = fakeRepository({
      markSubmitted: vi.fn(async () => {
        events.push("persisted");
        return true;
      })
    });
    const transport = fakeTransport({
      addDocuments: vi.fn(async () => {
        events.push("submitted");
        return { taskUid: 41 };
      }),
      getTask: vi.fn(async () => {
        events.push("polled");
        return { taskUid: 41, status: "processing" as const, errorCode: null };
      })
    });

    const result = await processSearchIndexingWork({
      work,
      repository,
      transport,
      resolveIndexUid: () => "content-index",
      loadDocuments: async () => [{ id: "segment-one", body: "body" }],
      now: () => new Date("2026-07-29T00:00:00.000Z"),
      leaseDurationMs: 30_000,
      retryDelayMs: 2_000
    });

    expect(result).toBe("submitted");
    expect(events).toEqual(["submitted", "persisted"]);
    expect(transport.getTask).not.toHaveBeenCalled();
    expect(repository.markSubmitted).toHaveBeenCalledWith(
      expect.objectContaining({ taskUid: 41 })
    );
  });

  it("reconciles an accepted document task before submitting a duplicate", async () => {
    const work = createWork({ state: "queued", taskUid: null });
    const repository = fakeRepository();
    const transport = fakeTransport({
      findTaskByCorrelation: vi.fn(async () => ({
        taskUid: 40,
        status: "processing" as const,
        errorCode: null
      })),
      addDocuments: vi.fn()
    });

    await expect(processSearchIndexingWork({
      work,
      repository,
      transport,
      resolveIndexUid: () => "content-index",
      loadDocuments: async () => {
        throw new Error("Recovered work must not remap source content");
      },
      now: () => new Date("2026-07-29T00:00:30.000Z"),
      leaseDurationMs: 30_000,
      retryDelayMs: 2_000
    })).resolves.toBe("submitted");

    expect(transport.findTaskByCorrelation).toHaveBeenCalledWith({
      indexUid: "content-index",
      correlation: "search-work-one"
    });
    expect(transport.addDocuments).not.toHaveBeenCalled();
    expect(repository.markSubmitted).toHaveBeenCalledWith(
      expect.objectContaining({ taskUid: 40 })
    );
  });

  it("marks submitted work complete only after the engine task succeeds", async () => {
    const work = createWork({ state: "submitted", taskUid: 41 });
    const repository = fakeRepository();
    const transport = fakeTransport({
      getTask: vi.fn(async () => ({
        taskUid: 41,
        status: "succeeded" as const,
        errorCode: null
      }))
    });

    const result = await processSearchIndexingWork({
      work,
      repository,
      transport,
      resolveIndexUid: () => "content-index",
      loadDocuments: async () => {
        throw new Error("Submitted work must not remap source content");
      },
      now: () => new Date("2026-07-29T00:01:00.000Z"),
      leaseDurationMs: 30_000,
      retryDelayMs: 2_000
    });

    expect(result).toBe("succeeded");
    expect(repository.markSucceeded).toHaveBeenCalledOnce();
  });

  it("persists a safe retry when a task fails", async () => {
    const work = createWork({ state: "submitted", taskUid: 42 });
    const repository = fakeRepository({
      retryOrFail: vi.fn(async () => "retry" as const)
    });
    const transport = fakeTransport({
      getTask: vi.fn(async () => ({
        taskUid: 42,
        status: "failed" as const,
        errorCode: "SEARCH_INDEX_TASK_FAILED"
      }))
    });

    const result = await processSearchIndexingWork({
      work,
      repository,
      transport,
      resolveIndexUid: () => "content-index",
      loadDocuments: async () => [],
      now: () => new Date("2026-07-29T00:02:00.000Z"),
      leaseDurationMs: 30_000,
      retryDelayMs: 2_000
    });

    expect(result).toBe("retry");
    expect(repository.retryOrFail).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "SEARCH_INDEX_TASK_FAILED",
        message: "Search indexing task did not complete"
      })
    );
  });

  it("reports bounded failure context without changing persistence behavior", async () => {
    const repository = fakeRepository({
      retryOrFail: vi.fn(async () => "failed" as const)
    });
    const onFailure = vi.fn();
    const error = Object.assign(new Error("temporary directory unavailable"), {
      code: "ENOENT"
    });
    const transport = fakeTransport({
      addDocuments: vi.fn(async () => {
        throw error;
      })
    });

    await expect(processSearchIndexingWork({
      work: createWork({ state: "queued", taskUid: null }),
      repository,
      transport,
      resolveIndexUid: () => "content-index",
      loadDocuments: async () => [{ id: "segment-one", body: "body" }],
      leaseDurationMs: 30_000,
      retryDelayMs: 2_000,
      onFailure
    })).resolves.toBe("failed");

    expect(onFailure).toHaveBeenCalledWith({
      workId: "search-work-one",
      knowledgeBaseId: "kb-one",
      generationId: "generation-one",
      epoch: 1,
      indexKind: "content",
      workKind: "documents",
      attemptNumber: 1,
      maxAttempts: 5,
      code: "ENOENT",
      message: "Search indexing is temporarily unavailable",
      outcome: "failed"
    }, error);
  });

  it("treats unknown and canceled tasks as durable failures", async () => {
    for (const status of ["unknown", "canceled"] as const) {
      const work = createWork({ state: "submitted", taskUid: 43 });
      const repository = fakeRepository({
        retryOrFail: vi.fn(async () => "retry" as const)
      });
      const transport = fakeTransport({
        getTask: vi.fn(async () => ({
          taskUid: 43,
          status,
          errorCode: null
        }))
      });

      await expect(processSearchIndexingWork({
        work,
        repository,
        transport,
        resolveIndexUid: () => "content-index",
        loadDocuments: async () => [],
        now: () => new Date("2026-07-29T00:03:00.000Z"),
        leaseDurationMs: 30_000,
        retryDelayMs: 2_000
      })).resolves.toBe("retry");
      expect(repository.retryOrFail).toHaveBeenCalledWith(
        expect.objectContaining({
          code: status === "canceled"
            ? "SEARCH_INDEX_TASK_CANCELED"
            : "SEARCH_INDEX_TASK_UNKNOWN"
        })
      );
    }
  });

  it("runs idempotent lifecycle work before marking it complete", async () => {
    const work = {
      ...createWork({ state: "queued", taskUid: null }),
      workKind: "prepare_index" as const
    };
    const repository = fakeRepository();
    const prepareIndex = vi.fn(async () => undefined);

    const result = await processSearchIndexingWork({
      work,
      repository,
      transport: fakeTransport(),
      resolveIndexUid: () => "content-index",
      loadDocuments: async () => [],
      lifecycle: { prepareIndex },
      now: () => new Date("2026-07-29T00:04:00.000Z"),
      leaseDurationMs: 30_000,
      retryDelayMs: 2_000
    });

    expect(result).toBe("succeeded");
    expect(prepareIndex).toHaveBeenCalledWith(work);
    expect(repository.markSucceeded).toHaveBeenCalledOnce();
  });

  it("does not treat durable planning as cleanup lifecycle work", async () => {
    const repository = fakeRepository();
    const cleanupIndex = vi.fn();

    await expect(processSearchIndexingWork({
      work: {
        ...createWork({ state: "queued", taskUid: null }),
        workKind: "plan_documents"
      },
      repository,
      transport: fakeTransport(),
      resolveIndexUid: () => "content-index",
      loadDocuments: async () => [],
      lifecycle: { cleanupIndex },
      now: () => new Date("2026-07-29T00:04:15.000Z"),
      leaseDurationMs: 30_000,
      retryDelayMs: 2_000
    })).resolves.toBe("retry");

    expect(cleanupIndex).not.toHaveBeenCalled();
    expect(repository.retryOrFail).toHaveBeenCalledWith(expect.objectContaining({
      code: "SEARCH_INDEX_WORK_UNSUPPORTED"
    }));
  });

  it("persists an asynchronous lifecycle task before polling and verifies it after success", async () => {
    const queued = {
      ...createWork({ state: "queued", taskUid: null }),
      workKind: "activate" as const
    };
    const submitted = {
      ...queued,
      state: "submitted" as const,
      taskUid: 55
    };
    const repository = fakeRepository();
    const activateIndex = vi.fn(async () => ({ taskUid: 55 }));
    const completeSubmittedTask = vi.fn(async () => undefined);
    const transport = fakeTransport({
      getTask: vi.fn(async () => ({
        taskUid: 55,
        status: "succeeded" as const,
        errorCode: null
      }))
    });

    await expect(processSearchIndexingWork({
      work: queued,
      repository,
      transport,
      resolveIndexUid: () => "content-index",
      loadDocuments: async () => [],
      lifecycle: { activateIndex, completeSubmittedTask },
      now: () => new Date("2026-07-29T00:04:30.000Z"),
      leaseDurationMs: 30_000,
      retryDelayMs: 2_000
    })).resolves.toBe("submitted");

    expect(repository.markSubmitted).toHaveBeenCalledWith(
      expect.objectContaining({ taskUid: 55 })
    );
    expect(repository.markSucceeded).not.toHaveBeenCalled();

    await expect(processSearchIndexingWork({
      work: submitted,
      repository,
      transport,
      resolveIndexUid: () => "content-index",
      loadDocuments: async () => [],
      lifecycle: { activateIndex, completeSubmittedTask },
      now: () => new Date("2026-07-29T00:04:31.000Z"),
      leaseDurationMs: 30_000,
      retryDelayMs: 2_000
    })).resolves.toBe("succeeded");

    expect(activateIndex).toHaveBeenCalledTimes(1);
    expect(completeSubmittedTask).toHaveBeenCalledWith(submitted);
    expect(repository.markSucceeded).toHaveBeenCalledOnce();
  });

  it("rejects a replay when a durable document pointer disappeared", async () => {
    const work = createWork({ state: "queued", taskUid: null });
    const repository = fakeRepository({
      retryOrFail: vi.fn(async () => "retry" as const)
    });

    const result = await processSearchIndexingWork({
      work,
      repository,
      transport: fakeTransport(),
      resolveIndexUid: () => "content-index",
      loadDocuments: async () => [],
      now: () => new Date("2026-07-29T00:05:00.000Z"),
      leaseDurationMs: 30_000,
      retryDelayMs: 2_000
    });

    expect(result).toBe("retry");
    expect(repository.retryOrFail).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "SEARCH_INDEX_BATCH_STALE"
      })
    );
  });
});

function createWork(
  input: Pick<SearchProjectionWork, "state" | "taskUid">
): SearchProjectionWork {
  return {
    id: "search-work-one",
    knowledgeBaseId: "kb-one",
    epoch: 1,
    generationId: "generation-one",
    maintenanceRequestId: null,
    indexKind: "content",
    workKind: "documents",
    batchOrdinal: 0,
    payloadChecksum: "a".repeat(64),
    documentCount: 1,
    compressedBytes: 100,
    state: input.state,
    taskUid: input.taskUid,
    taskCorrelation: "search-work-one",
    checkpoint: {},
    leaseOwner: "worker-one",
    leaseToken: "lease-one",
    attemptCount: 0,
    maxAttempts: 5,
    runAfter: "2026-07-29T00:00:00.000Z",
    safeErrorCode: null,
    safeErrorMessage: null
  };
}

function fakeRepository(
  overrides: Partial<SearchProjectionStateRepository> = {}
): SearchProjectionStateRepository {
  return {
    getState: vi.fn(),
    reservePendingEpoch: vi.fn(),
    createWork: vi.fn(),
    getEpochProgress: vi.fn(),
    claimWork: vi.fn(),
    markSubmitted: vi.fn(async () => true),
    markSucceeded: vi.fn(async () => true),
    continuePlanning: vi.fn(async () => true),
    retryOrFail: vi.fn(async () => "retry" as const),
    restartFailedEpoch: vi.fn(),
    rebaseFailedEpoch: vi.fn(),
    retryFailedCleanup: vi.fn(),
    beginActivation: vi.fn(),
    activateEpoch: vi.fn(),
    cancelForKnowledgeBase: vi.fn(),
    ...overrides
  };
}

function fakeTransport(
  overrides: Partial<SearchEngineTransport> = {}
): SearchEngineTransport {
  return {
    health: vi.fn(),
    getPressure: vi.fn(),
    createIndex: vi.fn(),
    getIndex: vi.fn(),
    getDocument: vi.fn(),
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    addDocuments: vi.fn(),
    deleteDocuments: vi.fn(),
    deleteIndex: vi.fn(),
    swapIndexes: vi.fn(),
    getTask: vi.fn(),
    search: vi.fn(),
    ...overrides
  };
}
