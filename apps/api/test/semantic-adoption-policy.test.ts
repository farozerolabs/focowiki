import { describe, expect, it } from "vitest";
import { classifySemanticAdoption } from
  "../src/semantic/application/adoption-policy.js";
import { semanticContractFingerprint } from
  "../src/semantic/application/adoption.js";
import type { SemanticActiveProjectionRecord } from
  "../src/semantic/application/ports.js";
import type { SemanticMaintenanceTarget } from
  "../src/semantic/domain/contracts.js";

describe("semantic adoption policy", () => {
  it("requires full explicit adoption when no semantic generation is active", () => {
    expect(classifySemanticAdoption(null, target())).toBe("full");
  });

  it("does not enqueue adoption for the complete active contract", () => {
    const expected = target();
    expect(classifySemanticAdoption(active(expected), expected)).toBeNull();
  });

  it.each([
    ["generation model", { generationModelConfigurationRevision: 2 }],
    ["prompt", { promptContractVersion: "prompt-v2" }],
    ["extraction schema", { extractionContractVersion: "extraction-v2" }],
    ["graph schema", { graphSchemaVersion: "graph-v2" }],
    ["dimension", { resolvedDimension: 6 }],
    ["embedding model", {
      embeddingConfigurationRevisionPublicId: "embedding-revision-2"
    }],
    ["artifact schema", { artifactSchemaVersion: "artifact-v2" }],
    ["vector schema", { vectorSchemaVersion: "vector-v2" }]
  ])("requires full explicit adoption after a %s change", (_label, change) => {
    const current = target();
    expect(classifySemanticAdoption(
      active(current),
      { ...current, ...change }
    )).toBe("full");
  });

  it.each([
    ["provider", {
      searchProviderKind: "meilisearch" as const,
      mappingFingerprintSha256: "c".repeat(64)
    }],
    ["incompatible mapping", { mappingFingerprintSha256: "d".repeat(64) }]
  ])("uses provider-only adoption for a %s change with reusable artifacts", (
    _label,
    change
  ) => {
    const current = target();
    expect(classifySemanticAdoption(
      active(current),
      { ...current, ...change }
    )).toBe("provider_only");
  });

  it("uses query-policy-only adoption when only the vector threshold changes", () => {
    const current = target();
    expect(classifySemanticAdoption(active(current), {
      ...current,
      embeddingQueryPolicyRevisionPublicId: "embedding-revision-2",
      minimumVectorRelevance: 0.42
    })).toBe("query_policy_only");
  });

  it("requires full adoption if the stored contract fingerprint is inconsistent", () => {
    const current = target();
    expect(classifySemanticAdoption({
      ...active(current),
      contractFingerprintSha256: "f".repeat(64)
    }, current)).toBe("full");
  });
});

function target(): SemanticMaintenanceTarget {
  return {
    knowledgeBaseId: "kb-1",
    generationModelConfigurationPublicId: "model-1",
    generationModelConfigurationRevision: 1,
    extractionContractVersion: "extraction-v1",
    graphSchemaVersion: "graph-v1",
    promptContractVersion: "prompt-v1",
    embeddingConfigurationRevisionPublicId: "embedding-revision-1",
    embeddingQueryPolicyRevisionPublicId: "embedding-revision-1",
    minimumVectorRelevance: 0.7,
    resolvedDimension: 3,
    normalization: "l2",
    artifactSchemaVersion: "artifact-v1",
    vectorSchemaVersion: "vector-v1",
    searchProviderKind: "opensearch",
    mappingFingerprintSha256: "a".repeat(64)
  };
}

function active(targetContract: SemanticMaintenanceTarget):
SemanticActiveProjectionRecord {
  return {
    publicId: "semantic-active",
    knowledgeBaseId: targetContract.knowledgeBaseId,
    operationPublicId: "operation-active",
    expectedPredecessorPublicId: null,
    role: "active",
    state: "active",
    contractFingerprintSha256: semanticContractFingerprint(targetContract),
    revision: 1,
    generationModelConfigurationPublicId:
      targetContract.generationModelConfigurationPublicId,
    generationModelConfigurationRevision:
      targetContract.generationModelConfigurationRevision,
    extractionContractVersion: targetContract.extractionContractVersion,
    graphSchemaVersion: targetContract.graphSchemaVersion,
    promptContractVersion: targetContract.promptContractVersion,
    projectionContractPublicId: "projection-active",
    embeddingConfigurationRevisionPublicId:
      targetContract.embeddingConfigurationRevisionPublicId,
    embeddingQueryPolicyRevisionPublicId:
      targetContract.embeddingQueryPolicyRevisionPublicId,
    minimumVectorRelevance: targetContract.minimumVectorRelevance,
    searchProviderKind: targetContract.searchProviderKind,
    resolvedDimension: targetContract.resolvedDimension,
    normalization: targetContract.normalization,
    artifactSchemaVersion: targetContract.artifactSchemaVersion,
    vectorSchemaVersion: targetContract.vectorSchemaVersion,
    mappingFingerprintSha256: targetContract.mappingFingerprintSha256
  };
}
