import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import type { SemanticVectorProjectionRepositoryPort } from
  "../vector/projection-service.js";

export function createPostgresSemanticVectorProjectionRepository(
  sql: DatabaseClient
): SemanticVectorProjectionRepositoryPort {
  return {
    async listSourceDocuments(input) {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10_000) {
        throw repositoryError("invalid_limit");
      }
      const rows = await sql<Array<{
        public_id: string;
        owner_public_id: string;
      }>>`
        SELECT vector.public_id, vector.owner_public_id
        FROM focowiki.semantic_vector_documents vector
        JOIN focowiki.semantic_generations generation
          ON generation.knowledge_base_id = vector.knowledge_base_id
         AND generation.public_id = vector.semantic_generation_public_id
         AND generation.deleted_at IS NULL
        WHERE vector.knowledge_base_id = ${input.knowledgeBaseId}
          AND vector.semantic_generation_public_id
            = ${input.semanticGenerationPublicId}
          AND vector.source_file_public_id = ${input.sourceFilePublicId}
          AND vector.state IN ('candidate', 'active', 'deleted')
          AND (
            generation.generation_role = 'candidate'
              AND generation.state IN ('building', 'validating', 'ready')
            OR generation.generation_role = 'active'
              AND generation.state = 'active'
          )
        ORDER BY vector.public_id COLLATE "C"
        LIMIT ${input.limit + 1}
      `;
      if (rows.length > input.limit) throw repositoryError("source_document_limit");
      return rows.map((row) => ({
        publicId: row.public_id,
        ownerPublicId: row.owner_public_id
      }));
    },
    async prepareImpacts(input) {
      assertTimestamp(input.preparedAt);
      return sql.begin(async (transaction) => {
        const scope = await transaction<Array<{
          public_id: string;
          generation_role: "candidate" | "active";
          mutation_candidate: boolean;
        }>>`
          SELECT contract.public_id, generation.generation_role,
                 ${mutationCandidateSql(transaction, input.plan)}
                   AS mutation_candidate
          FROM focowiki.semantic_projection_contracts contract
          JOIN focowiki.semantic_generations generation
            ON generation.knowledge_base_id = contract.knowledge_base_id
           AND generation.public_id = contract.semantic_generation_public_id
          WHERE contract.public_id = ${input.plan.projectionContractPublicId}
            AND contract.knowledge_base_id = ${input.plan.knowledgeBaseId}
            AND contract.semantic_generation_public_id
              = ${input.plan.semanticGenerationPublicId}
            AND contract.embedding_configuration_revision_public_id
              = ${input.plan.embeddingConfigurationRevisionPublicId}
            AND contract.resolved_dimension = ${input.plan.definition.dimension}
            AND contract.mapping_fingerprint_sha256
              = ${input.plan.definition.mappingFingerprintSha256}
            AND (
              generation.generation_role = 'candidate'
                AND generation.state IN ('building', 'validating')
              OR generation.generation_role = 'active'
                AND generation.state = 'active'
            )
            AND generation.deleted_at IS NULL
          FOR UPDATE OF generation
        `;
        if (!scope[0]) throw repositoryError("projection_scope_invalid");
        const documentState = scope[0].generation_role === "active"
          && !scope[0].mutation_candidate
          ? "active" as const : "candidate" as const;
        let deleted = 0;
        if (input.plan.providerDeleteDocumentIds.length > 0) {
          const rows = await transaction<Array<{ public_id: string }>>`
            UPDATE focowiki.semantic_vector_documents
            SET state = 'deleted', deleted_at = ${input.preparedAt}
            WHERE knowledge_base_id = ${input.plan.knowledgeBaseId}
              AND semantic_generation_public_id
                = ${input.plan.semanticGenerationPublicId}
              AND public_id = ANY(${input.plan.providerDeleteDocumentIds})
              AND state <> 'deleted'
            RETURNING public_id
          `;
          deleted = rows.length;
        }
        if (input.plan.desiredDocuments.length === 0) {
          return { prepared: 0, deleted };
        }
        const rows = await transaction<Array<{ public_id: string }>>`
          INSERT INTO focowiki.semantic_vector_documents AS vector (
            knowledge_base_id, semantic_generation_public_id, public_id,
            projection_contract_public_id,
            embedding_configuration_revision_public_id, artifact_public_id,
            vector_family, owner_public_id, source_file_public_id,
            source_revision_public_id, evidence_target_path, dimension,
            provider_document_id, state, deleted_at
          )
          SELECT ${input.plan.knowledgeBaseId},
                 ${input.plan.semanticGenerationPublicId}, item."publicId",
                 ${input.plan.projectionContractPublicId},
                 ${input.plan.embeddingConfigurationRevisionPublicId},
                 item."artifactPublicId", item."family", item."ownerPublicId",
                 item."sourceFilePublicId", item."sourceRevisionPublicId",
                 item."evidenceTargetPath", ${input.plan.definition.dimension},
                 item."providerDocumentId", ${documentState}, NULL
          FROM jsonb_to_recordset(${transaction.json(
            input.plan.desiredDocuments as never
          )}) AS item(
            "publicId" text, "artifactPublicId" text, "family" text,
            "ownerPublicId" text, "sourceFilePublicId" text,
            "sourceRevisionPublicId" text, "evidenceTargetPath" text,
            "providerDocumentId" text
          )
          JOIN focowiki.embedding_artifacts artifact
            ON artifact.public_id = item."artifactPublicId"
           AND artifact.knowledge_base_id = ${input.plan.knowledgeBaseId}
           AND artifact.embedding_configuration_revision_public_id
             = ${input.plan.embeddingConfigurationRevisionPublicId}
           AND artifact.dimension = ${input.plan.definition.dimension}
           AND artifact.owner_kind = item."family"
           AND artifact.owner_public_id = item."ownerPublicId"
           AND artifact.state = 'verified' AND artifact.deleted_at IS NULL
          JOIN focowiki.semantic_embedding_artifact_refs reference
            ON reference.knowledge_base_id = ${input.plan.knowledgeBaseId}
           AND reference.semantic_generation_public_id
             = ${input.plan.semanticGenerationPublicId}
           AND reference.artifact_public_id = artifact.public_id
           AND reference.semantic_owner_kind = item."family"
           AND reference.semantic_owner_public_id = item."ownerPublicId"
           AND reference.source_file_public_id = item."sourceFilePublicId"
          ON CONFLICT (semantic_generation_public_id, public_id) DO UPDATE SET
            projection_contract_public_id = excluded.projection_contract_public_id,
            embedding_configuration_revision_public_id
              = excluded.embedding_configuration_revision_public_id,
            artifact_public_id = excluded.artifact_public_id,
            vector_family = excluded.vector_family,
            owner_public_id = excluded.owner_public_id,
            source_file_public_id = excluded.source_file_public_id,
            source_revision_public_id = excluded.source_revision_public_id,
            evidence_target_path = excluded.evidence_target_path,
            dimension = excluded.dimension,
            provider_document_id = excluded.provider_document_id,
            state = ${documentState}, deleted_at = NULL
          RETURNING vector.public_id
        `;
        if (rows.length !== input.plan.desiredDocuments.length) {
          throw repositoryError("artifact_ownership_invalid");
        }
        return { prepared: rows.length, deleted };
      });
    },
    async confirmImpacts(input) {
      assertTimestamp(input.confirmedAt);
      const ids = input.plan.desiredDocuments.map((document) => document.publicId);
      return sql.begin(async (transaction) => {
        const rows = await transaction<Array<{ valid: boolean }>>`
        WITH current_generation AS (
          SELECT generation_role,
                 ${mutationCandidateSql(transaction, input.plan)} AS mutation_candidate
          FROM focowiki.semantic_generations generation
          WHERE generation.knowledge_base_id = ${input.plan.knowledgeBaseId}
            AND generation.public_id = ${input.plan.semanticGenerationPublicId}
            AND (
              generation.generation_role = 'candidate'
                AND generation.state IN ('building', 'validating')
              OR generation.generation_role = 'active'
                AND generation.state = 'active'
            )
            AND generation.deleted_at IS NULL
        )
        SELECT EXISTS (SELECT 1 FROM current_generation)
        AND (
          SELECT count(*)
          FROM focowiki.semantic_vector_documents vector
          JOIN focowiki.source_files source
            ON source.knowledge_base_id = vector.knowledge_base_id
           AND source.public_id = vector.source_file_public_id
           AND source.deleted_at IS NULL
          WHERE vector.knowledge_base_id = ${input.plan.knowledgeBaseId}
            AND vector.semantic_generation_public_id
              = ${input.plan.semanticGenerationPublicId}
            AND vector.public_id = ANY(${ids})
            AND vector.state = CASE
              WHEN (SELECT generation_role FROM current_generation) = 'active'
                AND NOT (SELECT mutation_candidate FROM current_generation)
              THEN 'active' ELSE 'candidate' END
            AND vector.deleted_at IS NULL
            AND (
              EXISTS (
                SELECT 1
                FROM focowiki.source_file_current_revisions current_revision
                WHERE current_revision.knowledge_base_id = vector.knowledge_base_id
                  AND current_revision.source_file_public_id
                    = vector.source_file_public_id
                  AND current_revision.source_revision_public_id
                    = vector.source_revision_public_id
              )
              OR (SELECT mutation_candidate FROM current_generation)
            )
        ) = ${ids.length} AS valid
      `;
        if (rows[0]?.valid !== true) return false;
        if (input.plan.providerDeleteDocumentIds.length > 0) {
          await transaction`
            DELETE FROM focowiki.semantic_vector_documents
            WHERE knowledge_base_id = ${input.plan.knowledgeBaseId}
              AND semantic_generation_public_id
                = ${input.plan.semanticGenerationPublicId}
              AND public_id = ANY(${input.plan.providerDeleteDocumentIds})
              AND state = 'deleted'
              AND deleted_at IS NOT NULL
          `;
        }
        return true;
      });
    }
  };
}

function mutationCandidateSql(
  sql: DatabaseClient | TransactionSql,
  plan: Parameters<SemanticVectorProjectionRepositoryPort["prepareImpacts"]>[0]["plan"]
) {
  const sources = [...new Map(plan.desiredDocuments.map((document) => [
    document.sourceFilePublicId,
    {
      sourceFilePublicId: document.sourceFilePublicId,
      sourceRevisionPublicId: document.sourceRevisionPublicId
    }
  ])).values()];
  return sql`
    ${plan.operationPublicId}::text IS NOT NULL
    AND ${sources.length}::integer > 0
    AND EXISTS (
      SELECT 1
      FROM focowiki.operation_work_items work
      WHERE work.knowledge_base_id = ${plan.knowledgeBaseId}
        AND work.operation_public_id = ${plan.operationPublicId}
        AND work.work_kind = 'mutation'
        AND work.state IN ('queued', 'running', 'retry')
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset(${sql.json(sources as never)}) AS desired(
            "sourceFilePublicId" text, "sourceRevisionPublicId" text
          )
          LEFT JOIN focowiki.source_revisions revision
            ON revision.knowledge_base_id = work.knowledge_base_id
           AND revision.source_file_public_id = desired."sourceFilePublicId"
           AND revision.public_id = desired."sourceRevisionPublicId"
           AND revision.revision_role = 'candidate'
          WHERE revision.public_id IS NULL
        )
    )
  `;
}

function assertTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw repositoryError("invalid_timestamp");
}

function repositoryError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Semantic vector projection repository error: ${code}`),
    { code }
  );
}
