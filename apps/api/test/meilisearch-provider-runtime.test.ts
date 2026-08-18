import { describe, expect, it, vi } from "vitest";
import type { MeilisearchClientPort } from
  "../src/infrastructure/meilisearch/meilisearch-client-port.js";
import {
  createMeilisearchProviderRuntime,
  toMeilisearchSettings
} from "../src/infrastructure/meilisearch/meilisearch-provider-runtime.js";

describe("Meilisearch provider runtime", () => {
  it("enables native comparison filters for OKF epoch-day fields", () => {
    expect(toMeilisearchSettings(definition()).filterableAttributes)
      .toEqual([expect.objectContaining({
        features: {
          facetSearch: false,
          filter: { equality: true, comparison: true }
        }
      })]);
  });

  it("keeps numeric task identifiers inside tagged opaque receipts", async () => {
    const transport = legacyTransport();
    const runtime = createMeilisearchProviderRuntime(transport);

    await expect(runtime.admin.createIndex({
      indexUid: "owned_candidate",
      definition: definition()
    })).resolves.toEqual({ state: "pending", operationRef: "meilisearch:11" });
    await expect(runtime.operations.getOperation({
      operationRef: "meilisearch:11"
    })).resolves.toEqual({ state: "completed" });
    expect(transport.createIndex).toHaveBeenCalledWith({
      indexUid: "owned_candidate",
      primaryKey: "id"
    });
  });

  it("renders structured filters internally and returns normalized hits", async () => {
    const transport = legacyTransport({
      search: vi.fn(async () => ({
        hits: [{
          id: "document-a",
          sourceFilePublicId: "source-a",
          sourceRevisionPublicId: "revision-a",
          logicalPath: "guides/a.md",
          title: "Guide A",
          _formatted: { searchText: "matched text" }
        }],
        estimatedTotalHits: 2,
        processingTimeMs: 3
      }))
    });
    const runtime = createMeilisearchProviderRuntime(transport);

    const result = await runtime.query.query({
      indexUid: "owned_active",
      query: "guide",
      evidenceFamilies: ["text"],
      filters: {
        kind: "and",
        operands: [{
          kind: "equals",
          field: "knowledgeBaseId",
          value: "kb-a"
        }, {
          kind: "or",
          operands: [{
            kind: "equals",
            field: "documentKind",
            value: "content"
          }, {
            kind: "boolean",
            field: "visible",
            value: true
          }]
        }, {
          kind: "range",
          field: "okfSignals.staleAfterEpochDay",
          operator: "gt",
          value: 20_719
        }]
      },
      searchFields: ["title", "searchText"],
      returnFields: [
        "id", "sourceFilePublicId", "sourceRevisionPublicId", "logicalPath", "title"
      ],
      limit: 1,
      continuation: null,
      cropLength: 40,
      deadlineMs: 1_000,
      matchingStrategy: "all",
      distinctBy: "sourceFilePublicId"
    });

    expect(transport.search).toHaveBeenCalledWith(expect.objectContaining({
      filter: 'knowledgeBaseId = "kb-a" AND (documentKind = "content" OR visible = true) AND okfSignals.staleAfterEpochDay > 20719'
    }));
    expect(result).toMatchObject({
      hits: [{
        documentId: "document-a",
        sourceFilePublicId: "source-a",
        snippets: ["matched text"]
      }],
      continuation: expect.any(String),
      processingTimeMs: 3
    });
  });

  it("normalizes blended natural-language queries before relaxed matching", async () => {
    const transport = legacyTransport();
    const tokenizer = {
      contractVersion: "lexical-tokenizer-test-v1",
      tokenizeDocument: vi.fn(() => []),
      tokenizeQuery: vi.fn(() => [
        "what", "does", "gross", "margin", "for", "period", "define",
        "or", "describe"
      ])
    };
    const runtime = createMeilisearchProviderRuntime(transport, tokenizer);

    await runtime.query.query({
      indexUid: "owned_active",
      query: "What does Gross margin for a period define or describe?",
      evidenceFamilies: ["exact", "text", "phrase", "typo", "jieba", "graph"],
      filters: {
        kind: "equals",
        field: "knowledgeBaseId",
        value: "kb-a"
      },
      searchFields: ["title", "logicalPath", "searchText", "rankingTerms"],
      returnFields: [
        "id", "sourceFilePublicId", "sourceRevisionPublicId", "logicalPath",
        "title"
      ],
      limit: 10,
      continuation: null,
      cropLength: 40,
      deadlineMs: 1_000,
      matchingStrategy: "all",
      distinctBy: "sourceFilePublicId"
    });

    expect(tokenizer.tokenizeQuery).toHaveBeenCalledWith(
      "What does Gross margin for a period define or describe?",
      64
    );
    expect(transport.search).toHaveBeenCalledWith(expect.objectContaining({
      query: "gross margin period",
      matchingStrategy: "last",
      rankingScoreThreshold: 0.05
    }));
  });

  it("rejects operation references owned by another provider", async () => {
    const runtime = createMeilisearchProviderRuntime(legacyTransport());

    await expect(runtime.operations.getOperation({
      operationRef: "opensearch:task-a"
    })).rejects.toMatchObject({
      code: "SEARCH_ENGINE_REQUEST_FAILED",
      retryable: false
    });
  });

  it("supports the shared provider lifecycle contract without owning a client", async () => {
    const runtime = createMeilisearchProviderRuntime(legacyTransport());

    await expect(runtime.close()).resolves.toBeUndefined();
  });
});

function definition() {
  return {
    primaryKey: "id" as const,
    searchableAttributes: ["title", "searchText"],
    filterableAttributes: ["knowledgeBaseId", "documentKind", "visible"],
    displayedAttributes: ["id", "title", "searchText"],
    rankingRules: ["words", "typo"],
    distinctAttribute: "sourceFilePublicId" as const,
    maximumTotalHits: 2_000,
    searchCutoffMs: 1_000,
    typoDisabledAttributes: ["logicalPath"]
  };
}

function legacyTransport(
  overrides: Partial<MeilisearchClientPort> = {}
): MeilisearchClientPort & Record<string, ReturnType<typeof vi.fn>> {
  return {
    health: vi.fn(async () => ({ available: true })),
    getPressure: vi.fn(async () => ({
      queueLatencyMs: 0,
      residentMemoryBytes: 0,
      databaseSizeBytes: 0,
      taskQueueSizeBytes: 0
    })),
    createIndex: vi.fn(async () => ({ taskUid: 11 })),
    getIndex: vi.fn(async ({ indexUid }) => ({ uid: indexUid, primaryKey: "id" })),
    getDocument: vi.fn(async () => null),
    getSettings: vi.fn(async () => ({
      searchableAttributes: ["title", "searchText"],
      filterableAttributes: ["knowledgeBaseId", "documentKind", "visible"],
      displayedAttributes: ["id", "title", "searchText"],
      sortableAttributes: [],
      rankingRules: ["words", "typo"],
      distinctAttribute: "sourceFilePublicId",
      pagination: { maxTotalHits: 2_000 },
      searchCutoffMs: 1_000,
      localizedAttributes: [],
      typoTolerance: { disableOnAttributes: ["logicalPath"] }
    })),
    updateSettings: vi.fn(async () => ({ taskUid: 12 })),
    addDocuments: vi.fn(async () => ({ taskUid: 13 })),
    deleteDocuments: vi.fn(async () => ({ taskUid: 14 })),
    deleteIndex: vi.fn(async () => ({ taskUid: 15 })),
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
  } as MeilisearchClientPort & Record<string, ReturnType<typeof vi.fn>>;
}
