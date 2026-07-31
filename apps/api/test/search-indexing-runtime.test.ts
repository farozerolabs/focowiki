import { describe, expect, it, vi } from "vitest";
import type {
  SearchEngineTransport
} from "../src/application/ports/search-engine-transport.js";
import type {
  SearchProjectionDocumentRepository
} from "../src/application/ports/search-projection-document-repository.js";
import type {
  SearchProjectionStateRepository,
  SearchProjectionWork
} from "../src/application/ports/search-projection-state-repository.js";
import {
  processClaimedSearchWork,
  runSearchIndexingCycle
} from "../src/search/search-indexing-runtime.js";

describe("search indexing runtime", () => {
  it("reloads durable record pointers and submits incremental documents to the stable index", async () => {
    const states = fakeStates();
    const documents = fakeDocuments();
    const transport = fakeTransport({
      addDocuments: vi.fn(async () => ({ taskUid: 81 }))
    });
    const work = searchWork();

    await expect(processClaimedSearchWork({
      work,
      states,
      documents,
      transport,
      indexPrefix: "focowiki",
      settings: runtimeSettings(),
      leaseDurationMs: 30_000
    })).resolves.toBe("submitted");

    expect(documents.loadRecords).toHaveBeenCalledWith(expect.objectContaining({
      generationId: "generation-next",
      activeGenerationId: "generation-active",
      activeEpoch: 2,
      pendingEpoch: 3,
      recordKeys: ["content:record-one"]
    }));
    expect(transport.addDocuments).toHaveBeenCalledWith(expect.objectContaining({
      indexUid: expect.stringMatching(/^focowiki_content_[a-f0-9]{16}$/u)
    }));
  });

  it("submits first-epoch rebuild documents only to the staging index", async () => {
    const states = fakeStates({
      getState: vi.fn(async () => searchState({
        routeState: "postgres_compatibility",
        activeEpoch: 0,
        activeGenerationId: "generation-active",
        contentSchemaVersion: null,
        graphSchemaVersion: null,
        contentSettingsChecksum: null,
        graphSettingsChecksum: null
      }))
    });
    const transport = fakeTransport({
      addDocuments: vi.fn(async () => ({ taskUid: 82 }))
    });

    await expect(processClaimedSearchWork({
      work: searchWork(),
      states,
      documents: fakeDocuments(),
      transport,
      indexPrefix: "focowiki",
      settings: runtimeSettings(),
      leaseDurationMs: 30_000
    })).resolves.toBe("submitted");

    expect(transport.addDocuments).toHaveBeenCalledWith(expect.objectContaining({
      indexUid: expect.stringMatching(
        /^focowiki_content_[a-f0-9]{16}_staging_3$/u
      )
    }));
  });

  it("submits a rebased pending epoch only to the staging index", async () => {
    const states = fakeStates({
      getState: vi.fn(async () => searchState({
        activeEpoch: 2,
        pendingFullRebuild: true
      }))
    });
    const transport = fakeTransport({
      addDocuments: vi.fn(async () => ({ taskUid: 83 }))
    });

    await expect(processClaimedSearchWork({
      work: searchWork(),
      states,
      documents: fakeDocuments(),
      transport,
      indexPrefix: "focowiki",
      settings: runtimeSettings(),
      leaseDurationMs: 30_000
    })).resolves.toBe("submitted");

    expect(transport.addDocuments).toHaveBeenCalledWith(expect.objectContaining({
      indexUid: expect.stringMatching(
        /^focowiki_content_[a-f0-9]{16}_staging_3$/u
      )
    }));
  });

  it("plans one durable document page and persists its continuation cursor", async () => {
    const states = fakeStates({
      createWork: vi.fn(async (work) => work.length),
      continuePlanning: vi.fn(async () => true)
    });
    const documents = fakeDocuments({
      listRecords: vi.fn(async () => ({
        records: [
          {
            key: "content:record-one",
            document: { id: "segment-one", body: "body one" }
          },
          {
            key: "content:record-two",
            document: { id: "segment-two", body: "body two" }
          }
        ],
        nextCursor: "cursor-two"
      }))
    });
    const work = {
      ...searchWork(),
      workKind: "plan_documents" as const,
      documentCount: 0,
      checkpoint: {}
    };

    await expect(processClaimedSearchWork({
      work,
      states,
      documents,
      transport: fakeTransport(),
      indexPrefix: "focowiki",
      settings: {
        ...runtimeSettings(),
        maxDocumentCount: 2
      },
      leaseDurationMs: 30_000,
      now: () => new Date("2026-07-29T00:00:01.000Z")
    })).resolves.toBe("processing");

    expect(states.createWork).toHaveBeenCalledWith([
      expect.objectContaining({
        workKind: "documents",
        batchOrdinal: 0,
        documentCount: 2
      })
    ]);
    expect(states.continuePlanning).toHaveBeenCalledWith({
      work,
      checkpoint: {
        cursor: "cursor-two",
        batchOrdinal: 1
      },
      continuedAt: "2026-07-29T00:00:01.000Z"
    });
    expect(states.markSucceeded).not.toHaveBeenCalled();
  });

  it("completes durable planning after the final projection page", async () => {
    const states = fakeStates();
    const documents = fakeDocuments({
      listRecords: vi.fn(async () => ({
        records: [],
        nextCursor: null
      }))
    });
    const work = {
      ...searchWork(),
      workKind: "plan_documents" as const,
      documentCount: 0,
      checkpoint: {
        cursor: "cursor-two",
        batchOrdinal: 1
      }
    };

    await expect(processClaimedSearchWork({
      work,
      states,
      documents,
      transport: fakeTransport(),
      indexPrefix: "focowiki",
      settings: runtimeSettings(),
      leaseDurationMs: 30_000,
      now: () => new Date("2026-07-29T00:00:02.000Z")
    })).resolves.toBe("succeeded");

    expect(states.markSucceeded).toHaveBeenCalledWith({
      work,
      completedAt: "2026-07-29T00:00:02.000Z"
    });
    expect(states.continuePlanning).not.toHaveBeenCalled();
  });

  it("activates a maintenance epoch only after validation work succeeds", async () => {
    const states = fakeStates({
      activateEpoch: vi.fn(async () => true)
    });
    const work = {
      ...searchWork(),
      workKind: "activate" as const,
      maintenanceRequestId: "maintenance-one",
      documentCount: 0,
      checkpoint: {}
    };

    await expect(processClaimedSearchWork({
      work,
      states,
      documents: fakeDocuments(),
      transport: fakeTransport(),
      indexPrefix: "focowiki",
      settings: runtimeSettings(),
      leaseDurationMs: 30_000
    })).resolves.toBe("succeeded");

    expect(states.activateEpoch).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBaseId: "kb-one",
      generationId: "generation-next",
      epoch: 3,
      contentSchemaVersion: "content-v1",
      graphSchemaVersion: "graph-v1"
    }));
    expect(states.beginActivation).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBaseId: "kb-one",
      generationId: "generation-next",
      epoch: 3
    }));
  });

  it("finishes an activation replay after the epoch transaction already committed", async () => {
    const states = fakeStates({
      getState: vi.fn(async () => searchState({
        activeEpoch: 3,
        activeGenerationId: "generation-next",
        pendingEpoch: null,
        pendingGenerationId: null
      }))
    });
    const work = {
      ...searchWork(),
      workKind: "activate" as const,
      maintenanceRequestId: "maintenance-one",
      documentCount: 0,
      checkpoint: {}
    };

    await expect(processClaimedSearchWork({
      work,
      states,
      documents: fakeDocuments(),
      transport: fakeTransport(),
      indexPrefix: "focowiki",
      settings: runtimeSettings(),
      leaseDurationMs: 30_000
    })).resolves.toBe("succeeded");

    expect(states.beginActivation).not.toHaveBeenCalled();
    expect(states.activateEpoch).not.toHaveBeenCalled();
    expect(states.markSucceeded).toHaveBeenCalledWith(expect.objectContaining({
      work
    }));
  });

  it("deletes the old staging index after a physical replacement activates", async () => {
    const states = fakeStates({
      getState: vi.fn(async () => searchState({
        activeEpoch: 3,
        activeGenerationId: "generation-next",
        pendingEpoch: null,
        pendingGenerationId: null
      }))
    });
    const transport = fakeTransport({
      getIndex: vi.fn(async ({ indexUid }) => ({
        uid: indexUid,
        primaryKey: "id"
      })),
      deleteIndex: vi.fn(async () => ({ taskUid: 91 })),
      getTask: vi.fn(async () => ({
        taskUid: 91,
        status: "succeeded" as const,
        errorCode: null
      }))
    });

    await expect(processClaimedSearchWork({
      work: {
        ...searchWork(),
        workKind: "cleanup",
        documentCount: 0,
        checkpoint: {}
      },
      states,
      documents: fakeDocuments(),
      transport,
      indexPrefix: "focowiki",
      settings: runtimeSettings(),
      leaseDurationMs: 30_000
    })).resolves.toBe("succeeded");

    expect(transport.deleteIndex).toHaveBeenCalledWith(expect.stringMatching(
      /^focowiki_content_[a-f0-9]{16}_staging_3$/u
    ));
    expect(transport.deleteDocuments).not.toHaveBeenCalled();
  });

  it("deletes closed documents from the stable index after incremental activation", async () => {
    const states = fakeStates({
      getState: vi.fn(async () => searchState({
        activeEpoch: 3,
        activeGenerationId: "generation-next",
        pendingEpoch: null,
        pendingGenerationId: null
      }))
    });
    const transport = fakeTransport({
      deleteDocuments: vi.fn(async () => ({ taskUid: 92 })),
      getTask: vi.fn(async () => ({
        taskUid: 92,
        status: "succeeded" as const,
        errorCode: null
      }))
    });

    await expect(processClaimedSearchWork({
      work: {
        ...searchWork(),
        workKind: "cleanup",
        documentCount: 0,
        checkpoint: {}
      },
      states,
      documents: fakeDocuments(),
      transport,
      indexPrefix: "focowiki",
      settings: runtimeSettings(),
      leaseDurationMs: 30_000
    })).resolves.toBe("succeeded");

    expect(transport.deleteDocuments).toHaveBeenCalledWith(expect.objectContaining({
      indexUid: expect.stringMatching(/^focowiki_content_[a-f0-9]{16}$/u),
      filter: "knowledgeBaseId = \"kb-one\" AND visibleUntilEpoch <= 3"
    }));
    expect(transport.deleteIndex).not.toHaveBeenCalled();
  });

  it("deletes failed physical-replacement staging through durable cleanup work", async () => {
    const failedState = searchState({
      activeEpoch: 0,
      contentSchemaVersion: null,
      contentSettingsChecksum: null
    });
    const states = fakeStates({
      getState: vi.fn(async () => failedState),
      getEpochProgress: vi.fn(async () => ({
        total: 4,
        queued: 0,
        submitted: 0,
        retry: 0,
        succeeded: 2,
        failed: 1,
        canceled: 0,
        superseded: 0,
        activationReady: false
      }))
    });
    const transport = fakeTransport({
      getIndex: vi.fn(async ({ indexUid }) => ({
        uid: indexUid,
        primaryKey: "id"
      })),
      deleteIndex: vi.fn(async () => ({ taskUid: 93 })),
      getTask: vi.fn(async () => ({
        taskUid: 93,
        status: "succeeded" as const,
        errorCode: null
      }))
    });

    await expect(processClaimedSearchWork({
      work: {
        ...searchWork(),
        workKind: "cleanup",
        documentCount: 0,
        checkpoint: {}
      },
      states,
      documents: fakeDocuments(),
      transport,
      indexPrefix: "focowiki",
      settings: runtimeSettings(),
      leaseDurationMs: 30_000
    })).resolves.toBe("succeeded");

    expect(transport.deleteIndex).toHaveBeenCalledWith(expect.stringMatching(
      /^focowiki_content_[a-f0-9]{16}_staging_3$/u
    ));
  });

  it("leaves normal publication activation to the generation transaction", async () => {
    const states = fakeStates();
    const work = {
      ...searchWork(),
      workKind: "activate" as const,
      documentCount: 0,
      checkpoint: {}
    };

    await expect(processClaimedSearchWork({
      work,
      states,
      documents: fakeDocuments(),
      transport: fakeTransport(),
      indexPrefix: "focowiki",
      settings: runtimeSettings(),
      leaseDurationMs: 30_000
    })).resolves.toBe("succeeded");

    expect(states.activateEpoch).not.toHaveBeenCalled();
  });

  it("claims only the configured number of in-flight tasks", async () => {
    const states = fakeStates({
      claimWork: vi.fn(async () => [])
    });

    await expect(runSearchIndexingCycle({
      workerId: "worker-one",
      leaseTokenPrefix: "lease-one",
      states,
      documents: fakeDocuments(),
      transport: fakeTransport(),
      indexPrefix: "focowiki",
      settings: {
        ...runtimeSettings(),
        maxInFlightTasks: 6
      },
      leaseDurationMs: 30_000,
      now: () => new Date("2026-07-29T00:00:00.000Z")
    })).resolves.toMatchObject({
      claimed: 0,
      submitted: 0,
      processing: 0,
      succeeded: 0,
      retried: 0,
      failed: 0,
      lost: 0,
      submissionPaused: false,
      submissionThrottled: false,
      pressureReasons: []
    });

    expect(states.claimWork).toHaveBeenCalledWith(expect.objectContaining({
      limit: 6,
      maxInFlightTasks: 6,
      allowIndexWrites: true,
      allowRoutineEngineTasks: true
    }));
  });

  it("pauses new submissions under engine pressure while retaining submitted polling", async () => {
    const states = fakeStates({
      claimWork: vi.fn(async () => [])
    });
    const transport = fakeTransport({
      getPressure: vi.fn(async () => ({
        queueLatencyMs: 31_000,
        residentMemoryBytes: 3_000,
        databaseSizeBytes: 4_000,
        taskQueueSizeBytes: 5_000
      }))
    });

    await expect(runSearchIndexingCycle({
      workerId: "worker-one",
      leaseTokenPrefix: "lease-one",
      states,
      documents: fakeDocuments(),
      transport,
      indexPrefix: "focowiki",
      settings: {
        ...runtimeSettings(),
        maxInFlightTasks: 6,
        engineQueueLatencyLimitMs: 30_000,
        engineResidentMemoryLimitBytes: 4_000,
        engineDatabaseSizeLimitBytes: 5_000,
        engineTaskQueueSizeLimitBytes: 6_000
      },
      leaseDurationMs: 30_000
    })).resolves.toMatchObject({
      claimed: 0,
      submitted: 0,
      processing: 0,
      succeeded: 0,
      retried: 0,
      failed: 0,
      lost: 0,
      submissionPaused: true,
      pressureReasons: ["queue_latency"]
    });

    expect(states.claimWork).toHaveBeenCalledWith(expect.objectContaining({
      allowIndexWrites: false,
      allowRoutineEngineTasks: false
    }));
  });

  it("throttles document writes while resident memory keeps lifecycle work available", async () => {
    const states = fakeStates({
      claimWork: vi.fn(async () => [])
    });
    const transport = fakeTransport({
      getPressure: vi.fn(async () => ({
        queueLatencyMs: 0,
        residentMemoryBytes: 5_000,
        databaseSizeBytes: 4_000,
        taskQueueSizeBytes: 5_000
      }))
    });

    const result = await runSearchIndexingCycle({
      workerId: "worker-one",
      leaseTokenPrefix: "lease-one",
      states,
      documents: fakeDocuments(),
      transport,
      indexPrefix: "focowiki",
      settings: {
        ...runtimeSettings(),
        maxInFlightTasks: 6,
        engineQueueLatencyLimitMs: 30_000,
        engineResidentMemoryLimitBytes: 4_000,
        engineDatabaseSizeLimitBytes: 5_000,
        engineTaskQueueSizeLimitBytes: 6_000
      },
      leaseDurationMs: 30_000
    });

    expect(result).toMatchObject({
      submissionPaused: false,
      submissionThrottled: true,
      pressureReasons: ["resident_memory"],
      pressure: {
        residentMemoryBytes: 5_000
      },
      pressureLimits: {
        residentMemoryBytes: 4_000
      }
    });
    expect(states.claimWork).toHaveBeenCalledWith(expect.objectContaining({
      maxInFlightTasks: 1,
      allowIndexWrites: true,
      allowRoutineEngineTasks: true
    }));
  });

  it("defers new engine mutations while its task queue is overloaded", async () => {
    const states = fakeStates({
      claimWork: vi.fn(async () => [])
    });
    const transport = fakeTransport({
      getPressure: vi.fn(async () => ({
        queueLatencyMs: 31_000,
        residentMemoryBytes: 3_000,
        databaseSizeBytes: 4_000,
        taskQueueSizeBytes: 7_000
      }))
    });

    await runSearchIndexingCycle({
      workerId: "worker-one",
      leaseTokenPrefix: "lease-one",
      states,
      documents: fakeDocuments(),
      transport,
      indexPrefix: "focowiki",
      settings: {
        ...runtimeSettings(),
        maxInFlightTasks: 6,
        engineQueueLatencyLimitMs: 30_000,
        engineResidentMemoryLimitBytes: 4_000,
        engineDatabaseSizeLimitBytes: 5_000,
        engineTaskQueueSizeLimitBytes: 6_000
      },
      leaseDurationMs: 30_000
    });

    expect(states.claimWork).toHaveBeenCalledWith(expect.objectContaining({
      allowIndexWrites: false,
      allowRoutineEngineTasks: false
    }));
  });

  it("pauses new submissions when pressure cannot be observed", async () => {
    const states = fakeStates({
      claimWork: vi.fn(async () => [])
    });
    const transport = fakeTransport({
      getPressure: vi.fn(async () => {
        throw new Error("raw endpoint detail");
      })
    });

    const result = await runSearchIndexingCycle({
      workerId: "worker-one",
      leaseTokenPrefix: "lease-one",
      states,
      documents: fakeDocuments(),
      transport,
      indexPrefix: "focowiki",
      settings: {
        ...runtimeSettings(),
        maxInFlightTasks: 6,
        engineQueueLatencyLimitMs: 30_000,
        engineResidentMemoryLimitBytes: 4_000,
        engineDatabaseSizeLimitBytes: 5_000,
        engineTaskQueueSizeLimitBytes: 6_000
      },
      leaseDurationMs: 30_000
    });

    expect(result.submissionPaused).toBe(true);
    expect(result.pressureReasons).toEqual(["pressure_unavailable"]);
    expect(states.claimWork).toHaveBeenCalledWith(expect.objectContaining({
      allowIndexWrites: false,
      allowRoutineEngineTasks: false
    }));
  });
});

function searchWork(): SearchProjectionWork {
  return {
    id: "search-work-one",
    knowledgeBaseId: "kb-one",
    epoch: 3,
    generationId: "generation-next",
    maintenanceRequestId: null,
    indexKind: "content",
    workKind: "documents",
    batchOrdinal: 0,
    payloadChecksum: "a".repeat(64),
    documentCount: 1,
    compressedBytes: 100,
    state: "queued",
    taskUid: null,
    taskCorrelation: "search-work-one",
    checkpoint: { recordKeys: ["content:record-one"] },
    leaseOwner: "worker-one",
    leaseToken: "lease-one",
    attemptCount: 0,
    maxAttempts: 5,
    runAfter: "2026-07-29T00:00:00.000Z",
    safeErrorCode: null,
    safeErrorMessage: null
  };
}

function fakeStates(
  overrides: Partial<SearchProjectionStateRepository> = {}
): SearchProjectionStateRepository {
  return {
    getState: vi.fn(async () => searchState()),
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
    beginActivation: vi.fn(async () => true),
    activateEpoch: vi.fn(),
    cancelForKnowledgeBase: vi.fn(),
    ...overrides
  };
}

function searchState(
  overrides: Partial<Awaited<
    ReturnType<SearchProjectionStateRepository["getState"]>
  > & object> = {}
) {
  return {
    knowledgeBaseId: "kb-one",
    routeState: "meilisearch" as const,
    activeEpoch: 2,
    pendingEpoch: 3,
    pendingFullRebuild: false,
    activeGenerationId: "generation-active",
    pendingGenerationId: "generation-next",
    contentSchemaVersion: "content-v1",
    graphSchemaVersion: "graph-v1",
    contentSettingsChecksum: "a".repeat(64),
    graphSettingsChecksum: "b".repeat(64),
    pendingContentSchemaVersion: "content-v1",
    pendingGraphSchemaVersion: "graph-v1",
    pendingContentSettingsChecksum: "a".repeat(64),
    pendingGraphSettingsChecksum: "b".repeat(64),
    pendingActivationState: "indexing" as const,
    maintenanceRequired: true,
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...overrides
  };
}

function fakeDocuments(
  overrides: Partial<SearchProjectionDocumentRepository> = {}
): SearchProjectionDocumentRepository {
  return {
    listRecords: vi.fn(),
    loadRecords: vi.fn(async () => [{
      key: "content:record-one",
      document: { id: "segment-one", body: "body" }
    }]),
    ...overrides
  };
}

function fakeTransport(
  overrides: Partial<SearchEngineTransport> = {}
): SearchEngineTransport {
  return {
    health: vi.fn(async () => ({ available: true })),
    getPressure: vi.fn(async () => ({
      queueLatencyMs: 0,
      residentMemoryBytes: 0,
      databaseSizeBytes: 0,
      taskQueueSizeBytes: 0
    })),
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

function runtimeSettings() {
  return {
    engineSearchCutoffMs: 1_000,
    taskPollIntervalMs: 10,
    taskTimeoutMs: 1_000,
    retryDelayMs: 100,
    maxDocumentCount: 500,
    maxCompressedBytes: 8_388_608,
    engineQueueLatencyLimitMs: 30_000,
    engineResidentMemoryLimitBytes: 3_221_225_472,
    engineDatabaseSizeLimitBytes: 107_374_182_400,
    engineTaskQueueSizeLimitBytes: 536_870_912
  };
}
