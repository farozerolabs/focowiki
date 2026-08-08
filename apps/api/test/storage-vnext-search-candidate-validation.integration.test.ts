import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { SearchProviderIndexDefinition } from
  "../src/application/ports/search-provider-runtime.js";
import {
  createMeilisearchTransport
} from "../src/infrastructure/meilisearch/meilisearch-transport.js";
import {
  createMeilisearchProviderRuntime,
  toMeilisearchSettings
} from "../src/infrastructure/meilisearch/meilisearch-provider-runtime.js";
import {
  validateStorageVnextSearchCandidate
} from "../src/storage-vnext/search/candidate-validation.js";
import {
  createStorageVnextSearchSettingsChecksum
} from "../src/storage-vnext/search/candidate-identity.js";
import {
  createStorageVnextContentDocument,
  createStorageVnextGraphSeedDocument
} from "../src/storage-vnext/search/documents.js";
import {
  createStorageVnextSearchDocumentSetChecksum
} from "../src/storage-vnext/search/document-set-checksum.js";
import {
  createStorageVnextActiveSearch
} from "../src/storage-vnext/search/active-search.js";
import type {
  StorageVnextSearchDocument,
  StorageVnextSearchValidationCase
} from "../src/storage-vnext/search/ports.js";
import type {
  StorageVnextSearchProjectionRecord,
  StorageVnextSearchProjectionRepository
} from "../src/storage-vnext/search/projection-repository.js";

const endpoint = process.env.FOCOWIKI_TEST_MEILISEARCH_URL;
const apiKey = process.env.FOCOWIKI_TEST_MEILISEARCH_API_KEY;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(
  endpoint && apiKey && runOwner && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedMeilisearch = hasOwnedTarget ? describe : describe.skip;

const settings: SearchProviderIndexDefinition = {
  primaryKey: "id",
  searchableAttributes: [
    "title", "logicalPath", "headingAncestors", "searchText", "rankingTerms"
  ],
  filterableAttributes: [
    "knowledgeBaseId", "documentKind", "schemaVersion", "sourceFilePublicId"
  ],
  displayedAttributes: [
    "id", "schemaVersion", "documentKind", "contentKind", "knowledgeBaseId",
    "sourceFilePublicId", "sourceRevisionPublicId", "logicalPath", "fileKind",
    "title", "segmentOrdinal", "headingAncestors", "searchText", "rankingTerms"
  ],
  rankingRules: ["words", "typo", "proximity", "attribute", "sort", "exactness"],
  distinctAttribute: "sourceFilePublicId",
  maximumTotalHits: 2_000,
  searchCutoffMs: 1_000,
  typoDisabledAttributes: ["logicalPath"]
};
const meilisearchSettings = toMeilisearchSettings(settings);

describeOwnedMeilisearch("real storage vNext candidate validation", () => {
  const indexUid = [
    "svnext_validation",
    (runOwner ?? "invalid").replaceAll("-", "_"),
    randomUUID().replaceAll("-", "").slice(0, 12)
  ].join("_");
  const transport = createMeilisearchTransport({
    endpoint: endpoint ?? "http://127.0.0.1:7700",
    apiKey: apiKey ?? "unused-test-key",
    timeoutMs: 5_000,
    maxAttempts: 2,
    retryDelayMs: 25
  });
  const provider = createMeilisearchProviderRuntime(transport);
  let indexCreated = false;

  afterAll(async () => {
    if (!indexCreated) return;
    const index = await transport.getIndex({ indexUid }).catch(() => null);
    if (!index) return;
    const deletion = await transport.deleteIndex(indexUid);
    await waitForTask(deletion.taskUid);
  }, 30_000);

  it("passes the complete exact, multilingual, graph, ranking, and hydration matrix", async () => {
    const documents = candidateDocuments();
    const creation = await transport.createIndex({ indexUid, primaryKey: "id" });
    indexCreated = true;
    await waitForTask(creation.taskUid);
    const settingTask = await transport.updateSettings({
      indexUid,
      settings: meilisearchSettings
    });
    await waitForTask(settingTask.taskUid);
    const addition = await transport.addDocuments({
      indexUid,
      primaryKey: "id",
      documents,
      correlation: `validation-${indexUid}`
    });
    await waitForTask(addition.taskUid);

    const settingsChecksum = createStorageVnextSearchSettingsChecksum(settings);
    const documentChecksum = createStorageVnextSearchDocumentSetChecksum(documents);
    const record: StorageVnextSearchProjectionRecord = {
      publicId: "candidate-real",
      knowledgeBaseId: "kb-real",
      providerKind: "meilisearch",
      providerIndexUid: indexUid,
      schemaChecksum: "a".repeat(64),
      settingsChecksum,
      documentChecksum: null,
      state: "indexing",
      documentCount: documents.length,
      nextBatchOrdinal: 1,
      lastBatchOrdinal: 0,
      lastBatchChecksum: "b".repeat(64),
      correlationPublicId: null,
      providerOperationRef: null,
      revision: 1
    };
    const repository = validationRepository(record);
    const hydration = {
      hydrateCurrentSources: vi.fn(async (input: {
        sourceFilePublicIds: readonly string[];
      }) => currentSources().filter((source) =>
        input.sourceFilePublicIds.includes(source.sourceFilePublicId)
      ))
    };

    await validateStorageVnextSearchCandidate({
      repository,
      provider,
      hydration,
      settings,
      documentPageSize: 2,
      input: {
        candidatePublicId: record.publicId,
        expectedDocumentCount: documents.length,
        documentChecksum,
        schemaChecksum: record.schemaChecksum,
        settingsChecksum,
        queryCases: queryCases(),
        maxP95ProcessingTimeMs: 1_000
      }
    });

    expect(record.state).toBe("ready");
    expect(hydration.hydrateCurrentSources).toHaveBeenCalled();

    const activeSearch = createStorageVnextActiveSearch({
      projections: {
        getActiveProjection: vi.fn(async () => ({
          publicId: record.publicId,
          knowledgeBaseId: record.knowledgeBaseId,
          providerKind: "meilisearch" as const,
          providerIndexUid: indexUid,
          schemaChecksum: record.schemaChecksum,
          settingsChecksum,
          documentChecksum,
          documentCount: documents.length
        }))
      },
      provider,
      hydration,
      maxPageSize: 100,
      overfetchFactor: 2,
      cropLength: 40,
      requestTimeoutMs: 5_000
    });
    const activeResult = await activeSearch.search({
      knowledgeBaseId: "kb-real",
      query: "employment",
      kinds: ["file", "graph"],
      limit: 10,
      cursor: null
    });
    expect(activeResult.items).toContainEqual(expect.objectContaining({
      sourceFilePublicId: "file-alpha",
      logicalPath: "pages/guides/alpha.md"
    }));

    const indexes = await transport.listIndexes?.({ offset: 0, limit: 100 });
    expect(indexes?.indexes.map((item) => item.uid)).toContain(indexUid);
    await expect(transport.getDatabaseStats?.()).resolves.toMatchObject({
      databaseSizeBytes: expect.any(Number),
      usedDatabaseSizeBytes: expect.any(Number)
    });
    const compaction = await transport.compactIndex?.(indexUid);
    expect(compaction).toBeDefined();
    await waitForTask(compaction!.taskUid);
    const finished = await transport.listFinishedTasks?.({
      statuses: ["succeeded", "failed", "canceled"],
      beforeFinishedAt: "2099-08-01T00:00:00.000Z",
      from: null,
      limit: 100
    });
    expect(finished?.tasks.map((task) => task.taskUid)).toContain(compaction!.taskUid);
    const deletion = await transport.deleteFinishedTasks?.({
      taskUids: [compaction!.taskUid]
    });
    expect(deletion).toBeDefined();
    await waitForTask(deletion!.taskUid);
  }, 60_000);

  it("maps real authentication and unavailable-service failures without leaking details", async () => {
    const wrongCredential = createMeilisearchTransport({
      endpoint: endpoint ?? "http://127.0.0.1:7700",
      apiKey: "run-owned-invalid-key",
      timeoutMs: 1_000,
      maxAttempts: 1,
      retryDelayMs: 1
    });
    const unavailable = createMeilisearchTransport({
      endpoint: "http://127.0.0.1:1",
      apiKey: "run-owned-unavailable-key",
      timeoutMs: 200,
      maxAttempts: 1,
      retryDelayMs: 1
    });

    const authenticationError = await wrongCredential.listIndexes?.({
      offset: 0,
      limit: 1
    }).then(() => null, (error: unknown) => error);
    expect(authenticationError).toMatchObject({
      name: "MeilisearchClientError",
      code: "SEARCH_ENGINE_AUTHENTICATION_FAILED",
      retryable: false
    });
    expect(String(authenticationError)).not.toMatch(/run-owned-invalid-key|127\.0\.0\.1/iu);

    const unavailableError = await unavailable.listIndexes?.({
      offset: 0,
      limit: 1
    }).then(() => null, (error: unknown) => error);
    expect(unavailableError).toMatchObject({
      name: "MeilisearchClientError",
      code: "SEARCH_ENGINE_UNAVAILABLE",
      retryable: true
    });
    expect(String(unavailableError)).not.toMatch(/run-owned-unavailable-key|127\.0\.0\.1/iu);
  }, 10_000);

  async function waitForTask(taskUid: number) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const task = await transport.getTask(taskUid);
      if (task.status === "succeeded") return;
      if (task.status === "failed" || task.status === "canceled") {
        throw new Error(`Meilisearch task ${taskUid} failed`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Meilisearch task ${taskUid} timed out`);
  }
});

function candidateDocuments(): StorageVnextSearchDocument[] {
  return [
    createStorageVnextContentDocument({
      knowledgeBaseId: "kb-real",
      sourceFilePublicId: "file-alpha",
      sourceRevisionPublicId: "revision-alpha",
      logicalPath: "pages/guides/alpha.md",
      fileKind: "page",
      title: "Employment Contract Master Guide",
      contentKind: "file",
      segmentOrdinal: null,
      headingAncestors: [],
      searchText: "{\"topic\":\"contract\"}"
    }),
    createStorageVnextContentDocument({
      knowledgeBaseId: "kb-real",
      sourceFilePublicId: "file-alpha",
      sourceRevisionPublicId: "revision-alpha",
      logicalPath: "pages/guides/alpha.md",
      fileKind: "page",
      title: "Employment Contract Master Guide",
      contentKind: "segment",
      segmentOrdinal: 0,
      headingAncestors: ["Terms"],
      searchText: "employment contract termination notice 劳动合同 合同"
    }),
    createStorageVnextGraphSeedDocument({
      knowledgeBaseId: "kb-real",
      sourceFilePublicId: "file-alpha",
      sourceRevisionPublicId: "revision-alpha",
      logicalPath: "pages/guides/alpha.md",
      title: "Employment dependency",
      searchText: "Employment dependency guide",
      rankingTerms: ["guide"]
    }),
    createStorageVnextContentDocument({
      knowledgeBaseId: "kb-real",
      sourceFilePublicId: "file-beta",
      sourceRevisionPublicId: "revision-beta",
      logicalPath: "pages/guides/beta.md",
      fileKind: "page",
      title: "Contract Employment Overview",
      contentKind: "file",
      segmentOrdinal: null,
      headingAncestors: [],
      searchText: "{\"topic\":\"overview\"}"
    }),
    createStorageVnextContentDocument({
      knowledgeBaseId: "kb-real",
      sourceFilePublicId: "file-beta",
      sourceRevisionPublicId: "revision-beta",
      logicalPath: "pages/guides/beta.md",
      fileKind: "page",
      title: "Contract Employment Overview",
      contentKind: "segment",
      segmentOrdinal: 0,
      headingAncestors: ["Overview"],
      searchText: "general employment overview"
    })
  ];
}

function queryCases(): StorageVnextSearchValidationCase[] {
  const alpha = [{ sourceFilePublicId: "file-alpha", relevance: 3 }];
  return [
    validationCase("exact", "Employment Contract Master Guide", ["title"], "content", alpha),
    validationCase("title", "Master Guide", ["title"], "content", alpha),
    validationCase("path", "alpha", ["logicalPath"], "content", alpha),
    validationCase("content", "termination", ["searchText"], "content", alpha),
    validationCase("multi_term", "employment termination", ["searchText"], "content", alpha),
    validationCase("phrase", "\"employment contract\"", ["searchText"], "content", alpha),
    validationCase("typo", "employmnt contrct", ["searchText"], "content", alpha),
    validationCase("chinese", "劳动合同", ["searchText"], "content", alpha),
    validationCase("mixed_script", "employment 合同", ["searchText"], "content", alpha),
    validationCase(
      "graph_seed", "dependency guide", ["searchText", "rankingTerms"],
      "graph_seed", alpha
    ),
    validationCase(
      "ranking", "employment contract", ["title"], "content",
      [
        { sourceFilePublicId: "file-alpha", relevance: 3 },
        { sourceFilePublicId: "file-beta", relevance: 1 }
      ]
    )
  ];
}

function validationCase(
  kind: StorageVnextSearchValidationCase["kind"],
  query: string,
  attributesToSearchOn: string[],
  documentKind: "content" | "graph_seed",
  relevantSources: StorageVnextSearchValidationCase["relevantSources"]
): StorageVnextSearchValidationCase {
  return {
    kind,
    query,
    attributesToSearchOn,
    documentKind,
    limit: 10,
    relevantSources,
    minimumRecall: 1,
    minimumNdcg: 1
  };
}

function currentSources() {
  return [{
    sourceFilePublicId: "file-alpha",
    sourceRevisionPublicId: "revision-alpha",
    logicalPath: "pages/guides/alpha.md",
    title: "Employment Contract Master Guide",
    metadata: {}
  }, {
    sourceFilePublicId: "file-beta",
    sourceRevisionPublicId: "revision-beta",
    logicalPath: "pages/guides/beta.md",
    title: "Contract Employment Overview",
    metadata: {}
  }];
}

function validationRepository(
  record: StorageVnextSearchProjectionRecord
): StorageVnextSearchProjectionRepository {
  return {
    reserveCandidate: vi.fn(),
    getCandidate: vi.fn(async () => record),
    beginProviderOperation: vi.fn(),
    recordProviderOperation: vi.fn(),
    completeProviderOperation: vi.fn(),
    markCandidateIndexing: vi.fn(),
    beginDocumentBatch: vi.fn(),
    completeDocumentBatch: vi.fn(),
    beginCandidateValidation: vi.fn(async ({ documentChecksum }) => {
      record.state = "validating";
      record.documentChecksum = documentChecksum;
      return { outcome: "validate" as const };
    }),
    completeCandidateValidation: vi.fn(async () => {
      record.state = "ready";
    }),
    failCandidateValidation: vi.fn(async () => {
      record.state = "failed";
    })
  };
}
