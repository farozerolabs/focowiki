import { createHash } from "node:crypto";
import type { RuntimeSettingsSnapshot } from "../../runtime-settings/types.js";
import type { EmbeddingConfigurationPrivate } from
  "../embedding/configuration.js";
import {
  SEMANTIC_EXTRACTION_CONTRACT_VERSION,
  SEMANTIC_GRAPH_SCHEMA_VERSION,
  SEMANTIC_PROMPT_CONTRACT_VERSION,
  SEMANTIC_VECTOR_ARTIFACT_SCHEMA_VERSION,
  SEMANTIC_VECTOR_SCHEMA_VERSION,
  type SemanticMaintenanceTarget
} from "../domain/contracts.js";

export function resolveSemanticAdoptionTarget(input: {
  knowledgeBaseId: string;
  runtimeSettings: RuntimeSettingsSnapshot;
  embeddingConfigurations: readonly EmbeddingConfigurationPrivate[];
  searchProviderKind: "meilisearch" | "opensearch";
}): {
  target: SemanticMaintenanceTarget;
  embedding: EmbeddingConfigurationPrivate;
} {
  const model = input.runtimeSettings.activeModel;
  const modelRevision = model?.configurationRevision;
  if (!model || !Number.isSafeInteger(modelRevision)) {
    throw targetError("semantic_generation_model_required");
  }
  const activeEmbeddings = input.embeddingConfigurations.filter(
    (value) => value.lifecycleStatus === "active"
  );
  if (activeEmbeddings.length !== 1) {
    throw targetError("semantic_embedding_model_required");
  }
  const embedding = activeEmbeddings[0]!;
  if (embedding.validationStatus !== "valid" || embedding.resolvedDimension === null) {
    throw targetError("semantic_embedding_revision_not_validated");
  }
  const mappingFingerprintSha256 = createHash("sha256").update(JSON.stringify({
    provider: input.searchProviderKind,
    schemaVersion: SEMANTIC_VECTOR_SCHEMA_VERSION,
    dimension: embedding.resolvedDimension,
    normalization: embedding.normalization,
    families: ["content", "entity", "relationship", "community"]
  })).digest("hex");
  return {
    embedding,
    target: {
      knowledgeBaseId: input.knowledgeBaseId,
      generationModelConfigurationPublicId: model.id,
      generationModelConfigurationRevision: modelRevision!,
      extractionContractVersion: SEMANTIC_EXTRACTION_CONTRACT_VERSION,
      graphSchemaVersion: SEMANTIC_GRAPH_SCHEMA_VERSION,
      promptContractVersion: SEMANTIC_PROMPT_CONTRACT_VERSION,
      embeddingConfigurationRevisionPublicId:
        embedding.vectorProducingRevisionPublicId,
      embeddingQueryPolicyRevisionPublicId:
        embedding.queryPolicyRevisionPublicId,
      minimumVectorRelevance: embedding.minimumVectorRelevance,
      resolvedDimension: embedding.resolvedDimension,
      normalization: embedding.normalization,
      artifactSchemaVersion: SEMANTIC_VECTOR_ARTIFACT_SCHEMA_VERSION,
      vectorSchemaVersion: SEMANTIC_VECTOR_SCHEMA_VERSION,
      searchProviderKind: input.searchProviderKind,
      mappingFingerprintSha256
    }
  };
}

function targetError(code: string): Error & { code: string; retryable: boolean } {
  return Object.assign(
    new Error(`Semantic adoption target is unavailable: ${code}`),
    { code, retryable: false }
  );
}
