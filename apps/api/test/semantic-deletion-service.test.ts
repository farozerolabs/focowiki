import { describe, expect, it, vi } from "vitest";
import { createSemanticDeletionService } from
  "../src/semantic/application/deletion-service.js";

describe("semantic deletion service", () => {
  it("waits for running source work before reading or deleting vector state", async () => {
    const listSourceVectorPage = vi.fn(async () => ({ items: [], nextCursor: null }));
    const deleteDocuments = vi.fn(async () => ({ state: "completed" as const }));
    const purgeSourceState = vi.fn(async () => undefined);
    const cancelSourceWork = vi.fn(async () => 1);
    const service = createSemanticDeletionService({
      repository: {
        cancelSourceWork,
        hasRunningSourceWork: async () => true,
        hasRunningKnowledgeBaseWork: async () => false,
        deferUnavailableSourceVectors: async () => 0,
        listSourceVectorPage,
        listKnowledgeBaseGenerationPage: async () => ({
          items: [], nextCursor: null, remainingProviderKind: null
        }),
        purgeSourceState,
        cancelKnowledgeBaseWork: async () => 0
      } as any,
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
    })).resolves.toEqual({ outcome: "blocked", nextCursor: null });
    expect(cancelSourceWork).toHaveBeenCalledOnce();
    expect(listSourceVectorPage).not.toHaveBeenCalled();
    expect(deleteDocuments).not.toHaveBeenCalled();
    expect(purgeSourceState).not.toHaveBeenCalled();
  });

  it("waits for running knowledge-base work before deleting vector indexes", async () => {
    const listKnowledgeBaseGenerationPage = vi.fn(async () => ({
      items: [], nextCursor: null
    }));
    const deleteIndex = vi.fn(async () => ({ state: "completed" as const }));
    const cancelKnowledgeBaseWork = vi.fn(async () => 1);
    const service = createSemanticDeletionService({
      repository: {
        cancelSourceWork: async () => 0,
        hasRunningSourceWork: async () => false,
        hasRunningKnowledgeBaseWork: async () => true,
        deferUnavailableSourceVectors: async () => 0,
        listSourceVectorPage: async () => ({ items: [], nextCursor: null }),
        listKnowledgeBaseGenerationPage,
        purgeSourceState: async () => undefined,
        cancelKnowledgeBaseWork
      } as any,
      provider: { ...vectorPort(), deleteIndex },
      selectedProviderKind: "opensearch",
      indexPrefix: "focowiki",
      pageSize: 100,
      maximumOperationPolls: 2,
      operationPollIntervalMs: 0,
      clock: () => "2027-08-08T00:00:00.000Z"
    });

    await expect(service.deleteKnowledgeBaseScope({
      knowledgeBaseId: "kb-a", operationPublicId: "operation-delete",
      cursor: null, completedProviderKind: null
    })).resolves.toEqual({ outcome: "blocked", nextCursor: null });
    expect(cancelKnowledgeBaseWork).toHaveBeenCalledOnce();
    expect(listKnowledgeBaseGenerationPage).not.toHaveBeenCalled();
    expect(deleteIndex).not.toHaveBeenCalled();
  });

  it("deletes a bounded source vector page before purging durable state", async () => {
    const deleteDocuments = vi.fn(async () => ({ state: "completed" as const }));
    const purgeSourceState = vi.fn(async () => undefined);
    const service = createSemanticDeletionService({
      repository: {
        cancelSourceWork: async () => 0,
        hasRunningSourceWork: async () => false,
        hasRunningKnowledgeBaseWork: async () => false,
        deferUnavailableSourceVectors: async () => 0,
        listSourceVectorPage: async () => ({
          items: [{
            semanticGenerationPublicId: "generation-a",
            mappingFingerprintSha256: "a".repeat(64),
            searchProviderKind: "opensearch",
            documentIds: ["vector-a"]
          }],
          nextCursor: null
        }),
        listKnowledgeBaseGenerationPage: async () => ({
          items: [], nextCursor: null, remainingProviderKind: null
        }),
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
        cancelSourceWork: async () => 0,
        hasRunningSourceWork: async () => false,
        hasRunningKnowledgeBaseWork: async () => false,
        deferUnavailableSourceVectors: async () => 0,
        listSourceVectorPage: async () => ({ items: [], nextCursor: null }),
        listKnowledgeBaseGenerationPage: async () => ({
          items: [{
            semanticGenerationPublicId: "generation-a",
            mappingFingerprintSha256: "a".repeat(64),
            searchProviderKind: "meilisearch"
          }],
          nextCursor: null,
          remainingProviderKind: null
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
      cursor: null, completedProviderKind: null
    })).resolves.toEqual({ outcome: "completed", nextCursor: null });
    expect(deleteIndex).toHaveBeenCalledOnce();
    expect(cancelKnowledgeBaseWork).toHaveBeenCalledOnce();
  });

  it("finishes the selected provider before requesting the remaining provider", async () => {
    const deleteIndex = vi.fn(async () => ({ state: "completed" as const }));
    const listKnowledgeBaseGenerationPage = vi.fn(async () => ({
      items: [{
        semanticGenerationPublicId: "generation-opensearch",
        mappingFingerprintSha256: "a".repeat(64),
        searchProviderKind: "opensearch" as const
      }],
      nextCursor: null,
      remainingProviderKind: "meilisearch" as const
    }));
    const service = createSemanticDeletionService({
      repository: {
        cancelSourceWork: async () => 0,
        hasRunningSourceWork: async () => false,
        hasRunningKnowledgeBaseWork: async () => false,
        deferUnavailableSourceVectors: async () => 0,
        listSourceVectorPage: async () => ({ items: [], nextCursor: null }),
        listKnowledgeBaseGenerationPage,
        purgeSourceState: async () => undefined,
        cancelKnowledgeBaseWork: async () => 0
      } as any,
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
      selectedProviderKind: "opensearch",
      indexPrefix: "focowiki",
      pageSize: 100,
      maximumOperationPolls: 2,
      operationPollIntervalMs: 0
    });

    await expect(service.deleteKnowledgeBaseScope({
      knowledgeBaseId: "kb-mixed-provider",
      operationPublicId: "operation-delete-mixed-provider",
      cursor: null,
      completedProviderKind: null
    } as any)).resolves.toEqual({
      outcome: "provider_required",
      nextCursor: null,
      completedProviderKind: "opensearch",
      requiredProviderKind: "meilisearch"
    });
    expect(listKnowledgeBaseGenerationPage).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-mixed-provider",
      selectedProviderKind: "opensearch",
      cursor: null,
      limit: 100
    });
    expect(deleteIndex).toHaveBeenCalledOnce();
  });

  it("does not request a provider that the deletion checkpoint already completed", async () => {
    const service = createSemanticDeletionService({
      repository: {
        cancelSourceWork: async () => 0,
        hasRunningSourceWork: async () => false,
        hasRunningKnowledgeBaseWork: async () => false,
        deferUnavailableSourceVectors: async () => 0,
        listSourceVectorPage: async () => ({ items: [], nextCursor: null }),
        listKnowledgeBaseGenerationPage: async () => ({
          items: [],
          nextCursor: null,
          remainingProviderKind: "opensearch"
        }),
        purgeSourceState: async () => undefined,
        cancelKnowledgeBaseWork: async () => 0
      },
      provider: vectorPort(),
      selectedProviderKind: "meilisearch",
      indexPrefix: "focowiki",
      pageSize: 100,
      maximumOperationPolls: 2,
      operationPollIntervalMs: 0
    });

    await expect(service.deleteKnowledgeBaseScope({
      knowledgeBaseId: "kb-mixed-provider",
      operationPublicId: "operation-delete-mixed-provider",
      cursor: null,
      completedProviderKind: "opensearch"
    })).resolves.toEqual({ outcome: "completed", nextCursor: null });
  });

  it("treats an uncreated knowledge-base vector index as already deleted", async () => {
    const deleteIndex = vi.fn(async () => ({ state: "completed" as const }));
    const getIndexDefinition = vi.fn(async () => null);
    const cancelKnowledgeBaseWork = vi.fn(async () => 1);
    const service = createSemanticDeletionService({
      repository: {
        cancelSourceWork: async () => 0,
        hasRunningSourceWork: async () => false,
        hasRunningKnowledgeBaseWork: async () => false,
        deferUnavailableSourceVectors: async () => 0,
        listSourceVectorPage: async () => ({ items: [], nextCursor: null }),
        listKnowledgeBaseGenerationPage: async () => ({
          items: [{
            semanticGenerationPublicId: "generation-empty",
            mappingFingerprintSha256: "a".repeat(64),
            searchProviderKind: "opensearch"
          }],
          nextCursor: null,
          remainingProviderKind: null
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
      cursor: null,
      completedProviderKind: null
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
        cancelSourceWork: async () => 0,
        hasRunningSourceWork: async () => false,
        hasRunningKnowledgeBaseWork: async () => false,
        deferUnavailableSourceVectors: async () => 0,
        listSourceVectorPage,
        listKnowledgeBaseGenerationPage: async () => ({
          items: [], nextCursor: null, remainingProviderKind: null
        }),
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

  it("defers unavailable-provider vectors before deleting selected-provider vectors", async () => {
    const deleteDocuments = vi.fn(async () => ({ state: "completed" as const }));
    const deferUnavailableSourceVectors = vi.fn(async () => 1);
    const purgeSourceState = vi.fn(async () => undefined);
    const service = createSemanticDeletionService({
      repository: {
        cancelSourceWork: async () => 0,
        hasRunningSourceWork: async () => false,
        hasRunningKnowledgeBaseWork: async () => false,
        deferUnavailableSourceVectors,
        listSourceVectorPage: async () => ({
          items: [{
            semanticGenerationPublicId: "generation-a",
            mappingFingerprintSha256: "a".repeat(64),
            searchProviderKind: "opensearch",
            documentIds: ["vector-current"]
          }],
          nextCursor: null
        }),
        listKnowledgeBaseGenerationPage: async () => ({
          items: [], nextCursor: null, remainingProviderKind: null
        }),
        purgeSourceState,
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
    })).resolves.toEqual({
      outcome: "completed",
      nextCursor: null
    });
    expect(deferUnavailableSourceVectors).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-a",
      operationPublicId: "operation-delete",
      sourceFilePublicIds: ["file-a"],
      selectedProviderKind: "opensearch",
      notBefore: expect.any(String)
    });
    expect(deleteDocuments).toHaveBeenCalledWith(expect.objectContaining({
      documentIds: ["vector-current"]
    }));
    expect(purgeSourceState).toHaveBeenCalledOnce();
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
