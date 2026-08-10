import { describe, expect, it, vi } from "vitest";
import type {
  SearchProviderVectorDocument,
  SearchProviderVectorPort
} from "../src/application/ports/search-provider-runtime.js";
import { createValidatedSearchProviderVectorPort } from
  "../src/semantic/vector/provider-contract.js";

describe("semantic vector provider contract", () => {
  it("accepts bounded provider-neutral documents and ordered evidence hits", async () => {
    const writeDocuments = vi.fn(async () => ({ state: "completed" as const }));
    const raw = rawPort({
      writeDocuments,
      query: async () => ({
        hits: [{
          documentId: "vector-1",
          sourceFilePublicId: "file-1",
          sourceRevisionPublicId: "revision-1",
          ownerPublicId: "owner-1",
          family: "entity",
          evidenceTargetPath: "documents/source.md",
          sourceExcerpt: "Entity evidence",
          rank: 1
        }],
        processingTimeMs: 3
      })
    });
    const port = createValidatedSearchProviderVectorPort(raw);
    await expect(port.writeDocuments({
      indexUid: "semantic-candidate-1",
      definition: definition(3),
      documents: [document([0.1, 0.2, 0.3])],
      correlation: "operation-1"
    })).resolves.toEqual({ state: "completed" });
    expect(writeDocuments).toHaveBeenCalledOnce();
    await expect(port.query({
      indexUid: "semantic-candidate-1",
      knowledgeBaseId: "kb-1",
      semanticGenerationPublicId: "generation-1",
      embeddingConfigurationRevisionPublicId: "embedding-1",
      family: "entity",
      dimension: 3,
      vector: [0.1, 0.2, 0.3],
      limit: 10,
      deadlineMs: 1_000
    })).resolves.toMatchObject({ hits: [{ documentId: "vector-1", rank: 1 }] });
  });

  it("rejects mixed dimensions, non-finite vectors, unsafe evidence, and cross-scope hits", async () => {
    const port = createValidatedSearchProviderVectorPort(rawPort());
    for (const invalid of [
      document([0.1, 0.2]),
      document([0.1, Number.NaN, 0.3]),
      { ...document([0.1, 0.2, 0.3]), evidenceTargetPath: "../private.md" }
    ]) {
      await expect(port.writeDocuments({
        indexUid: "semantic-candidate-1",
        definition: definition(3),
        documents: [invalid],
        correlation: "operation-1"
      })).rejects.toMatchObject({ code: "SEARCH_ENGINE_MAPPING_INVALID" });
    }
    for (const invalid of [
      { ...document([0.1, 0.2, 0.3]), sourceFilePublicId: "" },
      { ...document([0.1, 0.2, 0.3]), sourceRevisionPublicId: "" }
    ]) {
      await expect(port.writeDocuments({
        indexUid: "semantic-candidate-1",
        definition: definition(3),
        documents: [invalid],
        correlation: "operation-1"
      })).rejects.toMatchObject({ code: "SEARCH_ENGINE_REQUEST_FAILED" });
    }

    const crossScope = createValidatedSearchProviderVectorPort(rawPort({
      query: async () => ({
        hits: [{
          documentId: "vector-1",
          sourceFilePublicId: "file-1",
          sourceRevisionPublicId: "revision-1",
          ownerPublicId: "owner-1",
          family: "community",
          evidenceTargetPath: "documents/source.md",
          sourceExcerpt: "Community evidence",
          rank: 1
        }],
        processingTimeMs: 1
      })
    }));
    await expect(crossScope.query({
      indexUid: "semantic-candidate-1",
      knowledgeBaseId: "kb-1",
      semanticGenerationPublicId: "generation-1",
      embeddingConfigurationRevisionPublicId: "embedding-1",
      family: "entity",
      dimension: 3,
      vector: [0.1, 0.2, 0.3],
      limit: 10,
      deadlineMs: 1_000
    })).rejects.toMatchObject({ code: "SEARCH_ENGINE_REQUEST_FAILED" });
  });

  it("bounds deletes, scans, counts, validation, and candidate activation", async () => {
    const port = createValidatedSearchProviderVectorPort(rawPort());
    await expect(port.createIndex({
      indexUid: "semantic-candidate-1",
      definition: definition(3)
    })).resolves.toEqual({ state: "completed" });
    await expect(port.getIndexDefinition({ indexUid: "semantic-candidate-1" }))
      .resolves.toEqual(definition(3));
    await expect(port.count({
      indexUid: "semantic-candidate-1",
      knowledgeBaseId: "kb-1",
      semanticGenerationPublicId: "generation-1",
      family: "entity"
    })).resolves.toBe(0);
    await expect(port.scan({
      indexUid: "semantic-candidate-1",
      knowledgeBaseId: "kb-1",
      semanticGenerationPublicId: "generation-1",
      continuation: null,
      limit: 100
    })).resolves.toEqual({ documents: [], continuation: null });
    await expect(port.validate({
      indexUid: "semantic-candidate-1",
      definition: definition(3),
      expectedDocumentCount: 0
    })).resolves.toEqual({ valid: true, documentCount: 0 });
    await expect(port.deleteDocuments({
      indexUid: "semantic-candidate-1",
      knowledgeBaseId: "kb-1",
      semanticGenerationPublicId: "generation-1",
      documentIds: [],
      correlation: "operation-1"
    })).rejects.toMatchObject({ code: "SEARCH_ENGINE_REQUEST_FAILED" });
    await expect(port.scan({
      indexUid: "semantic-candidate-1",
      knowledgeBaseId: "kb-1",
      semanticGenerationPublicId: "generation-1",
      continuation: null,
      limit: 1_001
    })).rejects.toMatchObject({ code: "SEARCH_ENGINE_REQUEST_FAILED" });
    await expect(port.validate({
      indexUid: "semantic-candidate-1",
      definition: definition(3),
      expectedDocumentCount: -1
    })).rejects.toMatchObject({ code: "SEARCH_ENGINE_REQUEST_FAILED" });
    await expect(port.activateCandidate({
      knowledgeBaseId: "kb-1",
      candidateIndexUid: "semantic-candidate-1",
      expectedActiveIndexUid: null,
      correlation: "operation-1"
    })).resolves.toEqual({ state: "completed" });
    await expect(port.getOperation({ operationRef: "provider:123" }))
      .resolves.toEqual({ state: "completed" });
    await expect(port.findOperationByCorrelation({
      indexUid: "semantic-candidate-1",
      correlation: "operation-1"
    })).resolves.toEqual({ state: "completed" });
  });
});

function definition(dimension: number) {
  return {
    schemaVersion: "semantic-vector-v1",
    dimension,
    similarity: "cosine" as const,
    families: ["content", "entity", "relationship", "community"] as const,
    mappingFingerprintSha256: "a".repeat(64)
  };
}

function document(vector: readonly number[]): SearchProviderVectorDocument {
  return {
    id: "vector-1",
    knowledgeBaseId: "kb-1",
    semanticGenerationPublicId: "generation-1",
    ownerPublicId: "owner-1",
    family: "entity",
    sourceFilePublicId: "file-1",
    sourceRevisionPublicId: "revision-1",
    embeddingConfigurationRevisionPublicId: "embedding-1",
    evidenceTargetPath: "documents/source.md",
    vector
  };
}

function rawPort(overrides: Partial<SearchProviderVectorPort> = {}): SearchProviderVectorPort {
  return {
    createIndex: async () => ({ state: "completed" }),
    deleteIndex: async () => ({ state: "completed" }),
    getIndexDefinition: async () => definition(3),
    writeDocuments: async () => ({ state: "completed" }),
    deleteDocuments: async () => ({ state: "completed" }),
    query: async () => ({ hits: [], processingTimeMs: 0 }),
    count: async () => 0,
    scan: async () => ({ documents: [], continuation: null }),
    validate: async () => ({ valid: true, documentCount: 0 }),
    activateCandidate: async () => ({ state: "completed" }),
    getOperation: async () => ({ state: "completed" }),
    findOperationByCorrelation: async () => ({ state: "completed" }),
    ...overrides
  };
}
