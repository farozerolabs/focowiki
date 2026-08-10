import { describe, expect, it, vi } from "vitest";
import { encodeVectorArtifact } from
  "../src/semantic/embedding/vector-artifact-codec.js";
import { createSemanticVectorStageHandler } from
  "../src/semantic/application/vector-stage-handler.js";

describe("semantic vector stage handler", () => {
  it("streams only source-owned artifacts and deletes only stale source documents", async () => {
    const encoded = encodeVectorArtifact({ vector: [1, 0, 0], normalization: "l2" });
    const applyPlan = vi.fn(async (plan: any) => plan.counters);
    const releaseSupersededSourceReferences = vi.fn(async () => 2);
    const handler = createSemanticVectorStageHandler({
      artifacts: {
        listSourceReferences: async () => [{
          artifact: {
            publicId: "artifact-a", knowledgeBaseId: "kb-a", ownerKind: "entity",
            ownerPublicId: "entity-a", sourceRevisionPublicId: "revision-a",
            canonicalInputSha256: "a".repeat(64), inputKind: "entity",
            embeddingConfigurationRevisionPublicId: "embedding-revision-a",
            normalization: "l2", dimension: 3,
            artifactSchemaVersion: "focowiki-vector-artifact-v1",
            objectId: "object-a", storageKey: "semantic/a.bin",
            vectorChecksumSha256: encoded.checksumSha256,
            byteCount: encoded.byteCount, state: "verified"
          },
          sourceFilePublicId: "file-a",
          evidenceTargetPath: "alpha.md",
          sourceExcerpt: "Source-grounded alpha evidence.",
          fileKind: "page",
          okfSignals: {
            status: "stable", trustTier: "human-reviewed",
            staleAfterEpochDay: 25_000,
            generatedAtEpochMs: null, latestVerifiedAtEpochMs: null,
            sourceCount: 1
          }
        }]
      },
      cleanup: { releaseSupersededSourceReferences },
      store: { readVerified: async () => encoded.bytes },
      projections: {
        listSourceDocuments: async () => [{
          publicId: "semantic-vector-stale", ownerPublicId: "entity-stale"
        }]
      },
      applyPlan,
      indexPrefix: "focowiki"
    });
    await expect(handler(claim())).resolves.toMatchObject({
      checkpoint: {
        artifactCount: 1,
        upsertedDocumentCount: 1,
        deletedDocumentCount: 1,
        releasedSupersededArtifactCount: 2,
        enumeratedCorpusCount: 0
      }
    });
    expect(applyPlan).toHaveBeenCalledOnce();
    const plan = applyPlan.mock.calls[0]![0];
    expect(plan.providerDocuments).toHaveLength(1);
    expect(plan.providerDocuments[0]).toMatchObject({
      sourceExcerpt: "Source-grounded alpha evidence.",
      fileKind: "page",
      okfStatus: "stable",
      okfTrustTier: "human-reviewed",
      okfStaleAfterEpochDay: 25_000
    });
    expect(plan.providerDeleteDocumentIds).toEqual(["semantic-vector-stale"]);
    expect(plan.fullCorpusRewriteAllowed).toBe(false);
    expect(releaseSupersededSourceReferences).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-a",
      semanticGenerationPublicId: "generation-a",
      sourceFilePublicId: "file-a",
      currentSourceRevisionPublicId: "revision-a",
      releasedAt: expect.any(String),
      limit: 10_000
    });
  });

  it("projects only the newest reference when a retry replaces an owner artifact", async () => {
    const encoded = encodeVectorArtifact({ vector: [1, 0, 0], normalization: "l2" });
    const artifact = (publicId: string) => ({
      publicId, knowledgeBaseId: "kb-a", ownerKind: "entity" as const,
      ownerPublicId: "entity-a", sourceRevisionPublicId: "revision-a",
      canonicalInputSha256: publicId === "artifact-new" ? "b".repeat(64) : "a".repeat(64),
      inputKind: "entity" as const,
      embeddingConfigurationRevisionPublicId: "embedding-revision-a",
      normalization: "l2" as const, dimension: 3,
      artifactSchemaVersion: "focowiki-vector-artifact-v1",
      objectId: `object-${publicId}`, storageKey: `semantic/${publicId}.bin`,
      vectorChecksumSha256: encoded.checksumSha256,
      byteCount: encoded.byteCount, state: "verified" as const
    });
    const applyPlan = vi.fn(async (plan: any) => plan.counters);
    const handler = createSemanticVectorStageHandler({
      artifacts: {
        listSourceReferences: async () => [
          {
            artifact: artifact("artifact-new"),
            sourceFilePublicId: "file-a",
            evidenceTargetPath: "alpha.md",
            sourceExcerpt: "Source-grounded alpha evidence.",
            fileKind: "page",
            okfSignals: emptyOkfSignals()
          },
          {
            artifact: artifact("artifact-old"),
            sourceFilePublicId: "file-a",
            evidenceTargetPath: "alpha.md",
            sourceExcerpt: "Source-grounded alpha evidence.",
            fileKind: "page",
            okfSignals: emptyOkfSignals()
          }
        ]
      },
      store: { readVerified: async () => encoded.bytes },
      projections: { listSourceDocuments: async () => [] },
      applyPlan,
      indexPrefix: "focowiki"
    });

    await expect(handler(claim())).resolves.toMatchObject({
      checkpoint: { artifactCount: 1, upsertedDocumentCount: 1 }
    });
    expect(applyPlan).toHaveBeenCalledOnce();
    expect(applyPlan.mock.calls[0]![0].desiredDocuments).toEqual([
      expect.objectContaining({ artifactPublicId: "artifact-new" })
    ]);
  });

  it("reuses vector bytes while applying a metadata-only filter override", async () => {
    const encoded = encodeVectorArtifact({ vector: [1, 0, 0], normalization: "l2" });
    const applyPlan = vi.fn(async (plan: any) => plan.counters);
    const handler = createSemanticVectorStageHandler({
      artifacts: {
        listSourceReferences: async () => [{
          artifact: {
            publicId: "artifact-a", knowledgeBaseId: "kb-a", ownerKind: "content",
            ownerPublicId: "content-a", sourceRevisionPublicId: "revision-a",
            canonicalInputSha256: "a".repeat(64), inputKind: "content",
            embeddingConfigurationRevisionPublicId: "embedding-revision-a",
            normalization: "l2", dimension: 3,
            artifactSchemaVersion: "focowiki-vector-artifact-v1",
            objectId: "object-a", storageKey: "semantic/a.bin",
            vectorChecksumSha256: encoded.checksumSha256,
            byteCount: encoded.byteCount, state: "verified"
          },
          sourceFilePublicId: "file-a",
          evidenceTargetPath: "alpha.md",
          sourceExcerpt: "Source-grounded alpha evidence.",
          fileKind: "page",
          okfSignals: {
            ...emptyOkfSignals(),
            status: "stable" as const,
            trustTier: "human-reviewed" as const
          }
        }]
      },
      store: { readVerified: vi.fn(async () => encoded.bytes) },
      projections: { listSourceDocuments: async () => [] },
      applyPlan,
      indexPrefix: "focowiki"
    });

    await handler({
      ...claim(),
      settingsSnapshot: {
        ...claim().settingsSnapshot,
        sourceFilterProjectionOverride: true,
        sourceOkfStatusOverride: "deprecated",
        sourceOkfTrustTierOverride: "unverified",
        sourceOkfStaleAfterEpochDayOverride: 31_000
      }
    });

    expect(applyPlan.mock.calls[0]![0].providerDocuments).toEqual([
      expect.objectContaining({
        okfStatus: "deprecated",
        okfTrustTier: "unverified",
        okfStaleAfterEpochDay: 31_000
      })
    ]);
    expect(applyPlan.mock.calls[0]![0].desiredDocuments).toEqual([
      expect.objectContaining({ artifactPublicId: "artifact-a" })
    ]);
  });
});

function claim(): any {
  return {
    publicId: "stage-a", knowledgeBaseId: "kb-a", operationPublicId: "operation-a",
    semanticGenerationPublicId: "generation-a", sourceFilePublicId: "file-a",
    sourceRevisionPublicId: "revision-a", stageKind: "vector", partitionKey: "file-a",
    extractionContractVersion: "extract-v1",
    embeddingConfigurationRevisionPublicId: "embedding-revision-a",
    settingsSnapshot: {
      resolvedDimension: 3, normalization: "l2",
      projectionContractPublicId: "projection-a",
      mappingFingerprintSha256: "b".repeat(64),
      vectorBatchDocumentCount: 100
    },
    maximumAttempts: 3, state: "running", attemptCount: 1,
    checkpoint: {}, leaseOwner: "worker-a",
    leaseExpiresAt: "2026-08-08T00:01:00.000Z",
    cancellationRequestedAt: null, revision: 1
  };
}

function emptyOkfSignals() {
  return {
    status: null, trustTier: null, staleAfterEpochDay: null,
    generatedAtEpochMs: null, latestVerifiedAtEpochMs: null, sourceCount: null
  };
}
