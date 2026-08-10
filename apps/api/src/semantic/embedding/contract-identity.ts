import { createHash } from "node:crypto";
import type {
  EmbeddingArtifactIdentity,
  EmbeddingNormalization,
  SemanticMaintenanceTarget,
  SemanticVectorDocument
} from "../domain/contracts.js";
import type { EmbeddingConfigurationPrivate } from "./configuration.js";

export type EmbeddingProjectionIdentity = {
  embeddingConfigurationRevisionPublicId: string;
  dimension: number;
  normalization: EmbeddingNormalization;
  artifactSchemaVersion: string;
  vectorSchemaVersion: string;
  fingerprintSha256: string;
};

export type EmbeddingExecutionSnapshot = {
  configurationPublicId: string;
  configurationRevisionPublicId: string;
  dimension: number;
  normalization: EmbeddingNormalization;
  batchSize: number;
  timeoutMs: number;
  retryCount: number;
  minimumIntervalMs: number;
  concurrency: number;
  maximumInputTokens: number;
  maximumResponseBytes: number;
};

export function createEmbeddingArtifactIdentity(input: Omit<
  EmbeddingArtifactIdentity,
  "artifactSchemaVersion"
> & { artifactSchemaVersion?: string }): EmbeddingArtifactIdentity & {
  artifactPublicId: string;
  fingerprintSha256: string;
} {
  const artifactSchemaVersion = input.artifactSchemaVersion
    ?? "focowiki-vector-artifact-v1";
  if (
    !/^[0-9a-f]{64}$/u.test(input.canonicalInputSha256)
    || !Number.isInteger(input.dimension)
    || input.dimension <= 0
    || input.ownerKind !== input.inputKind
  ) throw new Error("Embedding artifact identity is invalid");
  const values = [
    input.knowledgeBaseId,
    input.ownerKind,
    input.ownerPublicId,
    input.sourceRevisionPublicId ?? "",
    input.canonicalInputSha256,
    input.embeddingConfigurationRevisionPublicId,
    input.normalization,
    String(input.dimension),
    input.inputKind,
    artifactSchemaVersion
  ];
  const fingerprintSha256 = createHash("sha256")
    .update(values.join("\u001f"))
    .digest("hex");
  return {
    ...input,
    artifactSchemaVersion,
    artifactPublicId: `embedding-artifact:${fingerprintSha256}`,
    fingerprintSha256
  };
}

export function createEmbeddingProjectionIdentity(
  target: SemanticMaintenanceTarget
): EmbeddingProjectionIdentity {
  const values = [
    target.generationModelConfigurationPublicId,
    String(target.generationModelConfigurationRevision),
    target.extractionContractVersion,
    target.graphSchemaVersion,
    target.promptContractVersion,
    target.embeddingConfigurationRevisionPublicId,
    String(target.resolvedDimension),
    target.normalization,
    target.artifactSchemaVersion,
    target.vectorSchemaVersion
  ];
  return {
    embeddingConfigurationRevisionPublicId:
      target.embeddingConfigurationRevisionPublicId,
    dimension: target.resolvedDimension,
    normalization: target.normalization,
    artifactSchemaVersion: target.artifactSchemaVersion,
    vectorSchemaVersion: target.vectorSchemaVersion,
    fingerprintSha256: createHash("sha256").update(values.join("\u001f")).digest("hex")
  };
}

export function createEmbeddingExecutionSnapshot(
  configuration: EmbeddingConfigurationPrivate
): EmbeddingExecutionSnapshot {
  if (configuration.validationStatus !== "valid" || configuration.resolvedDimension === null) {
    throw new Error("Embedding execution snapshot requires a validated revision");
  }
  return {
    configurationPublicId: configuration.publicId,
    configurationRevisionPublicId:
      configuration.vectorProducingRevisionPublicId,
    dimension: configuration.resolvedDimension,
    normalization: configuration.normalization,
    batchSize: configuration.batchSize,
    timeoutMs: configuration.timeoutMs,
    retryCount: configuration.retryCount,
    minimumIntervalMs: configuration.minimumIntervalMs,
    concurrency: configuration.concurrency,
    maximumInputTokens: configuration.maximumInputTokens,
    maximumResponseBytes: configuration.maximumResponseBytes
  };
}

export function assertEmbeddingArtifactMatchesProjection(
  artifact: EmbeddingArtifactIdentity,
  projection: EmbeddingProjectionIdentity
): void {
  if (
    artifact.embeddingConfigurationRevisionPublicId
      !== projection.embeddingConfigurationRevisionPublicId
    || artifact.dimension !== projection.dimension
    || artifact.normalization !== projection.normalization
    || artifact.artifactSchemaVersion !== projection.artifactSchemaVersion
  ) throw new Error("Embedding artifact contract does not match the projection");
}

export function assertVectorDocumentMatchesProjection(
  document: SemanticVectorDocument,
  projection: EmbeddingProjectionIdentity
): void {
  if (
    document.embeddingConfigurationRevisionPublicId
      !== projection.embeddingConfigurationRevisionPublicId
    || document.dimension !== projection.dimension
  ) throw new Error("Semantic vector document contract does not match the projection");
}

export function assertEmbeddingSnapshotMatchesProjection(
  snapshot: EmbeddingExecutionSnapshot,
  projection: EmbeddingProjectionIdentity
): void {
  if (
    snapshot.configurationRevisionPublicId
      !== projection.embeddingConfigurationRevisionPublicId
    || snapshot.dimension !== projection.dimension
    || snapshot.normalization !== projection.normalization
  ) throw new Error("Embedding work snapshot is stale for the projection");
}
