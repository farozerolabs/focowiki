import { describe, expect, it, vi } from "vitest";
import { createSemanticVectorProjectionService } from
  "../src/semantic/vector/projection-service.js";
import { planSemanticVectorProjection } from
  "../src/semantic/vector/projection-planner.js";
import type { SearchProviderVectorPort } from
  "../src/application/ports/search-provider-runtime.js";

describe("semantic vector projection service", () => {
  it("registers ownership before bounded provider impacts and never scans the corpus", async () => {
    const events: string[] = [];
    const provider = providerStub({
      getIndexDefinition: async () => null,
      createIndex: async () => {
        events.push("create-index");
        return { state: "completed" };
      },
      writeDocuments: async (input) => {
        events.push(`write:${input.documents.length}`);
        return { state: "completed" };
      },
      deleteDocuments: async (input) => {
        events.push(`delete:${input.documentIds.length}`);
        return { state: "completed" };
      },
      scan: async () => {
        throw new Error("full scan must not run");
      }
    });
    const service = createSemanticVectorProjectionService({
      provider,
      repository: {
        listSourceDocuments: async () => [],
        prepareImpacts: async (input) => {
          events.push(`prepare:${input.plan.desiredDocuments.length}`);
          return { prepared: 1, deleted: 1 };
        },
        confirmImpacts: async () => {
          events.push("confirm");
          return true;
        }
      },
      isCurrent: async () => true
    });
    await expect(service.apply(plan())).resolves.toEqual({
      upserted: 1,
      deleted: 1,
      enumeratedCorpus: 0
    });
    expect(events).toEqual([
      "prepare:1", "create-index", "write:1", "delete:1", "confirm"
    ]);
  });

  it("rejects late provider output before confirmation and polls bounded receipts", async () => {
    let currentChecks = 0;
    const getOperation = vi.fn(async () => ({ state: "completed" as const }));
    const deleteDocuments = vi.fn(async () => ({ state: "completed" as const }));
    const service = createSemanticVectorProjectionService({
      provider: providerStub({
        writeDocuments: async () => ({ state: "pending", operationRef: "provider:1" }),
        deleteDocuments,
        getOperation
      }),
      repository: {
        listSourceDocuments: async () => [],
        prepareImpacts: async () => ({ prepared: 1, deleted: 1 }),
        confirmImpacts: vi.fn(async () => true)
      },
      isCurrent: async () => ++currentChecks < 3,
      maximumOperationPolls: 2,
      wait: async () => undefined
    });
    await expect(service.apply(plan())).rejects.toMatchObject({
      code: "semantic_vector_superseded"
    });
    expect(getOperation).toHaveBeenCalledOnce();
    expect(deleteDocuments).toHaveBeenCalledOnce();
    expect(deleteDocuments).toHaveBeenCalledWith(expect.objectContaining({
      documentIds: ["vector-entity-1"],
      knowledgeBaseId: "kb-main",
      semanticGenerationPublicId: "generation-main",
      correlation: expect.stringContaining(":late-output")
    }));
  });

  it("accepts an equivalent provider mapping regardless of JSON field order", async () => {
    const expected = plan().definition;
    const writeDocuments = vi.fn(async () => ({ state: "completed" as const }));
    const service = createSemanticVectorProjectionService({
      provider: providerStub({
        getIndexDefinition: async () => ({
          mappingFingerprintSha256: expected.mappingFingerprintSha256,
          families: [...expected.families],
          dimension: expected.dimension,
          similarity: expected.similarity,
          schemaVersion: expected.schemaVersion
        }),
        writeDocuments
      }),
      repository: {
        listSourceDocuments: async () => [],
        prepareImpacts: async () => ({ prepared: 1, deleted: 1 }),
        confirmImpacts: async () => true
      },
      isCurrent: async () => true
    });

    await expect(service.apply(plan())).resolves.toEqual({
      upserted: 1,
      deleted: 1,
      enumeratedCorpus: 0
    });
    expect(writeDocuments).toHaveBeenCalledOnce();
  });

  it("accepts a concurrent matching index creation completed by another worker", async () => {
    const expected = plan().definition;
    const getIndexDefinition = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(expected);
    const createIndex = vi.fn(async () => {
      throw new Error("index already exists");
    });
    const writeDocuments = vi.fn(async () => ({ state: "completed" as const }));
    const service = createSemanticVectorProjectionService({
      provider: providerStub({ getIndexDefinition, createIndex, writeDocuments }),
      repository: {
        listSourceDocuments: async () => [],
        prepareImpacts: async () => ({ prepared: 1, deleted: 1 }),
        confirmImpacts: async () => true
      },
      isCurrent: async () => true
    });

    await expect(service.apply(plan())).resolves.toEqual({
      upserted: 1,
      deleted: 1,
      enumeratedCorpus: 0
    });
    expect(getIndexDefinition).toHaveBeenCalledTimes(2);
    expect(createIndex).toHaveBeenCalledOnce();
    expect(writeDocuments).toHaveBeenCalledOnce();
  });
});

function plan() {
  return planSemanticVectorProjection({
    indexPrefix: "focowiki",
    knowledgeBaseId: "kb-main",
    semanticGenerationPublicId: "generation-main",
    projectionContractPublicId: "contract-main",
    embeddingConfigurationRevisionPublicId: "embedding-revision-1",
    dimension: 3,
    mappingFingerprintSha256: "a".repeat(64),
    upserts: [{
      publicId: "vector-entity-1",
      ownerPublicId: "entity-1",
      family: "entity",
      sourceFilePublicId: "file-1",
      sourceRevisionPublicId: "revision-1",
      artifactPublicId: "artifact-1",
      evidenceTargetPath: "sources/file-1.md",
      sourceExcerpt: "Source-grounded evidence.",
      fileKind: "page",
      okfStatus: null,
      okfTrustTier: null,
      okfStaleAfterEpochDay: null,
      vector: [0.1, 0.2, 0.3]
    }],
    deletes: [{ publicId: "vector-old-1", ownerPublicId: "entity-old" }]
  });
}

function providerStub(
  overrides: Partial<SearchProviderVectorPort> = {}
): SearchProviderVectorPort {
  return {
    createIndex: async () => ({ state: "completed" }),
    deleteIndex: async () => ({ state: "completed" }),
    getIndexDefinition: async () => plan().definition,
    writeDocuments: async () => ({ state: "completed" }),
    deleteDocuments: async () => ({ state: "completed" }),
    query: async () => ({ hits: [], processingTimeMs: 0 }),
    count: async () => 0,
    scan: async () => ({ documents: [], continuation: null }),
    validate: async () => ({ valid: true, documentCount: 0 }),
    activateCandidate: async () => ({ state: "completed" }),
    getOperation: async () => ({ state: "completed" }),
    findOperationByCorrelation: async () => null,
    ...overrides
  };
}
