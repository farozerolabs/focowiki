import { describe, expect, it } from "vitest";
import { planSemanticVectorProjection } from
  "../src/semantic/vector/projection-planner.js";

describe("semantic vector projection planner", () => {
  it("pins active identity and projects only impacted vector owners", () => {
    const plan = planSemanticVectorProjection({
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
        okfStatus: "stable",
        okfTrustTier: "human-reviewed",
        okfStaleAfterEpochDay: 25_000,
        vector: [0.1, 0.2, 0.3]
      }],
      deletes: [{ publicId: "vector-old-1", ownerPublicId: "entity-old" }]
    });
    expect(plan.candidateIndexUid).toMatch(/^focowiki-semantic-[a-f0-9]{48}$/u);
    expect(plan.definition).toMatchObject({ dimension: 3, similarity: "cosine" });
    expect(plan.providerDocuments).toEqual([expect.objectContaining({
      id: "vector-entity-1",
      semanticGenerationPublicId: "generation-main",
      embeddingConfigurationRevisionPublicId: "embedding-revision-1",
      family: "entity",
      vector: [0.1, 0.2, 0.3]
    })]);
    expect(plan.providerDeleteDocumentIds).toEqual(["vector-old-1"]);
    expect(plan.counters).toEqual({ upserted: 1, deleted: 1, enumeratedCorpus: 0 });
    expect(plan.fullCorpusRewriteAllowed).toBe(false);
  });

  it("rejects duplicate owners, mixed dimensions, and a full-corpus sentinel", () => {
    const base = {
      indexPrefix: "focowiki",
      knowledgeBaseId: "kb-main",
      semanticGenerationPublicId: "generation-main",
      projectionContractPublicId: "contract-main",
      embeddingConfigurationRevisionPublicId: "embedding-revision-1",
      dimension: 3,
      mappingFingerprintSha256: "a".repeat(64),
      deletes: []
    } as const;
    const item = {
      publicId: "vector-entity-1",
      ownerPublicId: "entity-1",
      family: "entity" as const,
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
    };
    expect(() => planSemanticVectorProjection({
      ...base,
      upserts: [item, { ...item, publicId: "vector-entity-2" }]
    })).toThrow("duplicate owner");
    expect(() => planSemanticVectorProjection({
      ...base,
      upserts: [{ ...item, vector: [0.1, 0.2] }]
    })).toThrow("dimension");
    expect(() => planSemanticVectorProjection({
      ...base,
      upserts: [item],
      enumeratedCorpusCount: 1
    })).toThrow("full corpus");
  });
});
