import type {
  SemanticActiveProjectionRecord
} from "./ports.js";
import type { SemanticMaintenanceTarget } from "../domain/contracts.js";
import { semanticContractFingerprint } from "../domain/maintenance-contract.js";

export type SemanticAdoptionMode =
  | "full"
  | "embedding_only"
  | "provider_only"
  | "query_policy_only";

export function classifySemanticAdoption(
  active: SemanticActiveProjectionRecord | null,
  target: SemanticMaintenanceTarget
): SemanticAdoptionMode | null {
  if (!active) return "full";
  if (active.contractFingerprintSha256 === semanticContractFingerprint(target)) {
    return null;
  }
  if (
    hasCompatibleSemanticArtifacts(active, target)
    && (
      active.searchProviderKind !== target.searchProviderKind
      || active.mappingFingerprintSha256 !== target.mappingFingerprintSha256
    )
  ) return "provider_only";
  if (hasCompatibleSemanticArtifacts(active, target)
    && (
      active.embeddingQueryPolicyRevisionPublicId
        !== target.embeddingQueryPolicyRevisionPublicId
      || active.minimumVectorRelevance !== target.minimumVectorRelevance
    )) return "query_policy_only";
  if (
    hasCompatibleSemanticGraphFacts(active, target)
    && hasChangedVectorArtifactContract(active, target)
  ) return "embedding_only";
  return "full";
}

function hasCompatibleSemanticArtifacts(
  active: SemanticActiveProjectionRecord,
  target: SemanticMaintenanceTarget
): boolean {
  return hasCompatibleSemanticGraphFacts(active, target)
    && active.embeddingConfigurationRevisionPublicId
      === target.embeddingConfigurationRevisionPublicId
    && active.resolvedDimension === target.resolvedDimension
    && active.normalization === target.normalization
    && active.artifactSchemaVersion === target.artifactSchemaVersion
    && active.vectorSchemaVersion === target.vectorSchemaVersion;
}

function hasCompatibleSemanticGraphFacts(
  active: SemanticActiveProjectionRecord,
  target: SemanticMaintenanceTarget
): boolean {
  return active.knowledgeBaseId === target.knowledgeBaseId
    && active.generationModelConfigurationPublicId
      === target.generationModelConfigurationPublicId
    && active.generationModelConfigurationRevision
      === target.generationModelConfigurationRevision
    && active.extractionContractVersion === target.extractionContractVersion
    && active.graphSchemaVersion === target.graphSchemaVersion
    && active.promptContractVersion === target.promptContractVersion;
}

function hasChangedVectorArtifactContract(
  active: SemanticActiveProjectionRecord,
  target: SemanticMaintenanceTarget
): boolean {
  return active.embeddingConfigurationRevisionPublicId
      !== target.embeddingConfigurationRevisionPublicId
    || active.resolvedDimension !== target.resolvedDimension
    || active.normalization !== target.normalization
    || active.artifactSchemaVersion !== target.artifactSchemaVersion
    || active.vectorSchemaVersion !== target.vectorSchemaVersion;
}
