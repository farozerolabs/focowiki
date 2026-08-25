import type { DatabaseClient } from "../../db/client.js";
import {
  assertRepositoryPositiveInteger,
  assertRepositoryTimestamp,
  repositoryContractError
} from "./document-repository-validation.js";

const LEGACY_NAVIGATION_CHANGE_LIMIT = 10_000;

export async function recoverPostgresDocumentPublicationQuarantines(
  sql: DatabaseClient,
  input: Readonly<{
    recoveredAt: string;
    limit: number;
    rendererContractVersion?: string;
  }>
) {
  const recoveredAt = assertRepositoryTimestamp(
    input.recoveredAt,
    "recovered_at"
  );
  const limit = assertRepositoryPositiveInteger(input.limit, "limit", 256);
  const rendererContractVersion = input.rendererContractVersion ?? null;
  if (rendererContractVersion !== null
    && (!rendererContractVersion
      || Buffer.byteLength(rendererContractVersion, "utf8") > 128)) {
    throw repositoryContractError("renderer_contract_version_invalid");
  }
  return sql.begin(async (transaction) => {
    const generations = await transaction<Array<{
      public_id: string;
      knowledge_base_id: string;
    }>>`
      SELECT generation.public_id, generation.knowledge_base_id
      FROM focowiki.projection_publication_generations generation
      WHERE generation.state = 'quarantined'
        AND (generation.safe_error_code IN (
          'graph_directory_record_limit_exceeded',
          'per_file_graph_directory_limit_exceeded',
          'navigation_delta_window_exceeded',
          'semantic_directory_navigation_candidate_limit_exceeded',
          'scope_generation_deadline_exceeded'
        )
          OR generation.safe_error_code IN (
            '53000', '53100', '53200', '53300', '53400'
          )
          OR (
            ${rendererContractVersion}::text IS NOT NULL
            AND generation.renderer_contract_version
                  <> ${rendererContractVersion}
            AND generation.safe_error_code IN (
              'portable_record_order_invalid',
              'portable_record_duplicate'
            )
          )
          OR (
            generation.safe_error_code = 'changes_invalid'
            AND EXISTS (
              SELECT 1
              FROM focowiki.projection_scope_generations scope
              WHERE scope.publication_generation_public_id =
                generation.public_id
                AND scope.state = 'quarantined'
                AND scope.scope_kind = 'directory'
                AND (
                  SELECT count(*)
                  FROM (
                    SELECT 1
                    FROM focowiki.document_semantic_directory_memberships
                      membership
                    JOIN focowiki.document_projection_records record
                      ON record.knowledge_base_id =
                        membership.knowledge_base_id
                     AND record.source_revision_public_id =
                        membership.source_revision_public_id
                    WHERE membership.knowledge_base_id =
                      generation.knowledge_base_id
                      AND membership.directory_path = scope.scope_key
                      AND position('/' in substring(
                        membership.page_path
                        from char_length(scope.scope_key) + 2
                      )) = 0
                      AND (
                        EXISTS (
                          SELECT 1
                          FROM focowiki.projection_generation_documents
                            document
                          WHERE document.generation_public_id =
                            generation.public_id
                            AND document.source_revision_public_id =
                              record.source_revision_public_id
                        )
                        OR (
                          record.active
                          AND NOT EXISTS (
                            SELECT 1
                            FROM focowiki.projection_generation_documents
                              document
                            WHERE document.generation_public_id =
                              generation.public_id
                              AND document.source_file_public_id =
                                record.source_file_public_id
                          )
                        )
                      )
                    LIMIT ${LEGACY_NAVIGATION_CHANGE_LIMIT + 1}
                  ) visible_records
                ) > ${LEGACY_NAVIGATION_CHANGE_LIMIT}
            )
          ))
      ORDER BY generation.updated_at, generation.public_id COLLATE "C"
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
            WHEN safe_error_code = 'changes_invalid'
              THEN 'navigation_change_limit_remediated'
            WHEN safe_error_code = 'navigation_delta_window_exceeded'
              THEN 'navigation_delta_window_remediated'
            WHEN safe_error_code =
              'semantic_directory_navigation_candidate_limit_exceeded'
              THEN 'semantic_directory_navigation_limit_remediated'
            WHEN safe_error_code = 'scope_generation_deadline_exceeded'
              THEN 'scope_generation_deadline_remediated'
            WHEN safe_error_code IN (
              'graph_directory_record_limit_exceeded',
              'per_file_graph_directory_limit_exceeded'
            )
              THEN 'graph_directory_record_limit_remediated'
            WHEN safe_error_code IN (
              'portable_record_order_invalid',
              'portable_record_duplicate'
            )
              THEN 'portable_record_order_remediated'
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
}
