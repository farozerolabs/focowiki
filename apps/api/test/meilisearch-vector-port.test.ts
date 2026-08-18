import { describe, expect, it, vi } from "vitest";
import { createMeilisearchVectorPort } from
  "../src/infrastructure/meilisearch/meilisearch-vector-port.js";
import { createValidatedSearchProviderVectorPort } from
  "../src/semantic/vector/provider-contract.js";
import type { MeilisearchClientPort, MeilisearchSettings } from
  "../src/infrastructure/meilisearch/meilisearch-client-port.js";

describe("Meilisearch semantic vector port", () => {
  it("configures one userProvided embedder and writes application vectors", async () => {
    const transport = transportStub();
    const port = createValidatedSearchProviderVectorPort(
      createMeilisearchVectorPort({ transport })
    );
    await expect(port.createIndex({
      indexUid: "semantic-candidate-1",
      definition: definition()
    })).resolves.toMatchObject({ state: "pending" });
    expect(transport.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      indexUid: "semantic-candidate-1",
      settings: expect.objectContaining({
        embedders: {
          ["focowiki_" + "a".repeat(64)]: {
            source: "userProvided",
            dimensions: 3
          }
        }
      })
    }));
    await port.writeDocuments({
      indexUid: "semantic-candidate-1",
      definition: definition(),
      documents: [document()],
      correlation: "operation-1"
    });
    expect(transport.addDocuments).toHaveBeenCalledWith(expect.objectContaining({
      documents: [expect.objectContaining({
        id: "vector-1",
        _vectors: { ["focowiki_" + "a".repeat(64)]: [0.1, 0.2, 0.3] }
      })]
    }));
  });

  it("runs vector-only retrieval with active scope filters", async () => {
    const transport = transportStub({
      search: vi.fn(async () => ({
        hits: [{ ...document(), _vectors: undefined }],
        estimatedTotalHits: 1,
        processingTimeMs: 2
      }))
    });
    const port = createValidatedSearchProviderVectorPort(
      createMeilisearchVectorPort({ transport })
    );
    await expect(port.query({
      indexUid: "semantic-candidate-1",
      knowledgeBaseId: "kb-1",
      semanticGenerationPublicId: "generation-1",
      embeddingConfigurationRevisionPublicId: "embedding-1",
      family: "entity",
      dimension: 3,
      vector: [0.1, 0.2, 0.3],
      minimumRelevance: 0.42,
      fileKind: "page",
      okfFilters: {
        status: "stable",
        trustTier: "human-reviewed",
        freshness: "fresh",
        requestEpochDay: 25_000
      },
      limit: 5,
      deadlineMs: 1_000
    })).resolves.toEqual({
      hits: [expect.objectContaining({ documentId: "vector-1", rank: 1 })],
      processingTimeMs: 2
    });
    expect(transport.search).toHaveBeenCalledWith(expect.objectContaining({
      query: "",
      vector: [0.1, 0.2, 0.3],
      hybrid: {
        embedder: "focowiki_" + "a".repeat(64),
        semanticRatio: 1
      },
      rankingScoreThreshold: 0.71,
      filter: expect.stringMatching(
        /semanticGenerationPublicId = "generation-1".*fileKind = "page".*okfStatus = "stable".*okfTrustTier = "human-reviewed".*okfStaleAfterEpochDay > 25000/u
      )
    }));
  });

  it("uses scoped delete filters and provider task polling", async () => {
    const transport = transportStub();
    const port = createValidatedSearchProviderVectorPort(
      createMeilisearchVectorPort({ transport })
    );
    await expect(port.deleteDocuments({
      indexUid: "semantic-candidate-1",
      knowledgeBaseId: "kb-1",
      semanticGenerationPublicId: "generation-1",
      documentIds: ["vector-1"],
      correlation: "operation-1"
    })).resolves.toMatchObject({ state: "pending" });
    expect(transport.deleteDocuments).toHaveBeenCalledWith(expect.objectContaining({
      filter: expect.stringMatching(/knowledgeBaseId.*generation-1.*id IN/u)
    }));
    await expect(port.getOperation({ operationRef: "meilisearch:7" }))
      .resolves.toEqual({ state: "completed" });
  });

  it("surfaces a recovered failed task and rejects a missing stats capability", async () => {
    const transport = transportStub({
      findTaskByCorrelation: vi.fn(async () => ({
        taskUid: 9,
        status: "failed" as const,
        errorCode: "invalid_document"
      })),
      getTask: vi.fn(async () => ({
        taskUid: 9,
        status: "failed" as const,
        errorCode: "invalid_document"
      }))
    });
    const port = createValidatedSearchProviderVectorPort(
      createMeilisearchVectorPort({ transport })
    );
    await expect(port.findOperationByCorrelation({
      indexUid: "semantic-candidate-1",
      correlation: "operation-1"
    })).resolves.toEqual({ state: "pending", operationRef: "meilisearch:9" });
    await expect(port.getOperation({ operationRef: "meilisearch:9" }))
      .resolves.toEqual({
        state: "failed",
        errorCode: "SEARCH_ENGINE_REQUEST_FAILED"
      });

    const { getIndexStats: _getIndexStats, ...incompatible } = transportStub();
    await expect(createValidatedSearchProviderVectorPort(
      createMeilisearchVectorPort({ transport: incompatible })
    ).validate({
      indexUid: "semantic-candidate-1",
      definition: definition(),
      expectedDocumentCount: 0
    })).rejects.toMatchObject({
      code: "SEARCH_ENGINE_VERSION_INCOMPATIBLE",
      retryable: false
    });
  });
});

function definition() {
  return {
    schemaVersion: "focowiki-semantic-vector-v1",
    dimension: 3,
    similarity: "cosine" as const,
    families: ["content", "entity", "relationship", "community"] as const,
    mappingFingerprintSha256: "a".repeat(64)
  };
}

function document() {
  return {
    id: "vector-1",
    knowledgeBaseId: "kb-1",
    semanticGenerationPublicId: "generation-1",
    ownerPublicId: "entity-1",
    family: "entity" as const,
    sourceFilePublicId: "file-1",
    sourceRevisionPublicId: "revision-1",
    embeddingConfigurationRevisionPublicId: "embedding-1",
    evidenceTargetPath: "sources/file-1.md",
    sourceExcerpt: "Source-grounded excerpt.",
    fileKind: "page" as const,
    okfStatus: "stable" as const,
    okfTrustTier: "human-reviewed" as const,
    okfStaleAfterEpochDay: 30_000,
    vector: [0.1, 0.2, 0.3]
  };
}

function settings(): MeilisearchSettings {
  return {
    searchableAttributes: [],
    filterableAttributes: [
      "id", "knowledgeBaseId", "semanticGenerationPublicId", "family",
      "embeddingConfigurationRevisionPublicId"
    ],
    displayedAttributes: [
      "id", "knowledgeBaseId", "semanticGenerationPublicId", "ownerPublicId",
      "family", "sourceFilePublicId", "sourceRevisionPublicId",
      "embeddingConfigurationRevisionPublicId", "evidenceTargetPath"
    ],
    sortableAttributes: [],
    rankingRules: ["sort", "words", "typo", "proximity", "attribute", "exactness"],
    distinctAttribute: null,
    pagination: { maxTotalHits: 1_000 },
    searchCutoffMs: 1_000,
    localizedAttributes: [],
    typoTolerance: { disableOnAttributes: [] },
    embedders: {
      ["focowiki_" + "a".repeat(64)]: { source: "userProvided", dimensions: 3 }
    }
  };
}

function transportStub(overrides: {
  search?: MeilisearchClientPort["search"];
  findTaskByCorrelation?: MeilisearchClientPort["findTaskByCorrelation"];
  getTask?: MeilisearchClientPort["getTask"];
} = {}): MeilisearchClientPort {
  return {
    health: vi.fn(async () => ({ available: true, version: "1.51.0" })),
    getPressure: vi.fn(async () => ({
      queueLatencyMs: 0, residentMemoryBytes: 0,
      databaseSizeBytes: 0, taskQueueSizeBytes: 0
    })),
    createIndex: vi.fn(async () => ({ taskUid: 1 })),
    getIndex: vi.fn(async (input) => ({ uid: input.indexUid, primaryKey: "id" })),
    getIndexStats: vi.fn(async () => ({ numberOfDocuments: 0 })),
    listDocuments: vi.fn(async (input) => ({ documents: [], total: 0, offset: input.offset })),
    getDocument: vi.fn(async () => null),
    getSettings: vi.fn(async () => settings()),
    updateSettings: vi.fn(async () => ({ taskUid: 2 })),
    addDocuments: vi.fn(async () => ({ taskUid: 3 })),
    deleteDocuments: vi.fn(async () => ({ taskUid: 4 })),
    deleteIndex: vi.fn(async () => ({ taskUid: 5 })),
    findTaskByCorrelation: overrides.findTaskByCorrelation ?? vi.fn(async () => null),
    getTask: overrides.getTask ?? vi.fn(async () => ({
      taskUid: 7, status: "succeeded" as const, errorCode: null
    })),
    search: overrides.search ?? vi.fn(async () => ({
      hits: [], estimatedTotalHits: 0, processingTimeMs: 0
    }))
  };
}
