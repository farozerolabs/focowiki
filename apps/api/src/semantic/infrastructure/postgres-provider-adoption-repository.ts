import type { DatabaseClient } from "../../db/client.js";
import type { SemanticProviderAdoptionRepository } from
  "../application/provider-adoption.js";
import { semanticContractFingerprint } from
  "../application/adoption.js";

export function createPostgresSemanticProviderAdoptionRepository(
  sql: DatabaseClient
): SemanticProviderAdoptionRepository {
  return {
    async countActiveVectorDocuments(input) {
      const rows = await sql<Array<{ count: number | string }>>`
        SELECT count(*) AS count
        FROM focowiki.semantic_vector_documents vector
        JOIN focowiki.semantic_generations generation
          ON generation.knowledge_base_id = vector.knowledge_base_id
         AND generation.public_id = vector.semantic_generation_public_id
         AND generation.generation_role = 'active'
         AND generation.state = 'active'
         AND generation.deleted_at IS NULL
        WHERE vector.knowledge_base_id = ${input.knowledgeBaseId}
          AND vector.semantic_generation_public_id
            = ${input.semanticGenerationPublicId}
          AND vector.state = 'active'
          AND vector.deleted_at IS NULL
      `;
      const count = Number(rows[0]?.count ?? 0);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error("Semantic provider vector count is invalid");
      }
      return count;
    },

    async activateProviderProjection(input) {
      return sql.begin(async (transaction) => {
        const rows = await transaction<Array<{ public_id: string }>>`
          SELECT generation.public_id
          FROM focowiki.semantic_generations generation
          JOIN focowiki.semantic_projection_contracts contract
            ON contract.knowledge_base_id = generation.knowledge_base_id
           AND contract.semantic_generation_public_id = generation.public_id
          WHERE generation.knowledge_base_id = ${input.knowledgeBaseId}
            AND generation.public_id = ${input.semanticGenerationPublicId}
            AND generation.generation_role = 'active'
            AND generation.state = 'active'
            AND generation.revision = ${input.expectedGenerationRevision}
            AND generation.generation_model_configuration_public_id
              = ${input.target.generationModelConfigurationPublicId}
            AND generation.generation_model_configuration_revision
              = ${input.target.generationModelConfigurationRevision}
            AND generation.extraction_contract_version
              = ${input.target.extractionContractVersion}
            AND generation.graph_schema_version = ${input.target.graphSchemaVersion}
            AND generation.prompt_contract_version
              = ${input.target.promptContractVersion}
            AND contract.embedding_configuration_revision_public_id
              = ${input.target.embeddingConfigurationRevisionPublicId}
            AND contract.resolved_dimension = ${input.target.resolvedDimension}
            AND contract.normalization = ${input.target.normalization}
            AND contract.artifact_schema_version
              = ${input.target.artifactSchemaVersion}
            AND contract.vector_schema_version = ${input.target.vectorSchemaVersion}
            AND generation.deleted_at IS NULL
          FOR UPDATE OF generation, contract
        `;
        if (!rows[0]) return false;
        await transaction`
          UPDATE focowiki.semantic_projection_contracts
          SET search_provider_kind = ${input.target.searchProviderKind},
              mapping_fingerprint_sha256 = ${input.target.mappingFingerprintSha256},
              embedding_query_policy_revision_public_id
                = ${input.target.embeddingQueryPolicyRevisionPublicId},
              minimum_vector_relevance = ${input.target.minimumVectorRelevance}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND semantic_generation_public_id
              = ${input.semanticGenerationPublicId}
        `;
        const updated = await transaction<Array<{ public_id: string }>>`
          UPDATE focowiki.semantic_generations
          SET contract_fingerprint_sha256 = ${semanticContractFingerprint(input.target)},
              revision = revision + 1
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND public_id = ${input.semanticGenerationPublicId}
            AND generation_role = 'active'
            AND state = 'active'
            AND revision = ${input.expectedGenerationRevision}
          RETURNING public_id
        `;
        return updated.length === 1;
      });
    }
  };
}
