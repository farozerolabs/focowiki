import { describe, expect, it, vi } from "vitest";
import { createSemanticEmbeddingStageHandler } from
  "../src/semantic/application/embedding-stage-handler.js";

describe("semantic embedding stage handler", () => {
  it("embeds only content and semantic facts owned by the claimed revision", async () => {
    const resolveMany = vi.fn(async (requests: any[]) => requests.map((request) => ({
      artifact: { publicId: `artifact-${request.embeddingInput.ownerPublicId}` },
      vector: [1, 0, 0],
      reused: request.embeddingInput.inputKind === "entity"
    })));
    const handler = createSemanticEmbeddingStageHandler({
      catalog: catalog(),
      bodyStore: { readVerifiedStream: async () => chunks(Buffer.from("# Alpha", "utf8")) },
      sourceInputs: {
        listSourceInputs: async () => ({
          entities: [{
            ownerPublicId: "entity-a", label: "Alpha", kind: "concept",
            description: null, evidenceTargets: [target()]
          }],
          relationships: [{
            ownerPublicId: "relationship-a", sourceLabel: "Alpha",
            targetLabel: "Beta", description: "Alpha uses Beta.",
            evidenceTargets: [target()]
          }],
          communities: [{
            ownerPublicId: "community-a", summary: "Alpha and Beta are connected.",
            evidenceTargets: [target()]
          }]
        })
      },
      resolveConfiguration: async () => configuration(),
      artifacts: { resolveMany } as any
    });
    await expect(handler(claim())).resolves.toMatchObject({
      checkpoint: {
        inputCount: 4,
        contentInputCount: 1,
        entityInputCount: 1,
        relationshipInputCount: 1,
        communityInputCount: 1,
        artifactCount: 4
      },
      reusedArtifactCount: 1
    });
    expect(resolveMany).toHaveBeenCalledOnce();
    expect(resolveMany.mock.calls[0]![0]
      .map((request: any) => request.embeddingInput.inputKind).sort())
      .toEqual(["community", "content", "entity", "relationship"]);
    expect(resolveMany.mock.calls[0]![0].every((request: any) =>
      request.semanticGenerationPublicId === "generation-a"
      && request.embeddingInput.sourceRevisionPublicId === "revision-a"
    )).toBe(true);
  });

  it("embeds an operation-owned candidate revision before final activation", async () => {
    const candidateCatalog = catalog();
    candidateCatalog.getSourceFile = async () => ({
      publicId: "file-a", logicalPath: "alpha.md",
      currentRevisionPublicId: "revision-old"
    });
    candidateCatalog.getCurrentSourceRevision = async () => ({
      publicId: "revision-old"
    });
    const isOwnedRevision = vi.fn(async () => true);
    const handler = createSemanticEmbeddingStageHandler({
      catalog: candidateCatalog,
      isOwnedRevision,
      bodyStore: {
        readVerifiedStream: async () => chunks(Buffer.from("# Alpha", "utf8"))
      },
      sourceInputs: {
        listSourceInputs: async () => ({
          entities: [], relationships: [], communities: []
        })
      },
      resolveConfiguration: async () => configuration(),
      artifacts: {
        resolveMany: async (requests: any[]) => requests.map((request) => ({
          artifact: { publicId: `artifact-${request.embeddingInput.ownerPublicId}` },
          vector: [1, 0, 0], reused: false
        }))
      } as any
    });

    await expect(handler(claim())).resolves.toMatchObject({
      checkpoint: { sourceRevisionPublicId: "revision-a", contentInputCount: 1 }
    });
    expect(isOwnedRevision).toHaveBeenCalledWith(claim());
  });
});

function claim(): any {
  return {
    publicId: "stage-a", knowledgeBaseId: "kb-a", operationPublicId: "operation-a",
    semanticGenerationPublicId: "generation-a", sourceFilePublicId: "file-a",
    sourceRevisionPublicId: "revision-a", stageKind: "embedding", partitionKey: "file-a",
    extractionContractVersion: "extract-v1",
    embeddingConfigurationRevisionPublicId: "embedding-revision-a",
    settingsSnapshot: {
      maximumSourceBytes: 1024, maximumChunkCharacters: 128,
      maximumChunks: 4, maximumEvidenceTargets: 4,
      maximumEmbeddingCharacters: 1024, resolvedDimension: 3,
      normalization: "l2", semanticGenerationRole: "active"
    },
    maximumAttempts: 3, state: "running", attemptCount: 1,
    checkpoint: {}, leaseOwner: "worker-a",
    leaseExpiresAt: "2026-08-08T00:01:00.000Z",
    cancellationRequestedAt: null, revision: 1
  };
}

function catalog(): any {
  const revision = {
    publicId: "revision-a", sourceFilePublicId: "file-a", objectId: "source-a",
    checksum: "a".repeat(64), byteCount: 7,
    contentType: "text/markdown; charset=utf-8"
  };
  return {
    getSourceFile: async () => ({
      publicId: "file-a", logicalPath: "alpha.md", currentRevisionPublicId: "revision-a"
    }),
    getSourceRevision: async () => revision,
    getCurrentSourceRevision: async () => revision
  };
}

function configuration(): any {
  return {
    revisionPublicId: "embedding-revision-a", validationStatus: "valid",
    resolvedDimension: 3, normalization: "l2", concurrency: 2
  };
}

function target() {
  return {
    sourceFilePublicId: "file-a", sourceRevisionPublicId: "revision-a",
    evidencePublicId: "evidence-a", logicalPath: "alpha.md"
  };
}

async function* chunks(value: Uint8Array) { yield value; }
