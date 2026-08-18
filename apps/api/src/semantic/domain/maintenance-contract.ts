import { createHash } from "node:crypto";
import type { SemanticMaintenanceTarget } from "./contracts.js";

export function semanticContractFingerprint(
  target: SemanticMaintenanceTarget
): string {
  return createHash("sha256").update(JSON.stringify([
    target.knowledgeBaseId,
    target.generationModelConfigurationPublicId,
    target.generationModelConfigurationRevision,
    target.extractionContractVersion,
    target.graphSchemaVersion,
    target.promptContractVersion,
    target.embeddingConfigurationRevisionPublicId,
    target.embeddingQueryPolicyRevisionPublicId,
    target.minimumVectorRelevance,
    target.resolvedDimension,
    target.normalization,
    target.artifactSchemaVersion,
    target.vectorSchemaVersion,
    target.searchProviderKind,
    target.mappingFingerprintSha256
  ])).digest("hex");
}

export function createSemanticAdoptionCandidatePublicId(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
}): string {
  const digest = createHash("sha256")
    .update(`${input.knowledgeBaseId}\u001f${input.operationPublicId}`)
    .digest("hex");
  return `semantic-generation-${digest}`;
}
