import { describe, expect, it, vi } from "vitest";
import { createSemanticDeletionService } from
  "../src/semantic/application/deletion-service.js";

describe("semantic deletion service", () => {
  it("deletes a bounded source vector page before purging durable state", async () => {
    const deleteDocuments = vi.fn(async () => ({ state: "completed" as const }));
    const purgeSourceState = vi.fn(async () => undefined);
    const service = createSemanticDeletionService({
      repository: {
        listSourceVectorPage: async () => ({
          items: [{
            semanticGenerationPublicId: "generation-a",
            mappingFingerprintSha256: "a".repeat(64),
            searchProviderKind: "opensearch",
            documentIds: ["vector-a"]
          }],
          nextCursor: null
        }),
        listKnowledgeBaseGenerationPage: async () => ({ items: [], nextCursor: null }),
        purgeSourceState,
        cancelKnowledgeBaseWork: async () => 0
      },
      provider: { ...vectorPort(), deleteDocuments },
      selectedProviderKind: "opensearch",
      indexPrefix: "focowiki",
      pageSize: 100,
      maximumOperationPolls: 2,
      operationPollIntervalMs: 0,
      clock: () => "2027-08-08T00:00:00.000Z"
    });

    await expect(service.deleteSourceScope({
      knowledgeBaseId: "kb-a", operationPublicId: "operation-delete",
      sourceFilePublicIds: ["file-a"], cursor: null
    })).resolves.toEqual({ outcome: "completed", nextCursor: null });
    expect(deleteDocuments).toHaveBeenCalledWith(expect.objectContaining({
      semanticGenerationPublicId: "generation-a",
      documentIds: ["vector-a"]
    }));
    expect(purgeSourceState).toHaveBeenCalledOnce();
  });

  it("pages knowledge-base index deletion without scanning vector documents", async () => {
    const deleteIndex = vi.fn(async () => ({ state: "completed" as const }));
    const cancelKnowledgeBaseWork = vi.fn(async () => 3);
    const service = createSemanticDeletionService({
      repository: {
        listSourceVectorPage: async () => ({ items: [], nextCursor: null }),
        listKnowledgeBaseGenerationPage: async () => ({
          items: [{
            semanticGenerationPublicId: "generation-a",
            mappingFingerprintSha256: "a".repeat(64),
            searchProviderKind: "meilisearch"
          }],
          nextCursor: null
        }),
        purgeSourceState: async () => undefined,
        cancelKnowledgeBaseWork
      },
      provider: {
        ...vectorPort(),
        deleteIndex,
        getIndexDefinition: async () => ({
          schemaVersion: "focowiki-semantic-vector-v1",
          dimension: 3,
          similarity: "cosine" as const,
          families: ["content", "entity", "relationship", "community"] as const,
          mappingFingerprintSha256: "a".repeat(64)
        })
      },
      selectedProviderKind: "meilisearch",
      indexPrefix: "focowiki",
      pageSize: 100,
      maximumOperationPolls: 2,
      operationPollIntervalMs: 0
    });
    await expect(service.deleteKnowledgeBaseScope({
      knowledgeBaseId: "kb-a", operationPublicId: "operation-delete",
      cursor: null
    })).resolves.toEqual({ outcome: "completed", nextCursor: null });
    expect(deleteIndex).toHaveBeenCalledOnce();
    expect(cancelKnowledgeBaseWork).toHaveBeenCalledOnce();
  });

  it("treats an uncreated knowledge-base vector index as already deleted", async () => {
    const deleteIndex = vi.fn(async () => ({ state: "completed" as const }));
    const getIndexDefinition = vi.fn(async () => null);
    const cancelKnowledgeBaseWork = vi.fn(async () => 1);
    const service = createSemanticDeletionService({
      repository: {
        listSourceVectorPage: async () => ({ items: [], nextCursor: null }),
        listKnowledgeBaseGenerationPage: async () => ({
          items: [{
            semanticGenerationPublicId: "generation-empty",
            mappingFingerprintSha256: "a".repeat(64),
            searchProviderKind: "opensearch"
          }],
          nextCursor: null
        }),
        purgeSourceState: async () => undefined,
        cancelKnowledgeBaseWork
      },
      provider: { ...vectorPort(), deleteIndex, getIndexDefinition },
      selectedProviderKind: "opensearch",
      indexPrefix: "focowiki",
      pageSize: 100,
      maximumOperationPolls: 2,
      operationPollIntervalMs: 0
    });

    await expect(service.deleteKnowledgeBaseScope({
      knowledgeBaseId: "kb-empty",
      operationPublicId: "operation-delete-empty",
      cursor: null
    })).resolves.toEqual({ outcome: "completed", nextCursor: null });
    expect(getIndexDefinition).toHaveBeenCalledOnce();
    expect(deleteIndex).not.toHaveBeenCalled();
    expect(cancelKnowledgeBaseWork).toHaveBeenCalledOnce();
  });

  it("does not purge PostgreSQL state before the final provider vector page", async () => {
    const purgeSourceState = vi.fn(async () => undefined);
    const listSourceVectorPage = vi.fn()
      .mockResolvedValueOnce({
        items: [{
          semanticGenerationPublicId: "generation-a",
          mappingFingerprintSha256: "a".repeat(64),
          searchProviderKind: "opensearch" as const,
          documentIds: ["vector-a"]
        }],
        nextCursor: "generation-a:vector-a"
      })
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    const service = createSemanticDeletionService({
      repository: {
        listSourceVectorPage,
        listKnowledgeBaseGenerationPage: async () => ({ items: [], nextCursor: null }),
        purgeSourceState,
        cancelKnowledgeBaseWork: async () => 0
      },
      provider: vectorPort(),
      selectedProviderKind: "opensearch",
      indexPrefix: "focowiki",
      pageSize: 1,
      maximumOperationPolls: 2,
      operationPollIntervalMs: 0
    });
    const first = await service.deleteSourceScope({
      knowledgeBaseId: "kb-a",
      operationPublicId: "operation-delete",
      sourceFilePublicIds: ["file-a"],
      cursor: null
    });
    expect(first).toEqual({
      outcome: "continue",
      nextCursor: "generation-a:vector-a"
    });
    expect(purgeSourceState).not.toHaveBeenCalled();
    await expect(service.deleteSourceScope({
      knowledgeBaseId: "kb-a",
      operationPublicId: "operation-delete",
      sourceFilePublicIds: ["file-a"],
      cursor: first.nextCursor
    })).resolves.toEqual({ outcome: "completed", nextCursor: null });
    expect(purgeSourceState).toHaveBeenCalledOnce();
  });

  it("rejects a provider mismatch before deleting any semantic vector", async () => {
    const deleteDocuments = vi.fn(async () => ({ state: "completed" as const }));
    const service = createSemanticDeletionService({
      repository: {
        listSourceVectorPage: async () => ({
          items: [{
            semanticGenerationPublicId: "generation-a",
            mappingFingerprintSha256: "a".repeat(64),
            searchProviderKind: "meilisearch",
            documentIds: ["vector-a"]
          }],
          nextCursor: null
        }),
        listKnowledgeBaseGenerationPage: async () => ({ items: [], nextCursor: null }),
        purgeSourceState: async () => undefined,
        cancelKnowledgeBaseWork: async () => 0
      },
      provider: { ...vectorPort(), deleteDocuments },
      selectedProviderKind: "opensearch",
      indexPrefix: "focowiki",
      pageSize: 10,
      maximumOperationPolls: 2,
      operationPollIntervalMs: 0
    });
    await expect(service.deleteSourceScope({
      knowledgeBaseId: "kb-a",
      operationPublicId: "operation-delete",
      sourceFilePublicIds: ["file-a"],
      cursor: null
    })).rejects.toMatchObject({
      code: "semantic_search_provider_required",
      retryable: true,
      requiredProviderKind: "meilisearch"
    });
    expect(deleteDocuments).not.toHaveBeenCalled();
  });
});

function vectorPort(): any {
  return {
    createIndex: async () => ({ state: "completed" as const }),
    deleteIndex: async () => ({ state: "completed" as const }),
    getIndexDefinition: async () => null,
    writeDocuments: async () => ({ state: "completed" as const }),
    deleteDocuments: async () => ({ state: "completed" as const }),
    query: async () => ({ hits: [], processingTimeMs: 0 }),
    count: async () => 0,
    scan: async () => ({ documents: [], continuation: null }),
    validate: async () => ({ valid: true, documentCount: 0 }),
    activateCandidate: async () => ({ state: "completed" as const }),
    getOperation: async () => ({ state: "completed" as const }),
    findOperationByCorrelation: async () => null
  };
}
