import { createHash } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import type { SemanticProviderAdoptionRepository } from
  "../application/provider-adoption.js";
import { semanticContractFingerprint } from
  "../application/adoption.js";
import { semanticVectorIndexUid } from "../vector/projection-planner.js";

type ActiveProjectionRow = {
  public_id: string;
  search_provider_kind: "meilisearch" | "opensearch";
  mapping_fingerprint_sha256: string;
  vector_document_count: number | string;
};

export function createPostgresSemanticProviderAdoptionRepository(
  sql: DatabaseClient,
  options: { indexPrefix: string }
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
        const rows = await transaction<ActiveProjectionRow[]>`
          SELECT generation.public_id, contract.search_provider_kind,
                 contract.mapping_fingerprint_sha256,
                 (
                   SELECT count(*)
                   FROM focowiki.semantic_vector_documents vector
                   WHERE vector.knowledge_base_id = generation.knowledge_base_id
                     AND vector.semantic_generation_public_id = generation.public_id
                     AND vector.state = 'active'
                     AND vector.deleted_at IS NULL
                 ) AS vector_document_count
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
        const active = rows[0];
        if (!active) return false;
        const ownership = await transaction<Array<{ operation_public_id: string }>>`
          SELECT operation.public_id AS operation_public_id
          FROM focowiki.operations operation
          JOIN focowiki.operation_work_items work
            ON work.knowledge_base_id = operation.knowledge_base_id
           AND work.operation_public_id = operation.public_id
          WHERE operation.knowledge_base_id = ${input.knowledgeBaseId}
            AND operation.public_id = ${input.operationPublicId}
            AND operation.operation_kind = 'maintenance'
            AND operation.state IN (
              'accepted', 'validating', 'processing', 'publishing'
            )
            AND work.work_kind = 'maintenance'
            AND work.state = 'running'
            AND work.search_provider_kind = ${input.target.searchProviderKind}
            AND work.checkpoint ->> 'maintenanceKind' = 'provider_adoption'
          FOR UPDATE OF operation, work
        `;
        if (!ownership[0]) return false;
        const targetIndexUid = semanticVectorIndexUid({
          indexPrefix: options.indexPrefix,
          knowledgeBaseId: input.knowledgeBaseId,
          semanticGenerationPublicId: input.semanticGenerationPublicId,
          mappingFingerprintSha256: input.target.mappingFingerprintSha256
        });
        const cleanup = await transaction<Array<{
          public_id: string;
          state: "queued" | "running" | "retry";
        }>>`
          SELECT public_id, state
          FROM focowiki.cleanup_actions
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND action_kind = 'provider_adoption'
            AND cleanup_plane = 'search'
            AND search_provider_kind = ${input.target.searchProviderKind}
            AND resource_kind = 'search_index'
            AND resource_public_id = ${targetIndexUid}
          FOR UPDATE
        `;
        if (cleanup.some((action) => action.state === "running")) return false;
        await transaction`
          DELETE FROM focowiki.cleanup_actions
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND action_kind = 'provider_adoption'
            AND cleanup_plane = 'search'
            AND search_provider_kind = ${input.target.searchProviderKind}
            AND resource_kind = 'search_index'
            AND resource_public_id = ${targetIndexUid}
            AND state IN ('queued', 'retry')
        `;
        const retiredIndexUid = semanticVectorIndexUid({
          indexPrefix: options.indexPrefix,
          knowledgeBaseId: input.knowledgeBaseId,
          semanticGenerationPublicId: input.semanticGenerationPublicId,
          mappingFingerprintSha256: active.mapping_fingerprint_sha256
        });
        if (retiredIndexUid !== targetIndexUid) {
          await enqueueRetiredVectorIndexCleanup(transaction, {
            operationPublicId: input.operationPublicId,
            knowledgeBaseId: input.knowledgeBaseId,
            cleanupNotBefore: input.cleanupNotBefore,
            providerKind: active.search_provider_kind,
            providerIndexUid: retiredIndexUid,
            documentCount: toDocumentCount(active.vector_document_count)
          });
        }
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

async function enqueueRetiredVectorIndexCleanup(
  sql: TransactionSql,
  input: {
    operationPublicId: string;
    knowledgeBaseId: string;
    cleanupNotBefore: string;
    providerKind: "meilisearch" | "opensearch";
    providerIndexUid: string;
    documentCount: number;
  }
): Promise<void> {
  const digest = createHash("sha256")
    .update("semantic-provider-adoption-cleanup-v1")
    .update("\0")
    .update(input.operationPublicId)
    .update("\0")
    .update(input.providerKind)
    .update("\0")
    .update(input.providerIndexUid)
    .digest("hex");
  const publicId = `semantic-provider-adoption-cleanup-${digest}`;
  await sql`
    INSERT INTO focowiki.cleanup_actions (
      public_id, operation_public_id, knowledge_base_id, action_kind,
      cleanup_plane, search_provider_kind, resource_kind, resource_public_id,
      required, sequence_number, idempotency_key, request_hash, checkpoint,
      state, attempt_count, not_before
    ) VALUES (
      ${publicId}, ${input.operationPublicId}, ${input.knowledgeBaseId},
      'provider_adoption', 'search', ${input.providerKind}, 'search_index',
      ${input.providerIndexUid}, false, 0, ${publicId}, ${digest},
      ${sql.json({
        providerIndexUid: input.providerIndexUid,
        documentCount: input.documentCount,
        semanticVectorIndex: true
      })},
      'queued', 0, ${input.cleanupNotBefore}
    )
    ON CONFLICT ON CONSTRAINT cleanup_actions_idempotency_key DO NOTHING
  `;
}

function toDocumentCount(value: number | string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Semantic provider vector document count is invalid");
  }
  return count;
}
