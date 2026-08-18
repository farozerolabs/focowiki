import { describe, expect, it, vi } from "vitest";
import { createOpenSearchVectorPort } from
  "../src/infrastructure/opensearch/opensearch-vector-port.js";
import { createValidatedSearchProviderVectorPort } from
  "../src/semantic/vector/provider-contract.js";
import type { OpenSearchClientPort } from
  "../src/infrastructure/opensearch/opensearch-client-port.js";

describe("OpenSearch semantic vector port", () => {
  it("creates a 3.8-compatible k-NN mapping and writes bounded vector documents", async () => {
    const client = clientStub();
    const port = createValidatedSearchProviderVectorPort(createOpenSearchVectorPort({ client }));
    await port.createIndex({ indexUid: "semantic-candidate-1", definition: definition() });
    expect(client.indices.create).toHaveBeenCalledWith(expect.objectContaining({
      index: "semantic-candidate-1",
      body: expect.objectContaining({
        settings: { index: { knn: true } },
        mappings: expect.objectContaining({
          dynamic: "strict",
          properties: expect.objectContaining({
            vector: expect.objectContaining({
              type: "knn_vector",
              dimension: 3,
              space_type: "cosinesimil"
            })
          })
        })
      })
    }));
    await port.writeDocuments({
      indexUid: "semantic-candidate-1",
      definition: definition(),
      documents: [document()],
      correlation: "operation-1"
    });
    expect(client.bulk).toHaveBeenCalledWith(expect.objectContaining({
      body: [
        { index: { _index: "semantic-candidate-1", _id: "vector-1" } },
        expect.objectContaining({ vector: [0.1, 0.2, 0.3], family: "entity" })
      ]
    }), expect.anything());
  });

  it("filters k-NN by active scope and returns independently ranked evidence", async () => {
    const client = clientStub({
      search: vi.fn(async () => ({
        body: {
          took: 4,
          hits: { hits: [{
            _id: "vector-1",
            _source: { ...document(), vector: undefined }
          }] }
        }
      }))
    });
    const port = createValidatedSearchProviderVectorPort(createOpenSearchVectorPort({ client }));
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
      processingTimeMs: 4
    });
    expect(client.search).toHaveBeenCalledWith(expect.objectContaining({
      index: "semantic-candidate-1",
      body: expect.objectContaining({
        query: { knn: { vector: expect.objectContaining({
          vector: [0.1, 0.2, 0.3],
          min_score: 0.71,
          filter: { bool: { filter: expect.arrayContaining([
            { term: { knowledgeBaseId: "kb-1" } },
            { term: { semanticGenerationPublicId: "generation-1" } },
            { term: { family: "entity" } },
            { term: { fileKind: "page" } },
            { term: { okfStatus: "stable" } },
            { term: { okfTrustTier: "human-reviewed" } },
            { range: { okfStaleAfterEpochDay: { gt: 25_000 } } }
          ]) } }
        }) } }
      })
    }), { requestTimeout: 1_000 });
  });

  it("deletes only scoped ids and validates mapping plus count", async () => {
    const client = clientStub({
      count: vi.fn(async () => ({ body: { count: 1 } })),
      getMapping: vi.fn(async () => mappingResponse())
    });
    const port = createValidatedSearchProviderVectorPort(createOpenSearchVectorPort({ client }));
    await port.deleteDocuments({
      indexUid: "semantic-candidate-1",
      knowledgeBaseId: "kb-1",
      semanticGenerationPublicId: "generation-1",
      documentIds: ["vector-1"],
      correlation: "operation-1"
    });
    expect(client.deleteByQuery).toHaveBeenCalledWith(expect.objectContaining({
      body: { query: { bool: { filter: expect.arrayContaining([
        { ids: { values: ["vector-1"] } },
        { term: { knowledgeBaseId: "kb-1" } },
        { term: { semanticGenerationPublicId: "generation-1" } }
      ]) } } }
    }));
    await expect(port.validate({
      indexUid: "semantic-candidate-1",
      definition: definition(),
      expectedDocumentCount: 1
    })).resolves.toEqual({ valid: true, documentCount: 1 });
  });

  it("retries only a partial bulk overload inside the provider boundary", async () => {
    const bulk = vi.fn()
      .mockResolvedValueOnce({
        body: { items: [{ index: { _id: "vector-1", status: 429 } }] }
      })
      .mockResolvedValueOnce({
        body: { items: [{ index: { _id: "vector-1", status: 201 } }] }
      });
    const sleep = vi.fn(async () => undefined);
    const client = clientStub({
      bulk
    });
    const port = createValidatedSearchProviderVectorPort(
      createOpenSearchVectorPort({
        client,
        maximumAttempts: 3,
        retryDelayMs: 10,
        sleep
      })
    );
    await expect(port.writeDocuments({
      indexUid: "semantic-candidate-1",
      definition: definition(),
      documents: [document()],
      correlation: "operation-1"
    })).resolves.toEqual({ state: "completed" });
    expect(bulk).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it("splits vector bulk writes at the configured byte boundary without dropping documents", async () => {
    const bulk = vi.fn(async (input: { body: unknown[] }) => ({
      body: {
        items: input.body.filter((_, index) => index % 2 === 0)
          .map((item) => ({
            index: {
              _id: (item as { index: { _id: string } }).index._id,
              status: 201
            }
          }))
      }
    }));
    const first = { ...document(), sourceExcerpt: "a".repeat(400) };
    const second = {
      ...document(),
      id: "vector-2",
      ownerPublicId: "entity-2",
      sourceExcerpt: "b".repeat(400)
    };
    const port = createValidatedSearchProviderVectorPort(
      createOpenSearchVectorPort({
        client: clientStub({ bulk }),
        maximumBulkBytes: 1_200
      })
    );

    await expect(port.writeDocuments({
      indexUid: "semantic-candidate-1",
      definition: definition(),
      documents: [first, second],
      correlation: "operation-byte-bounded"
    })).resolves.toEqual({ state: "completed" });
    expect(bulk).toHaveBeenCalledTimes(2);
    expect(bulk.mock.calls.map(([request]) => request.body)).toEqual([
      [
        { index: { _index: "semantic-candidate-1", _id: "vector-1" } },
        expect.objectContaining({ id: "vector-1" })
      ],
      [
        { index: { _index: "semantic-candidate-1", _id: "vector-2" } },
        expect.objectContaining({ id: "vector-2" })
      ]
    ]);
  });

  it("rejects a single vector document that exceeds the byte boundary", async () => {
    const bulk = vi.fn();
    const port = createValidatedSearchProviderVectorPort(
      createOpenSearchVectorPort({
        client: clientStub({ bulk }),
        maximumBulkBytes: 300
      })
    );

    await expect(port.writeDocuments({
      indexUid: "semantic-candidate-1",
      definition: definition(),
      documents: [document()],
      correlation: "operation-oversized-document"
    })).rejects.toMatchObject({
      code: "SEARCH_ENGINE_MAPPING_INVALID",
      retryable: false
    });
    expect(bulk).not.toHaveBeenCalled();
  });

  it("keeps exhausted vector bulk overloads retryable and provider-safe", async () => {
    const client = clientStub({
      bulk: vi.fn(async () => ({
        body: { items: [{ index: { _id: "vector-1", status: 429 } }] }
      }))
    });
    const port = createValidatedSearchProviderVectorPort(
      createOpenSearchVectorPort({
        client,
        maximumAttempts: 2,
        retryDelayMs: 1,
        sleep: vi.fn(async () => undefined)
      })
    );

    await expect(port.writeDocuments({
      indexUid: "semantic-candidate-1",
      definition: definition(),
      documents: [document()],
      correlation: "operation-1"
    })).rejects.toMatchObject({
      code: "SEARCH_ENGINE_OVERLOADED",
      retryable: true
    });
  });

  it("treats a missing vector index as an idempotent deletion", async () => {
    const remove = vi.fn(async () => {
      throw Object.assign(new Error("index missing"), { statusCode: 404 });
    });
    const client = clientStub({ deleteIndex: remove });
    const port = createValidatedSearchProviderVectorPort(
      createOpenSearchVectorPort({ client })
    );

    await expect(port.deleteIndex({
      indexUid: "semantic-missing",
      correlation: "operation-delete-missing"
    })).resolves.toEqual({ state: "completed" });
    expect(remove).toHaveBeenCalledOnce();
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

function mappingResponse() {
  return {
    body: {
      "semantic-candidate-1": {
        mappings: {
          dynamic: "strict",
          _meta: { provider: "opensearch", vectorDefinition: definition() },
          properties: { vector: { type: "knn_vector", dimension: 3 } }
        }
      }
    }
  };
}

function clientStub(overrides: {
  bulk?: OpenSearchClientPort["bulk"];
  search?: OpenSearchClientPort["search"];
  count?: OpenSearchClientPort["count"];
  getMapping?: OpenSearchClientPort["indices"]["getMapping"];
  deleteIndex?: OpenSearchClientPort["indices"]["delete"];
} = {}): OpenSearchClientPort {
  return {
    info: vi.fn(async () => ({ body: {} })),
    bulk: overrides.bulk ?? vi.fn(async (input) => ({
      body: { items: (input.body as unknown[]).filter((_, index) => index % 2 === 0)
        .map((item) => ({ index: { _id: (item as { index: { _id: string } }).index._id, status: 201 } })) }
    })),
    search: overrides.search ?? vi.fn(async () => ({ body: { took: 0, hits: { hits: [] } } })),
    count: overrides.count ?? vi.fn(async () => ({ body: { count: 0 } })),
    get: vi.fn(async () => ({ body: {} })),
    deleteByQuery: vi.fn(async () => ({ body: { deleted: 1, failures: [] } })),
    indices: {
      exists: vi.fn(async () => ({ body: true })),
      create: vi.fn(async () => ({ body: { acknowledged: true } })),
      get: vi.fn(async () => ({ body: {} })),
      getMapping: overrides.getMapping ?? vi.fn(async () => mappingResponse()),
      putMapping: vi.fn(async () => ({ body: { acknowledged: true } })),
      getSettings: vi.fn(async () => ({ body: {} })),
      putSettings: vi.fn(async () => ({ body: { acknowledged: true } })),
      delete: overrides.deleteIndex
        ?? vi.fn(async () => ({ body: { acknowledged: true } })),
      refresh: vi.fn(async () => ({ body: {} }))
    },
    close: vi.fn(async () => undefined)
  };
}
