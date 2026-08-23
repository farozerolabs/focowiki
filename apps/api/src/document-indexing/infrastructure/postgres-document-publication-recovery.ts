import type { DatabaseClient } from "../../db/client.js";
import {
  assertRepositoryIdentity,
  assertRepositoryPositiveInteger,
  assertRepositoryTimestamp,
  repositoryContractError
} from "./document-repository-validation.js";

export function createPostgresDocumentPublicationRecovery(
  sql: DatabaseClient
) {
  return {
    async recoverRecoverableQuarantines(input: Readonly<{
      recoveredAt: string;
      limit: number;
    }>) {
      const recoveredAt = assertRepositoryTimestamp(
        input.recoveredAt,
        "recovered_at"
      );
      const limit = assertRepositoryPositiveInteger(input.limit, "limit", 256);
      return sql.begin(async (transaction) => {
        const generations = await transaction<Array<{
          public_id: string;
          knowledge_base_id: string;
        }>>`
          SELECT public_id, knowledge_base_id
          FROM focowiki.projection_publication_generations
          WHERE state = 'quarantined'
            AND (safe_error_code = 'graph_directory_record_limit_exceeded'
              OR safe_error_code IN ('53000', '53100', '53200', '53300', '53400'))
          ORDER BY updated_at, public_id COLLATE "C"
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        `;
        if (generations.length === 0) {
          return {
            generationCount: 0,
            releasedFactCount: 0,
            supersededScopeCount: 0
          };
        }
        const generationIds = generations.map((item) => item.public_id);
        const superseded = await transaction<Array<{ public_id: string }>>`
          UPDATE focowiki.projection_scope_generations
          SET state = 'superseded', lease_owner = NULL,
              lease_expires_at = NULL, heartbeat_at = NULL,
              updated_at = ${recoveredAt}
          WHERE publication_generation_public_id = ANY(${generationIds}::text[])
            AND state IN ('waiting', 'running', 'error', 'quarantined')
          RETURNING public_id
        `;
        const released = await transaction<Array<{
          knowledge_base_id: string;
          fact_epoch: number | string;
        }>>`
          UPDATE focowiki.projection_fact_epochs epoch
          SET state = 'ready'
          FROM focowiki.projection_generation_documents document
          JOIN focowiki.projection_publication_generations generation
            ON generation.public_id = document.generation_public_id
          WHERE document.generation_public_id = ANY(${generationIds}::text[])
            AND epoch.knowledge_base_id = generation.knowledge_base_id
            AND epoch.mutation_public_id = document.mutation_public_id
            AND epoch.fact_epoch = document.fact_epoch
            AND epoch.state = 'included'
          RETURNING epoch.knowledge_base_id, epoch.fact_epoch
        `;
        await transaction`
          UPDATE focowiki.projection_publication_generations
          SET state = 'obsolete', completed_at = ${recoveredAt},
              activation_next_eligible_at = NULL,
              safe_error_code = CASE
                WHEN safe_error_code = 'graph_directory_record_limit_exceeded'
                  THEN 'graph_directory_record_limit_remediated'
                ELSE 'database_resource_exhaustion_remediated'
              END,
              updated_at = ${recoveredAt}
          WHERE public_id = ANY(${generationIds}::text[])
        `;
        return {
          generationCount: generations.length,
          releasedFactCount: released.length,
          supersededScopeCount: superseded.length
        };
      });
    },

    async recoverStaleBase(input: Readonly<{
      generationPublicId: string;
      recoveredAt: string;
    }>) {
      const generationPublicId = assertRepositoryIdentity(
        input.generationPublicId,
        "generation_public_id"
      );
      const recoveredAt = assertRepositoryTimestamp(
        input.recoveredAt,
        "recovered_at"
      );
      return sql.begin(async (transaction) => {
        const identities = await transaction<Array<{
          knowledge_base_id: string;
        }>>`
          SELECT knowledge_base_id
          FROM focowiki.projection_publication_generations
          WHERE public_id = ${generationPublicId}
        `;
        const identity = identities[0];
        if (!identity) {
          throw repositoryContractError("publication_generation_not_found");
        }
        const heads = await transaction<Array<{
          active_generation_public_id: string | null;
        }>>`
          SELECT active_generation_public_id
          FROM focowiki.knowledge_base_projection_heads
          WHERE knowledge_base_id = ${identity.knowledge_base_id}
          FOR UPDATE
        `;
        const generations = await transaction<Array<{
          knowledge_base_id: string;
          base_generation_public_id: string | null;
          state: string;
        }>>`
          SELECT knowledge_base_id, base_generation_public_id, state
          FROM focowiki.projection_publication_generations
          WHERE public_id = ${generationPublicId}
          FOR UPDATE
        `;
        const generation = generations[0];
        if (!generation || generation.knowledge_base_id
          !== identity.knowledge_base_id) {
          throw repositoryContractError("publication_generation_not_found");
        }
        if (generation.state === "obsolete") {
          return readRecoveryCounts(
            transaction as unknown as DatabaseClient,
            generationPublicId,
            generation.knowledge_base_id);
        }
        if (!["planned", "rendering", "validating", "ready"]
          .includes(generation.state)) {
          throw repositoryContractError(
            "publication_generation_not_recoverable"
          );
        }
        if (heads[0]?.active_generation_public_id
          === generation.base_generation_public_id) {
          throw repositoryContractError(
            "publication_generation_base_not_stale"
          );
        }
        const superseded = await transaction<Array<{ public_id: string }>>`
          UPDATE focowiki.projection_scope_generations
          SET state = 'superseded', lease_owner = NULL,
              lease_expires_at = NULL, heartbeat_at = NULL,
              updated_at = ${recoveredAt}
          WHERE publication_generation_public_id = ${generationPublicId}
            AND state IN ('waiting', 'running', 'error')
          RETURNING public_id
        `;
        const released = await transaction<Array<{ fact_epoch: number }>>`
          UPDATE focowiki.projection_fact_epochs epoch
          SET state = 'ready'
          FROM focowiki.projection_generation_documents document
          WHERE document.generation_public_id = ${generationPublicId}
            AND epoch.knowledge_base_id = ${generation.knowledge_base_id}
            AND epoch.mutation_public_id = document.mutation_public_id
            AND epoch.fact_epoch = document.fact_epoch
            AND epoch.state = 'included'
          RETURNING epoch.fact_epoch
        `;
        await transaction`
          UPDATE focowiki.projection_publication_generations
          SET state = 'obsolete', completed_at = ${recoveredAt},
              activation_next_eligible_at = NULL,
              safe_error_code = 'publication_generation_stale_base',
              updated_at = ${recoveredAt}
          WHERE public_id = ${generationPublicId}
        `;
        return {
          generationPublicId,
          knowledgeBaseId: generation.knowledge_base_id,
          releasedFactCount: released.length,
          supersededScopeCount: superseded.length
        };
      });
    }
  };
}

async function readRecoveryCounts(
  sql: DatabaseClient,
  generationPublicId: string,
  knowledgeBaseId: string
) {
  const rows = await sql<Array<{
    released_fact_count: number | string;
    superseded_scope_count: number | string;
  }>>`
    SELECT
      (SELECT count(*)
       FROM focowiki.projection_generation_documents document
       JOIN focowiki.projection_fact_epochs epoch
         ON epoch.knowledge_base_id = ${knowledgeBaseId}
        AND epoch.mutation_public_id = document.mutation_public_id
        AND epoch.fact_epoch = document.fact_epoch
       WHERE document.generation_public_id = ${generationPublicId}
         AND epoch.state = 'ready') AS released_fact_count,
      (SELECT count(*) FROM focowiki.projection_scope_generations
       WHERE publication_generation_public_id = ${generationPublicId}
         AND state = 'superseded') AS superseded_scope_count
  `;
  return {
    generationPublicId,
    knowledgeBaseId,
    releasedFactCount: Number(rows[0]?.released_fact_count ?? 0),
    supersededScopeCount: Number(rows[0]?.superseded_scope_count ?? 0)
  };
}
