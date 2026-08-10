import { describe, expect, it, vi } from "vitest";
import { semanticVectorPlanSourcesAreCurrent } from
  "../src/semantic/application/vector-current-ownership.js";
import { planSemanticVectorProjection } from
  "../src/semantic/vector/projection-planner.js";

describe("semantic vector current source ownership", () => {
  it("accepts only the current visible source revision", async () => {
    const catalog = catalogFixture("revision-a");
    await expect(semanticVectorPlanSourcesAreCurrent(catalog, plan()))
      .resolves.toBe(true);
    expect(catalog.getSourceFile).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-a",
      publicId: "file-a",
      visibility: "current"
    });
  });

  it.each([
    ["deleted", null, "revision-a"],
    ["superseded", { publicId: "file-a" }, "revision-b"]
  ] as const)("rejects late output for a %s source", async (_, source, revision) => {
    const catalog = catalogFixture(revision, source);
    await expect(semanticVectorPlanSourcesAreCurrent(catalog, plan()))
      .resolves.toBe(false);
  });
});

function catalogFixture(
  currentRevisionPublicId: string,
  source: { publicId: string } | null = { publicId: "file-a" }
) {
  return {
    getSourceFile: vi.fn(async () => source),
    getCurrentSourceRevision: vi.fn(async () => ({
      publicId: currentRevisionPublicId
    }))
  } as any;
}

function plan() {
  return planSemanticVectorProjection({
    indexPrefix: "focowiki",
    knowledgeBaseId: "kb-a",
    semanticGenerationPublicId: "generation-a",
    projectionContractPublicId: "projection-a",
    embeddingConfigurationRevisionPublicId: "embedding-a",
    dimension: 3,
    mappingFingerprintSha256: "a".repeat(64),
    upserts: [{
      publicId: "vector-a",
      ownerPublicId: "entity-a",
      family: "entity",
      sourceFilePublicId: "file-a",
      sourceRevisionPublicId: "revision-a",
      artifactPublicId: "artifact-a",
      evidenceTargetPath: "Alpha.md",
      sourceExcerpt: "Source-grounded Alpha evidence.",
      fileKind: "page",
      okfStatus: null,
      okfTrustTier: null,
      okfStaleAfterEpochDay: null,
      vector: [1, 0, 0]
    }],
    deletes: []
  });
}
