import { createHash } from "node:crypto";
import type postgres from "postgres";

const MODEL_ID = "model-config-document-test";
const EMBEDDING_ID = "embedding-config-document-test";
const EMBEDDING_REVISION_ID = "embedding-revision-document-test";

export async function seedRequiredDocumentProcessingContract(
  sql: postgres.Sql,
  knowledgeBaseId: string
): Promise<{
  generationModelConfigurationPublicId: string;
  generationModelConfigurationRevision: number;
  embeddingConfigurationRevisionPublicId: string;
  semanticGenerationPublicId: string;
}> {
  const scope = createHash("sha256").update(knowledgeBaseId).digest("hex").slice(0, 20);
  const operationPublicId = `operation-semantic-${scope}`;
  const semanticGenerationPublicId = `semantic-generation-${scope}`;
  await sql`
    INSERT INTO focowiki.model_configs (
      public_id, provider, model, secret_reference, config, enabled, revision
    ) VALUES (
      ${MODEL_ID}, 'openai-compatible', 'generation-model',
      'runtime/document-test-model', '{}'::jsonb, true, 1
    )
    ON CONFLICT (public_id) DO NOTHING
  `;
  await sql`
    INSERT INTO focowiki.embedding_configurations (
      public_id, display_name, lifecycle_status, revision
    ) VALUES (${EMBEDDING_ID}, 'Embedding', 'active', 1)
    ON CONFLICT (public_id) DO NOTHING
  `;
  await sql`
    INSERT INTO focowiki.embedding_configuration_revisions (
      public_id, configuration_public_id, revision_number, authentication_mode,
      base_url, model_name, requested_dimension, resolved_dimension,
      normalization, maximum_input_tokens, batch_size, timeout_ms, retry_count,
      minimum_interval_ms, concurrency, maximum_response_bytes,
      minimum_vector_relevance, vector_producing_revision_public_id,
      validation_status, validation_fingerprint_sha256, validated_at
    ) VALUES (
      ${EMBEDDING_REVISION_ID}, ${EMBEDDING_ID}, 1, 'none',
      'http://embedding.local/v1', 'embedding-model', 3, 3, 'l2',
      8192, 16, 5000, 1, 0, 2, 1048576, 0.7,
      ${EMBEDDING_REVISION_ID}, 'valid', ${"e".repeat(64)}, now()
    )
    ON CONFLICT (public_id) DO NOTHING
  `;
  await sql`
    UPDATE focowiki.embedding_configurations
    SET active_revision_public_id = ${EMBEDDING_REVISION_ID}
    WHERE public_id = ${EMBEDDING_ID}
  `;
  await sql`
    INSERT INTO focowiki.operations (
      public_id, knowledge_base_id, operation_kind, state, completed_at
    ) VALUES (
      ${operationPublicId}, ${knowledgeBaseId},
      'semantic_contract_bootstrap', 'completed', now()
    )
    ON CONFLICT (knowledge_base_id, public_id) DO NOTHING
  `;
  await sql`
    INSERT INTO focowiki.semantic_generations (
      public_id, knowledge_base_id, operation_public_id,
      expected_predecessor_public_id, generation_role, state,
      generation_model_configuration_public_id,
      generation_model_configuration_revision,
      extraction_contract_version, graph_schema_version,
      prompt_contract_version, contract_fingerprint_sha256,
      revision, activated_at
    ) VALUES (
      ${semanticGenerationPublicId}, ${knowledgeBaseId}, ${operationPublicId},
      NULL, 'active', 'active', ${MODEL_ID}, 1,
      'extract-v1', 'graph-v1', 'prompt-v1', ${"f".repeat(64)}, 1, now()
    )
    ON CONFLICT (knowledge_base_id, public_id) DO NOTHING
  `;
  await sql`
    INSERT INTO focowiki.semantic_projection_contracts (
      public_id, knowledge_base_id, semantic_generation_public_id,
      embedding_configuration_revision_public_id,
      embedding_query_policy_revision_public_id,
      minimum_vector_relevance, search_provider_kind,
      resolved_dimension, normalization, artifact_schema_version,
      vector_schema_version, mapping_fingerprint_sha256
    ) VALUES (
      ${`semantic-contract-${scope}`}, ${knowledgeBaseId},
      ${semanticGenerationPublicId}, ${EMBEDDING_REVISION_ID},
      ${EMBEDDING_REVISION_ID}, 0.7, 'opensearch', 3, 'l2',
      'artifact-v1', 'vector-v1', ${"a".repeat(64)}
    )
    ON CONFLICT (knowledge_base_id, semantic_generation_public_id) DO NOTHING
  `;
  return {
    generationModelConfigurationPublicId: MODEL_ID,
    generationModelConfigurationRevision: 1,
    embeddingConfigurationRevisionPublicId: EMBEDDING_REVISION_ID,
    semanticGenerationPublicId
  };
}
