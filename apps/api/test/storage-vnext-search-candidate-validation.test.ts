import { describe, expect, it, vi } from "vitest";
import type {
  MeilisearchClientPort
} from "../src/infrastructure/meilisearch/meilisearch-client-port.js";
import type { SearchProviderIndexDefinition } from
  "../src/application/ports/search-provider-runtime.js";
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
  createStorageVnextSearchDocumentSetChecksum
} from "../src/storage-vnext/search/document-set-checksum.js";
import type {
  StorageVnextSearchDocument,
  StorageVnextSearchValidationCase
} from "../src/storage-vnext/search/ports.js";
import {
  createStorageVnextContentDocument,
  createStorageVnextGraphSeedDocument
} from "../src/storage-vnext/search/documents.js";
import type {
  StorageVnextSearchProjectionRecord,
  StorageVnextSearchProjectionRepository
} from "../src/storage-vnext/search/projection-repository.js";

const settings: SearchProviderIndexDefinition = {
  primaryKey: "id",
  searchableAttributes: [
    "title", "logicalPath", "headingAncestors", "searchText", "rankingTerms"
  ],
  filterableAttributes: [
    "knowledgeBaseId", "documentKind", "schemaVersion", "sourceFilePublicId"
  ],
  displayedAttributes: [
    "id", "documentKind", "schemaVersion", "knowledgeBaseId",
    "sourceFilePublicId", "sourceRevisionPublicId", "logicalPath", "title",
    "contentKind", "fileKind", "segmentOrdinal", "headingAncestors",
    "searchText", "rankingTerms"
  ],
  rankingRules: ["words", "typo", "proximity", "attribute", "sort", "exactness"],
  distinctAttribute: "sourceFilePublicId",
  maximumTotalHits: 2_000,
  searchCutoffMs: 1_000,
  typoDisabledAttributes: ["logicalPath"]
};
const meilisearchSettings = toMeilisearchSettings(settings);
const settingsChecksum = createStorageVnextSearchSettingsChecksum(settings);

const documents: StorageVnextSearchDocument[] = [
  createStorageVnextContentDocument({
  contentKind: "file",
  knowledgeBaseId: "kb-a",
  sourceFilePublicId: "file-a",
  sourceRevisionPublicId: "revision-a",
  logicalPath: "pages/guides/a.md",
  fileKind: "page",
  title: "Employment 合同 Guide",
  segmentOrdinal: null,
  headingAncestors: [],
  searchText: "{\"topic\":\"contract\"}"
}), createStorageVnextContentDocument({
  contentKind: "segment",
  knowledgeBaseId: "kb-a",
  sourceFilePublicId: "file-a",
  sourceRevisionPublicId: "revision-a",
  logicalPath: "pages/guides/a.md",
  fileKind: "page",
  title: "Employment 合同 Guide",
  segmentOrdinal: 0,
  headingAncestors: ["Terms"],
  searchText: "employment contract 劳动合同 termination notice"
}), createStorageVnextGraphSeedDocument({
  knowledgeBaseId: "kb-a",
  sourceFilePublicId: "file-a",
  sourceRevisionPublicId: "revision-a",
  logicalPath: "pages/guides/a.md",
  title: "Employment dependency",
  searchText: "Employment dependency guide",
  rankingTerms: ["guide"]
})];

describe("storage vNext search candidate validation", () => {
  it("validates counts, checksums, paths, query parity, ranking, and hydration", async () => {
    const fixture = createFixture();
    const refreshIndex = vi.spyOn(fixture.provider.write, "refreshIndex");

    await validateStorageVnextSearchCandidate({
      repository: fixture.repository,
      provider: fixture.provider,
      hydration: fixture.hydration,
      settings,
      documentPageSize: 2,
      input: validationInput()
    });

    expect(fixture.record.state).toBe("ready");
    expect(refreshIndex).toHaveBeenCalledOnce();
    expect(refreshIndex).toHaveBeenCalledWith({
      indexUid: fixture.record.providerIndexUid
    });
    expect(refreshIndex.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(fixture.transport.getIndexStats!).mock.invocationCallOrder[0]!
    );
    expect(fixture.transport.listDocuments).toHaveBeenCalledTimes(2);
    expect(fixture.transport.search).toHaveBeenCalledTimes(22);
    expect(fixture.hydration.hydrateCurrentSources).toHaveBeenCalled();
    expect(fixture.hydration.hydrateCurrentSources).toHaveBeenCalledWith(
      expect.objectContaining({ candidatePublicId: "candidate-a" })
    );
  });

  it("fails a candidate containing a deleted or stale hydration identity", async () => {
    const fixture = createFixture();
    fixture.hydration.hydrateCurrentSources.mockResolvedValue([]);

    await expect(validateStorageVnextSearchCandidate({
      repository: fixture.repository,
      provider: fixture.provider,
      hydration: fixture.hydration,
      settings,
      documentPageSize: 2,
      input: validationInput()
    })).rejects.toMatchObject({ code: "candidate_hydration_mismatch" });
    expect(fixture.record.state).toBe("failed");
  });

  it("independently rejects a provider document checksum mismatch", async () => {
    const fixture = createFixture();
    fixture.transport.listDocuments.mockResolvedValueOnce({
      documents: [documents[0]!],
      total: 1,
      offset: 0
    });
    fixture.transport.getIndexStats = vi.fn(async () => ({ numberOfDocuments: 1 }));

    await expect(validateStorageVnextSearchCandidate({
      repository: fixture.repository,
      provider: fixture.provider,
      hydration: fixture.hydration,
      settings,
      documentPageSize: 2,
      input: { ...validationInput(), expectedDocumentCount: 1 }
    })).rejects.toMatchObject({ code: "candidate_checksum_mismatch" });
    expect(fixture.record.state).toBe("failed");
  });

  it("requires the complete exact-to-ranking query matrix", async () => {
    const fixture = createFixture();
    const input = validationInput();

    await expect(validateStorageVnextSearchCandidate({
      repository: fixture.repository,
      provider: fixture.provider,
      hydration: fixture.hydration,
      settings,
      documentPageSize: 2,
      input: { ...input, queryCases: input.queryCases.slice(1) }
    })).rejects.toMatchObject({ code: "candidate_query_matrix_incomplete" });
    expect(fixture.record.state).toBe("failed");
  });

  it("validates an empty knowledge-base index without a fabricated query matrix", async () => {
    const fixture = createFixture();
    fixture.record.documentCount = 0;
    fixture.transport.getIndexStats = vi.fn(async () => ({ numberOfDocuments: 0 }));

    await validateStorageVnextSearchCandidate({
      repository: fixture.repository,
      provider: fixture.provider,
      hydration: fixture.hydration,
      settings,
      documentPageSize: 2,
      input: {
        ...validationInput(),
        expectedDocumentCount: 0,
        documentChecksum: createStorageVnextSearchDocumentSetChecksum([]),
        queryCases: []
      }
    });

    expect(fixture.record.state).toBe("ready");
    expect(fixture.transport.search).not.toHaveBeenCalled();
  });

  it("rejects ranking below the declared NDCG threshold", async () => {
    const fixture = createFixture();
    const fileB = {
      sourceFilePublicId: "file-b",
      sourceRevisionPublicId: "revision-b",
      logicalPath: "pages/guides/b.md"
    };
    fixture.transport.search.mockResolvedValue({
      hits: [fileB, documents[1] as Record<string, unknown>],
      estimatedTotalHits: 2,
      processingTimeMs: 2
    });
    fixture.hydration.hydrateCurrentSources.mockResolvedValue([{
      sourceFilePublicId: "file-b",
      sourceRevisionPublicId: "revision-b",
      logicalPath: "pages/guides/b.md",
      title: "B"
    }, {
      sourceFilePublicId: "file-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "pages/guides/a.md",
      title: "A"
    }]);
    const input = validationInput();
    const queryCases = input.queryCases.map((item) => item.kind === "ranking"
      ? {
          ...item,
          relevantSources: [
            { sourceFilePublicId: "file-a", relevance: 3 },
            { sourceFilePublicId: "file-b", relevance: 1 }
          ]
        }
      : { ...item, minimumNdcg: 0 });

    await expect(validateStorageVnextSearchCandidate({
      repository: fixture.repository,
      provider: fixture.provider,
      hydration: fixture.hydration,
      settings,
      documentPageSize: 2,
      input: { ...input, queryCases }
    })).rejects.toMatchObject({
      code: "candidate_ndcg_below_minimum",
      validationKind: "ranking"
    });
  });

  it("rejects provider P95 processing time above the candidate budget", async () => {
    const fixture = createFixture();
    fixture.transport.search.mockResolvedValue({
      hits: [documents[1] as Record<string, unknown>],
      estimatedTotalHits: 1,
      processingTimeMs: 2_000
    });

    await expect(validateStorageVnextSearchCandidate({
      repository: fixture.repository,
      provider: fixture.provider,
      hydration: fixture.hydration,
      settings,
      documentPageSize: 2,
      input: validationInput()
    })).rejects.toMatchObject({ code: "candidate_latency_exceeded" });
  });
});

function validationInput() {
  return {
    candidatePublicId: "candidate-a",
    expectedDocumentCount: documents.length,
    documentChecksum: createStorageVnextSearchDocumentSetChecksum(documents),
    schemaChecksum: "a".repeat(64),
    settingsChecksum,
    queryCases: validationCases(),
    maxP95ProcessingTimeMs: 1_000
  };
}

function validationCases(): StorageVnextSearchValidationCase[] {
  const definitions: Array<{
    kind: StorageVnextSearchValidationCase["kind"];
    query: string;
    attributes: string[];
    documentKind: "content" | "graph_seed";
  }> = [
    { kind: "exact", query: "Employment 合同 Guide", attributes: ["title"], documentKind: "content" },
    { kind: "title", query: "Employment Guide", attributes: ["title"], documentKind: "content" },
    { kind: "path", query: "guides a", attributes: ["logicalPath"], documentKind: "content" },
    { kind: "content", query: "termination", attributes: ["searchText"], documentKind: "content" },
    { kind: "multi_term", query: "employment notice", attributes: ["searchText"], documentKind: "content" },
    { kind: "phrase", query: "\"employment contract\"", attributes: ["searchText"], documentKind: "content" },
    { kind: "typo", query: "employmnt contrct", attributes: ["searchText"], documentKind: "content" },
    { kind: "chinese", query: "劳动合同", attributes: ["searchText"], documentKind: "content" },
    { kind: "mixed_script", query: "employment 合同", attributes: ["searchText"], documentKind: "content" },
    { kind: "graph_seed", query: "dependency guide", attributes: ["searchText", "rankingTerms"], documentKind: "graph_seed" },
    { kind: "ranking", query: "employment contract", attributes: ["title", "searchText"], documentKind: "content" }
  ];
  return definitions.map((definition) => ({
    kind: definition.kind,
    query: definition.query,
    attributesToSearchOn: definition.attributes,
    documentKind: definition.documentKind,
    limit: 10,
    relevantSources: [{ sourceFilePublicId: "file-a", relevance: 3 }],
    minimumRecall: 1,
    minimumNdcg: 1
  }));
}

function createFixture() {
  const record: StorageVnextSearchProjectionRecord = {
    publicId: "candidate-a",
    knowledgeBaseId: "kb-a",
    providerKind: "meilisearch",
    providerIndexUid: "owned_candidate_a",
    schemaChecksum: "a".repeat(64),
    settingsChecksum,
    documentChecksum: null,
    state: "indexing",
    documentCount: documents.length,
    nextBatchOrdinal: 1,
    lastBatchOrdinal: 0,
    lastBatchChecksum: "d".repeat(64),
    correlationPublicId: null,
    providerOperationRef: null,
    revision: 1
  };
  const repository: StorageVnextSearchProjectionRepository = {
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
    failCandidateValidation: vi.fn(async ({ safeErrorCode }) => {
      record.state = "failed";
      void safeErrorCode;
    })
  };
  const listDocuments = vi.fn(async ({ offset, limit }: {
    offset: number;
    limit: number;
  }) => ({
    documents: documents.slice(offset, offset + limit),
    total: documents.length,
    offset
  }));
  const search = vi.fn(async () => ({
    hits: [documents[1] as Record<string, unknown>],
    estimatedTotalHits: 1,
    processingTimeMs: 2
  }));
  const transport = {
    getIndex: vi.fn(async () => ({ uid: record.providerIndexUid, primaryKey: "id" })),
    getIndexStats: vi.fn(async () => ({ numberOfDocuments: documents.length })),
    getSettings: vi.fn(async () => meilisearchSettings),
    listDocuments,
    search
  } as unknown as MeilisearchClientPort & {
    listDocuments: typeof listDocuments;
    search: typeof search;
  };
  const provider = createMeilisearchProviderRuntime(transport);
  const hydration = {
    hydrateCurrentSources: vi.fn(async () => [{
      sourceFilePublicId: "file-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "pages/guides/a.md",
      title: "Employment 合同 Guide"
    }])
  };
  return { record, repository, transport, provider, hydration };
}
