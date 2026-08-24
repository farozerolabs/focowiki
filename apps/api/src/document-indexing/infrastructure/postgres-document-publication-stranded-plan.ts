import type { DatabaseClient } from "../../db/client.js";
import {
  assertRepositoryIdentity,
  assertRepositoryPositiveInteger,
  assertRepositoryTimestamp,
  repositoryContractError
} from "./document-repository-validation.js";

export function createPostgresDocumentPublicationStrandedPlanReader(
  sql: DatabaseClient
) {
  return {
    async claimStrandedPlan(input: {
      knowledgeBaseId?: string;
      now: string;
      staleAfterMs: number;
    }) {
      const now = assertRepositoryTimestamp(input.now, "now");
      const staleAfterMs = assertRepositoryPositiveInteger(
        input.staleAfterMs,
        "stale_after_ms",
        300_000
      );
      const knowledgeBaseId = input.knowledgeBaseId === undefined
        ? null
        : assertRepositoryIdentity(input.knowledgeBaseId, "knowledge_base_id");
      return sql.begin(async (transaction) => {
        const generations = await transaction<Array<{
          public_id: string;
          knowledge_base_id: string;
          base_generation_public_id: string | null;
          target_fact_epoch: number | string;
          renderer_contract_version: string;
          deterministic_changed_at: Date | string;
        }>>`
          WITH candidate AS (
            SELECT generation.public_id
            FROM focowiki.projection_publication_generations generation
            WHERE generation.state = 'planned'
              AND (${knowledgeBaseId}::text IS NULL
                OR generation.knowledge_base_id = ${knowledgeBaseId})
              AND (
                generation.updated_at <= ${now}::timestamptz
                  - (${staleAfterMs} * interval '1 millisecond')
                OR generation.recovery_evidence->>'outcome'
                  = 'minimum_replacement_planned'
              )
              AND NOT EXISTS (
                SELECT 1
                FROM focowiki.projection_scope_generations scope
                WHERE scope.publication_generation_public_id
                  = generation.public_id
              )
            ORDER BY generation.updated_at,
                     generation.public_id COLLATE "C"
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE focowiki.projection_publication_generations generation
          SET updated_at = ${now}
          FROM candidate
          WHERE generation.public_id = candidate.public_id
          RETURNING generation.public_id, generation.knowledge_base_id,
                    generation.base_generation_public_id,
                    generation.target_fact_epoch,
                    generation.renderer_contract_version,
                    generation.deterministic_changed_at
        `;
        const generation = generations[0];
        if (!generation) return null;
        const documents = await transaction<ReadyFactRow[]>`
          SELECT epoch.fact_epoch, epoch.mutation_public_id,
                 document.document_job_public_id,
                 epoch.source_file_public_id,
                 epoch.source_revision_public_id, epoch.created_at
          FROM focowiki.projection_generation_documents document
          JOIN focowiki.projection_fact_epochs epoch
            ON epoch.knowledge_base_id = ${generation.knowledge_base_id}
           AND epoch.mutation_public_id = document.mutation_public_id
           AND epoch.fact_epoch = document.fact_epoch
          WHERE document.generation_public_id = ${generation.public_id}
            AND epoch.state = 'included'
          ORDER BY epoch.created_at, epoch.fact_epoch
        `;
        if (documents.length === 0) {
          throw repositoryContractError(
            "publication_stranded_plan_documents_missing"
          );
        }
        return {
          generationPublicId: generation.public_id,
          knowledgeBaseId: generation.knowledge_base_id,
          baseGenerationPublicId: generation.base_generation_public_id,
          targetFactEpoch: Number(generation.target_fact_epoch),
          rendererContractVersion: generation.renderer_contract_version,
          deterministicChangedAt: new Date(
            generation.deterministic_changed_at
          ).toISOString(),
          documents: documents.map(mapReadyFact)
        };
      });
    }
  };
}

type ReadyFactRow = {
  fact_epoch: number | string;
  mutation_public_id: string;
  document_job_public_id: string | null;
  source_file_public_id: string;
  source_revision_public_id: string;
  created_at: Date | string;
};

function mapReadyFact(row: ReadyFactRow) {
  return {
    mutationPublicId: row.mutation_public_id,
    documentJobPublicId: row.document_job_public_id,
    sourceFilePublicId: row.source_file_public_id,
    sourceRevisionPublicId: row.source_revision_public_id,
    factEpoch: Number(row.fact_epoch),
    readyAt: new Date(row.created_at).toISOString()
  };
}
