import { describe, expect, it, vi } from "vitest";
import type {
  SearchEngineSettings,
  SearchEngineTransport
} from "../src/application/ports/search-engine-transport.js";
import {
  createStorageVnextSearchCandidateLifecycle,
  createStorageVnextSearchSettingsChecksum
} from "../src/storage-vnext/search/candidate-lifecycle.js";
import type {
  StorageVnextSearchProjectionRecord,
  StorageVnextSearchProjectionRepository
} from "../src/storage-vnext/search/projection-repository.js";

const settings: SearchEngineSettings = {
  searchableAttributes: ["title", "searchText", "rankingTerms"],
  filterableAttributes: ["knowledgeBaseId", "documentKind"],
  displayedAttributes: ["id", "logicalPath", "title"],
  sortableAttributes: [],
  rankingRules: ["words", "typo", "proximity", "attribute", "sort", "exactness"],
  distinctAttribute: null,
  pagination: { maxTotalHits: 2_000 },
  searchCutoffMs: 1_000,
  localizedAttributes: [],
  typoTolerance: { disableOnAttributes: ["logicalPath"] }
};

describe("storage vNext search candidate lifecycle", () => {
  it("finishes and verifies settings before accepting unified documents", async () => {
    const events: string[] = [];
    const repository = createRepository();
    let indexExists = false;
    let settingsApplied = false;
    const transport = createTransport({
      getIndex: vi.fn(async () => {
        events.push("get-index");
        return indexExists ? { uid: repository.record.providerIndexUid, primaryKey: "id" } : null;
      }),
      createIndex: vi.fn(async () => {
        events.push("create-index");
        indexExists = true;
        return { taskUid: 11 };
      }),
      getSettings: vi.fn(async () => {
        events.push("get-settings");
        return settingsApplied ? settings : { ...settings, searchCutoffMs: 900 };
      }),
      updateSettings: vi.fn(async () => {
        events.push("update-settings");
        settingsApplied = true;
        return { taskUid: 12 };
      }),
      getTask: vi.fn(async (taskUid) => {
        events.push(`task:${taskUid}`);
        return { taskUid, status: "succeeded" as const, errorCode: null };
      }),
      addDocuments: vi.fn(async () => {
        events.push("add-documents");
        return { taskUid: 13 };
      }),
      findTaskByCorrelation: vi.fn(async () => null)
    });
    const lifecycle = createLifecycle(repository.port, transport);

    await lifecycle.prepareCandidate({
      knowledgeBaseId: "kb-a",
      candidatePublicId: "candidate-a",
      schemaChecksum: "a".repeat(64),
      settingsChecksum: createStorageVnextSearchSettingsChecksum(settings)
    });
    await lifecycle.writeDocumentBatch(batch());

    expect(events.indexOf("create-index")).toBeLessThan(events.indexOf("update-settings"));
    expect(events.indexOf("update-settings")).toBeLessThan(events.indexOf("add-documents"));
    expect(transport.swapIndexes).not.toHaveBeenCalled();
    expect(transport.addDocuments).toHaveBeenCalledWith(expect.objectContaining({
      indexUid: repository.record.providerIndexUid,
      documents: [
        expect.objectContaining({ documentKind: "content" }),
        expect.objectContaining({ documentKind: "graph_seed" })
      ]
    }));
    expect(repository.record.state).toBe("indexing");
    expect(repository.record.documentCount).toBe(2);
  });

  it("resumes a durably recorded document task without submitting it twice", async () => {
    const repository = createRepository({ state: "indexing" });
    repository.beginOutcome = { outcome: "resume", providerTaskUid: 77 };
    const addDocuments = vi.fn(async () => ({ taskUid: 78 }));
    const transport = createTransport({
      addDocuments,
      getTask: vi.fn(async () => ({
        taskUid: 77,
        status: "succeeded" as const,
        errorCode: null
      }))
    });

    await createLifecycle(repository.port, transport).writeDocumentBatch(batch());

    expect(addDocuments).not.toHaveBeenCalled();
    expect(repository.completeDocumentBatch).toHaveBeenCalledOnce();
  });

  it("recovers the accepted task by durable correlation after a crash window", async () => {
    const repository = createRepository({ state: "indexing" });
    const addDocuments = vi.fn(async () => ({ taskUid: 91 }));
    const findTaskByCorrelation = vi.fn(async () => ({
      taskUid: 90,
      status: "processing" as const,
      errorCode: null
    }));
    const transport = createTransport({
      addDocuments,
      findTaskByCorrelation,
      getTask: vi.fn(async () => ({
        taskUid: 90,
        status: "succeeded" as const,
        errorCode: null
      }))
    });

    await createLifecycle(repository.port, transport).writeDocumentBatch(batch());

    expect(findTaskByCorrelation).toHaveBeenCalledOnce();
    expect(addDocuments).not.toHaveBeenCalled();
    expect(repository.recordProviderTask).toHaveBeenCalledWith(
      expect.objectContaining({ providerTaskUid: 90 })
    );
  });

  it("does not recover document tasks from a deleted candidate index incarnation", async () => {
    let record: StorageVnextSearchProjectionRecord | null = null;
    const proposedIndexUids: string[] = [];
    const existingIndexes = new Set<string>();
    const oldTasks = new Map<string, { taskUid: number; correlation: string }>();
    let nextTaskUid = 20;
    const repository = createIncarnationRepository({
      get record() { return record; },
      set record(value) { record = value; },
      proposedIndexUids
    });
    const addDocuments = vi.fn(async (input: {
      indexUid: string;
      correlation: string;
    }) => {
      const taskUid = nextTaskUid++;
      oldTasks.set(input.indexUid, { taskUid, correlation: input.correlation });
      return { taskUid };
    });
    const transport = createTransport({
      getIndex: vi.fn(async ({ indexUid }) => existingIndexes.has(indexUid)
        ? { uid: indexUid, primaryKey: "id" }
        : null),
      createIndex: vi.fn(async ({ indexUid }) => {
        existingIndexes.add(indexUid);
        return { taskUid: nextTaskUid++ };
      }),
      addDocuments,
      findTaskByCorrelation: vi.fn(async ({ indexUid, correlation }) => {
        const historical = oldTasks.get(indexUid);
        if (!historical || historical.correlation !== correlation) return null;
        return {
          taskUid: historical.taskUid,
          status: "succeeded" as const,
          errorCode: null
        };
      })
    });
    const lifecycle = createLifecycle(repository, transport);
    const prepare = {
      knowledgeBaseId: "kb-a",
      candidatePublicId: "candidate-a",
      schemaChecksum: "a".repeat(64),
      settingsChecksum: createStorageVnextSearchSettingsChecksum(settings)
    };

    await lifecycle.prepareCandidate(prepare);
    await lifecycle.writeDocumentBatch(batch());
    const firstIndexUid = record!.providerIndexUid;
    existingIndexes.delete(firstIndexUid);
    record = null;

    await lifecycle.prepareCandidate(prepare);
    await lifecycle.writeDocumentBatch(batch());

    expect(proposedIndexUids).toHaveLength(2);
    expect(proposedIndexUids[1]).not.toBe(proposedIndexUids[0]);
    expect(addDocuments).toHaveBeenCalledTimes(2);
  });

  it("stops polling at the configured bound and leaves the task resumable", async () => {
    const repository = createRepository({ state: "indexing" });
    repository.beginOutcome = { outcome: "resume", providerTaskUid: 101 };
    const sleep = vi.fn(async () => undefined);
    const transport = createTransport({
      getTask: vi.fn(async () => ({
        taskUid: 101,
        status: "processing" as const,
        errorCode: null
      }))
    });
    const lifecycle = createLifecycle(repository.port, transport, {
      maxPollAttempts: 2,
      sleep
    });

    await expect(lifecycle.writeDocumentBatch(batch()))
      .rejects.toMatchObject({ code: "provider_task_timeout" });
    expect(transport.getTask).toHaveBeenCalledTimes(2);
    expect(repository.completeDocumentBatch).not.toHaveBeenCalled();
  });
});

function createLifecycle(
  repository: StorageVnextSearchProjectionRepository,
  transport: SearchEngineTransport,
  overrides: {
    maxPollAttempts?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {}
) {
  return createStorageVnextSearchCandidateLifecycle({
    repository,
    transport,
    settings,
    indexUidPrefix: "owned_vnext",
    maxPollAttempts: overrides.maxPollAttempts ?? 3,
    pollIntervalMs: 1,
    sleep: overrides.sleep ?? (async () => undefined)
  });
}

function batch() {
  return {
    candidatePublicId: "candidate-a",
    operationPublicId: "operation-a",
    batchOrdinal: 0,
    payloadChecksum: "d".repeat(64),
    compressedBytes: 100,
    documents: [{
      id: "content-a",
      schemaVersion: "storage-vnext-content-v1" as const,
      documentKind: "content" as const,
      contentKind: "file" as const,
      knowledgeBaseId: "kb-a",
      sourceFilePublicId: "file-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "a.md",
      fileKind: "markdown",
      title: "A",
      segmentOrdinal: null,
      headingAncestors: [],
      searchText: "alpha"
    }, {
      id: "graph-seed-a",
      schemaVersion: "storage-vnext-graph-seed-v1" as const,
      documentKind: "graph_seed" as const,
      knowledgeBaseId: "kb-a",
      sourceFilePublicId: "file-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "a.md",
      title: "A",
      searchText: "alpha related",
      rankingTerms: ["alpha", "related"]
    }]
  };
}

function createRepository(overrides: Partial<StorageVnextSearchProjectionRecord> = {}) {
  const record: StorageVnextSearchProjectionRecord = {
    publicId: "candidate-a",
    knowledgeBaseId: "kb-a",
    providerIndexUid: "owned_vnext_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbb",
    schemaChecksum: "a".repeat(64),
    settingsChecksum: createStorageVnextSearchSettingsChecksum(settings),
    documentChecksum: null,
    state: "preparing",
    documentCount: 0,
    nextBatchOrdinal: 0,
    lastBatchOrdinal: null,
    lastBatchChecksum: null,
    correlationPublicId: null,
    providerTaskUid: null,
    revision: 0,
    ...overrides
  };
  const recordProviderTask = vi.fn(async (input: {
    correlationPublicId: string;
    providerTaskUid: number;
  }) => {
    record.correlationPublicId = input.correlationPublicId;
    record.providerTaskUid = input.providerTaskUid;
  });
  const completeDocumentBatch = vi.fn(async (input: { documentCount: number }) => {
    record.documentCount += input.documentCount;
    record.nextBatchOrdinal += 1;
    record.correlationPublicId = null;
    record.providerTaskUid = null;
  });
  const repository = {
    record,
    beginOutcome: { outcome: "start", providerTaskUid: null } as {
      outcome: "resume" | "start";
      providerTaskUid: number | null;
    },
    recordProviderTask,
    completeDocumentBatch,
    port: {} as StorageVnextSearchProjectionRepository
  };
  repository.port = {
    reserveCandidate: vi.fn(async () => ({
      outcome: "created" as const,
      projection: record
    })),
    getCandidate: vi.fn(async () => record),
    beginProviderTask: vi.fn(async ({ correlationPublicId }) => {
      record.correlationPublicId = correlationPublicId;
      return { outcome: "start" as const, providerTaskUid: null };
    }),
    recordProviderTask,
    completeProviderTask: vi.fn(async () => {
      record.correlationPublicId = null;
      record.providerTaskUid = null;
    }),
    markCandidateIndexing: vi.fn(async () => {
      record.state = "indexing";
    }),
    beginDocumentBatch: vi.fn(async ({ correlationPublicId }) => {
      record.correlationPublicId = correlationPublicId;
      return repository.beginOutcome;
    }),
    completeDocumentBatch,
    beginCandidateValidation: vi.fn(),
    completeCandidateValidation: vi.fn(),
    failCandidateValidation: vi.fn()
  };
  return repository;
}

function createTransport(
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
    createIndex: vi.fn(async () => ({ taskUid: 1 })),
    getIndex: vi.fn(async ({ indexUid }) => ({ uid: indexUid, primaryKey: "id" })),
    getDocument: vi.fn(async () => null),
    getSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(async () => ({ taskUid: 2 })),
    addDocuments: vi.fn(async () => ({ taskUid: 3 })),
    deleteDocuments: vi.fn(async () => ({ taskUid: 4 })),
    deleteIndex: vi.fn(async () => ({ taskUid: 5 })),
    swapIndexes: vi.fn(async () => ({ taskUid: 6 })),
    findTaskByCorrelation: vi.fn(async () => null),
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

function createIncarnationRepository(state: {
  record: StorageVnextSearchProjectionRecord | null;
  proposedIndexUids: string[];
}): StorageVnextSearchProjectionRepository {
  return {
    reserveCandidate: vi.fn(async (input) => {
      state.proposedIndexUids.push(input.providerIndexUid);
      if (state.record) return { outcome: "existing" as const, projection: state.record };
      state.record = {
        publicId: input.publicId,
        knowledgeBaseId: input.knowledgeBaseId,
        providerIndexUid: input.providerIndexUid,
        schemaChecksum: input.schemaChecksum,
        settingsChecksum: input.settingsChecksum,
        documentChecksum: null,
        state: "preparing",
        documentCount: 0,
        nextBatchOrdinal: 0,
        lastBatchOrdinal: null,
        lastBatchChecksum: null,
        correlationPublicId: null,
        providerTaskUid: null,
        revision: 0
      };
      return { outcome: "created" as const, projection: state.record };
    }),
    getCandidate: vi.fn(async () => state.record),
    beginProviderTask: vi.fn(async ({ correlationPublicId }) => {
      state.record!.correlationPublicId = correlationPublicId;
      return { outcome: "start" as const, providerTaskUid: null };
    }),
    recordProviderTask: vi.fn(async ({ providerTaskUid }) => {
      state.record!.providerTaskUid = providerTaskUid;
    }),
    completeProviderTask: vi.fn(async () => {
      state.record!.correlationPublicId = null;
      state.record!.providerTaskUid = null;
    }),
    markCandidateIndexing: vi.fn(async () => {
      state.record!.state = "indexing";
    }),
    beginDocumentBatch: vi.fn(async ({ correlationPublicId }) => {
      state.record!.correlationPublicId = correlationPublicId;
      return { outcome: "start" as const, providerTaskUid: null };
    }),
    completeDocumentBatch: vi.fn(async ({ documentCount }) => {
      state.record!.documentCount += documentCount;
      state.record!.nextBatchOrdinal += 1;
      state.record!.correlationPublicId = null;
      state.record!.providerTaskUid = null;
    }),
    beginCandidateValidation: vi.fn(),
    completeCandidateValidation: vi.fn(),
    failCandidateValidation: vi.fn()
  };
}
