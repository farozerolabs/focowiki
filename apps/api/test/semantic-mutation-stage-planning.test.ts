import { describe, expect, it } from "vitest";
import { planSemanticMutationStages } from
  "../src/storage-vnext/mutation/postgres-release-hooks.js";
import type { SemanticSourceStageTarget } from
  "../src/semantic/application/source-handoff.js";

describe("semantic mutation stage planning", () => {
  it("queues the complete revision-bound chain for a body replacement", () => {
    expect(plan(true).map((item) => item.stageKind)).toEqual([
      "extraction",
      "reconciliation",
      "community",
      "embedding",
      "vector",
      "publication"
    ]);
    expect(plan(true).every((item) =>
      item.sourceRevisionPublicId === "revision-new"
      && item.semanticGenerationPublicId === "semantic-active"
    )).toBe(true);
  });

  it("reuses extraction and embedding for rename or move", () => {
    const stages = plan(false);
    expect(stages.map((item) => item.stageKind)).toEqual([
      "vector",
      "publication"
    ]);
    expect(stages.some((item) =>
      item.stageKind === "extraction" || item.stageKind === "embedding"
    )).toBe(false);
  });

  it("reuses artifacts and refreshes only vector and publication projections for metadata", () => {
    const stages = planSemanticMutationStages({
      knowledgeBaseId: "kb-a",
      operationPublicId: "operation-metadata",
      sourceFilePublicId: "file-a",
      sourceRevisionPublicId: "revision-current",
      mutationKind: "source_file_metadata",
      candidateMetadata: { status: "deprecated" },
      target: target()
    });

    expect(stages.map((item) => item.stageKind)).toEqual([
      "vector",
      "publication"
    ]);
    expect(stages.every((item) =>
      item.settingsSnapshot.sourceFilterProjectionOverride === true
      && item.settingsSnapshot.sourceOkfStatusOverride === "deprecated"
    )).toBe(true);
  });
});

function plan(bodyChanged: boolean) {
  return planSemanticMutationStages({
    knowledgeBaseId: "kb-a",
    operationPublicId: "operation-a",
    sourceFilePublicId: "file-a",
    sourceRevisionPublicId: "revision-new",
    mutationKind: bodyChanged ? "body_replacement" : "file_move",
    target: target()
  });
}

function target(): SemanticSourceStageTarget {
  return {
      semanticGenerationPublicId: "semantic-active",
      extractionContractVersion: "extract-v1",
      embeddingConfigurationRevisionPublicId: "embedding-revision-a",
      settingsSnapshot: {
        runtimeSettingsRevisionPublicId: "settings-a",
        generationModelConfigurationPublicId: "model-a",
        generationModelConfigurationRevision: 1,
        embeddingConfigurationRevisionPublicId: "embedding-revision-a",
        projectionContractPublicId: "projection-a",
        semanticGenerationRole: "active",
        searchProviderKind: "opensearch",
        resolvedDimension: 3,
        normalization: "l2",
        graphSchemaVersion: "graph-v1",
        promptContractVersion: "prompt-v1",
        mappingFingerprintSha256: "a".repeat(64),
        maximumChunkCharacters: 16_000,
        maximumChunks: 32,
        maximumEmbeddingCharacters: 32_000,
        maximumEvidenceTargets: 64,
        maximumCommunityPartitions: 256,
        maximumCommunityEntities: 10_000,
        maximumCommunityRelationships: 20_000,
        maximumCommunityBoundaryRelationships: 10_000,
        maximumCommunitySummaryCharacters: 8_000,
        communityAdapterTimeoutMs: 30_000,
      publicationDelayMilliseconds: 0,
      publicationMaximumDelayMilliseconds: 0,
        maximumSourceBytes: 16_777_216,
        vectorBatchDocumentCount: 100
      },
      maximumAttempts: 3
    };
}
