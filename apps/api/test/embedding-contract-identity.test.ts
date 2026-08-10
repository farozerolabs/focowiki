import { describe, expect, it } from "vitest";
import type {
  EmbeddingArtifactIdentity,
  SemanticMaintenanceTarget,
  SemanticVectorDocument
} from "../src/semantic/domain/contracts.js";
import {
  assertEmbeddingArtifactMatchesProjection,
  assertEmbeddingSnapshotMatchesProjection,
  assertVectorDocumentMatchesProjection,
  createEmbeddingExecutionSnapshot,
  createEmbeddingProjectionIdentity
} from "../src/semantic/embedding/contract-identity.js";
import { encryptRuntimeSecret } from "../src/runtime-settings/encryption.js";

describe("embedding projection identity", () => {
  it("pins model revision, dimension, normalization, artifact, and vector schemas", () => {
    const projection = createEmbeddingProjectionIdentity(target());
    expect(projection).toMatchObject({
      embeddingConfigurationRevisionPublicId: "embedding-revision-a",
      dimension: 3,
      normalization: "l2",
      artifactSchemaVersion: "artifact-v1",
      vectorSchemaVersion: "vector-v1"
    });
    expect(projection.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/u);
    const artifact = artifactIdentity();
    const vector = vectorDocument();
    expect(() => assertEmbeddingArtifactMatchesProjection(artifact, projection))
      .not.toThrow();
    expect(() => assertVectorDocumentMatchesProjection(vector, projection))
      .not.toThrow();
  });

  it("rejects mixed artifact, stale work, and vector dimension contracts", () => {
    const projection = createEmbeddingProjectionIdentity(target());
    expect(() => assertEmbeddingArtifactMatchesProjection({
      ...artifactIdentity(),
      embeddingConfigurationRevisionPublicId: "embedding-revision-old"
    }, projection)).toThrow("does not match");
    expect(() => assertVectorDocumentMatchesProjection({
      ...vectorDocument(),
      dimension: 4
    }, projection)).toThrow("does not match");
    const snapshot = createEmbeddingExecutionSnapshot(configuration());
    expect(() => assertEmbeddingSnapshotMatchesProjection({
      ...snapshot,
      configurationRevisionPublicId: "embedding-revision-old"
    }, projection)).toThrow("stale");
  });

  it("creates a secret-free durable execution snapshot", () => {
    const snapshot = createEmbeddingExecutionSnapshot(configuration());
    expect(snapshot).toMatchObject({
      configurationRevisionPublicId: "embedding-revision-a",
      dimension: 3,
      batchSize: 16,
      concurrency: 2
    });
    expect(JSON.stringify(snapshot)).not.toContain("embedding-secret");
    expect(JSON.stringify(snapshot)).not.toMatch(/api.?key|credential|baseUrl|modelName/iu);
  });
});

function target(): SemanticMaintenanceTarget {
  return {
    knowledgeBaseId: "kb-a",
    generationModelConfigurationPublicId: "model-config-a",
    generationModelConfigurationRevision: 1,
    extractionContractVersion: "extract-v1",
    graphSchemaVersion: "graph-v1",
    promptContractVersion: "prompt-v1",
    embeddingConfigurationRevisionPublicId: "embedding-revision-a",
    embeddingQueryPolicyRevisionPublicId: "embedding-revision-a",
    minimumVectorRelevance: 0.7,
    resolvedDimension: 3,
    normalization: "l2",
    artifactSchemaVersion: "artifact-v1",
    vectorSchemaVersion: "vector-v1",
    searchProviderKind: "opensearch",
    mappingFingerprintSha256: "a".repeat(64)
  };
}

function artifactIdentity(): EmbeddingArtifactIdentity {
  return {
    knowledgeBaseId: "kb-a",
    ownerKind: "entity",
    ownerPublicId: "entity-a",
    sourceRevisionPublicId: "revision-a",
    canonicalInputSha256: "b".repeat(64),
    embeddingConfigurationRevisionPublicId: "embedding-revision-a",
    normalization: "l2",
    dimension: 3,
    inputKind: "entity",
    artifactSchemaVersion: "artifact-v1"
  };
}

function vectorDocument(): SemanticVectorDocument {
  return {
    publicId: "vector-a",
    knowledgeBaseId: "kb-a",
    semanticGenerationPublicId: "semantic-a",
    ownerPublicId: "entity-a",
    family: "entity",
    sourceFilePublicId: "file-a",
    sourceRevisionPublicId: "revision-a",
    embeddingConfigurationRevisionPublicId: "embedding-revision-a",
    dimension: 3,
    artifactPublicId: "artifact-a",
    evidenceTargetPath: "pages/a.md"
  };
}

function configuration() {
  return {
    publicId: "embedding-config-a",
    revisionPublicId: "embedding-revision-a",
    revision: 1,
    displayName: "Embedding",
    authenticationMode: "api_key" as const,
    baseUrl: "https://embedding.example/v1",
    encryptedApiKey: encryptRuntimeSecret({
      value: "embedding-secret",
      secret: "deployment-secret"
    }),
    apiKeyConfigured: true,
    modelName: "embedding-model",
    requestedDimension: 3,
    resolvedDimension: 3,
    normalization: "l2" as const,
    maximumInputTokens: 8_192,
    batchSize: 16,
    timeoutMs: 10_000,
    retryCount: 2,
    minimumIntervalMs: 20,
    concurrency: 2,
    maximumResponseBytes: 1_000_000,
    minimumVectorRelevance: 0.7,
    vectorProducingRevisionPublicId: "embedding-revision-a",
    queryPolicyRevisionPublicId: "embedding-revision-a",
    validationStatus: "valid" as const,
    validationFingerprintSha256: "c".repeat(64),
    safeValidationErrorCode: null,
    lifecycleStatus: "active" as const,
    createdAt: "2026-08-08T00:00:00.000Z"
  };
}
