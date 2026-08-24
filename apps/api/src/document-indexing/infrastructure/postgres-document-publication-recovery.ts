import type { DatabaseClient } from "../../db/client.js";
import {
  assertRepositoryIdentity,
  assertRepositoryPositiveInteger,
  assertRepositoryTimestamp,
  repositoryContractError
} from "./document-repository-validation.js";
import { createMinimumCompatiblePublicationReplacement } from
  "./postgres-document-publication-minimum-replan.js";

const LEGACY_NAVIGATION_CHANGE_LIMIT = 10_000;

export function createPostgresDocumentPublicationRecovery(
  sql: DatabaseClient
) {
  return {
    async recoverStrandedReplacements(input: Readonly<{
      rendererContractVersion: string;
      recoveredAt: string;
      limit: number;
    }>) {
      const recoveredAt = assertRepositoryTimestamp(
        input.recoveredAt,
        "recovered_at"
      );
      const limit = assertRepositoryPositiveInteger(input.limit, "limit", 256);
      if (!input.rendererContractVersion
        || Buffer.byteLength(input.rendererContractVersion, "utf8") > 128) {
        throw repositoryContractError("renderer_contract_version_invalid");
      }
      return sql.begin(async (transaction) => {
        const generations = await transaction<Array<{
          public_id: string;
          knowledge_base_id: string;
        }>>`
          SELECT generation.public_id, generation.knowledge_base_id
          FROM focowiki.projection_publication_generations generation
          JOIN focowiki.knowledge_base_projection_heads head
            ON head.knowledge_base_id = generation.knowledge_base_id
          LEFT JOIN focowiki.projection_publication_generations successor
            ON successor.public_id =
                 generation.superseded_by_generation_public_id
          WHERE generation.state = 'obsolete'
            AND generation.recovery_evidence->>'outcome'
                  = 'minimum_replacement_planned'
            AND head.active_generation_public_id IS DISTINCT FROM
                  generation.public_id
            AND (successor.public_id IS NULL OR successor.state IN (
              'obsolete', 'quarantined'
            ))
            AND NOT EXISTS (
              SELECT 1
              FROM focowiki.projection_publication_generations live
              WHERE live.knowledge_base_id = generation.knowledge_base_id
                AND live.state IN ('planned', 'rendering', 'validating', 'ready')
            )
          ORDER BY generation.updated_at DESC,
                   generation.public_id COLLATE "C"
          FOR UPDATE OF generation, head SKIP LOCKED
          LIMIT ${limit}
        `;
        const recoveredKnowledgeBases = new Set<string>();
        const replacements = [];
        for (const generation of generations) {
          if (recoveredKnowledgeBases.has(generation.knowledge_base_id)) continue;
          const replacement = await createMinimumCompatiblePublicationReplacement(
            transaction as unknown as DatabaseClient,
            {
              generationPublicId: generation.public_id,
              rendererContractVersion: input.rendererContractVersion,
              supersessionReason: "publication_replacement_stranded",
              recoveredAt,
              recoverObsoleteStranded: true
            }
          );
          if (replacement) {
            replacements.push(replacement);
            recoveredKnowledgeBases.add(generation.knowledge_base_id);
          }
        }
        return {
          generationCount: replacements.length,
          releasedFactCount: 0,
          replannedFactCount: replacements.reduce((total, item) =>
            total + item.factCount, 0),
          supersededScopeCount: replacements.reduce((total, item) =>
            total + item.supersededScopeCount, 0)
        };
      });
    },

    async recoverIncompatibleGenerations(input: Readonly<{
      rendererContractVersion: string;
      recoveredAt: string;
      limit: number;
    }>) {
      const recoveredAt = assertRepositoryTimestamp(
        input.recoveredAt,
        "recovered_at"
      );
      const limit = assertRepositoryPositiveInteger(input.limit, "limit", 256);
      if (!input.rendererContractVersion
        || Buffer.byteLength(input.rendererContractVersion, "utf8") > 128) {
        throw repositoryContractError("renderer_contract_version_invalid");
      }
      return sql.begin(async (transaction) => {
        const generations = await transaction<Array<{
          public_id: string;
          knowledge_base_id: string;
        }>>`
          SELECT generation.public_id, generation.knowledge_base_id
          FROM focowiki.projection_publication_generations generation
          JOIN focowiki.knowledge_base_projection_heads head
            ON head.knowledge_base_id = generation.knowledge_base_id
          WHERE generation.state IN (
              'planned', 'rendering', 'validating', 'ready'
            )
            AND generation.renderer_contract_version
                  <> ${input.rendererContractVersion}
            AND head.active_generation_public_id IS DISTINCT FROM
                  generation.public_id
          ORDER BY generation.updated_at,
                   generation.public_id COLLATE "C"
          FOR UPDATE OF generation, head SKIP LOCKED
          LIMIT ${limit}
        `;
        if (generations.length === 0) {
          return {
            generationCount: 0,
            releasedFactCount: 0,
            replannedFactCount: 0,
            supersededScopeCount: 0
          };
        }
        const replacements = [];
        for (const generation of generations) {
          const replacement = await createMinimumCompatiblePublicationReplacement(
            transaction as unknown as DatabaseClient,
            {
              generationPublicId: generation.public_id,
              rendererContractVersion: input.rendererContractVersion,
              supersessionReason:
                "publication_renderer_contract_incompatible",
              recoveredAt
            }
          );
          if (replacement) replacements.push(replacement);
        }
        return {
          generationCount: replacements.length,
          releasedFactCount: 0,
          replannedFactCount: replacements.reduce((total, item) =>
            total + item.factCount, 0),
          supersededScopeCount: replacements.reduce((total, item) =>
            total + item.supersededScopeCount, 0)
        };
      });
    },

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
          SELECT generation.public_id, generation.knowledge_base_id
          FROM focowiki.projection_publication_generations generation
          WHERE generation.state = 'quarantined'
            AND (generation.safe_error_code IN (
              'graph_directory_record_limit_exceeded',
              'per_file_graph_directory_limit_exceeded',
              'navigation_delta_window_exceeded'
            )
              OR generation.safe_error_code IN (
                '53000', '53100', '53200', '53300', '53400'
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
                WHEN safe_error_code IN (
                  'graph_directory_record_limit_exceeded',
                  'per_file_graph_directory_limit_exceeded'
                )
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
