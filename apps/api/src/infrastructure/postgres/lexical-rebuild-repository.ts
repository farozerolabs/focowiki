import type {
  LexicalRebuildClaim,
  LexicalRebuildRepository,
  LexicalRebuildSource
} from "../../application/ports/lexical-rebuild-repository.js";
import type { DatabaseClient } from "../../db/client.js";
import type { TransactionSql } from "postgres";
import { hasPendingForwardWork } from "./forward-work-pending.js";
import { advanceProjectionVersionOwnership } from "./projection-version-ownership.js";

type ClaimRow = {
  knowledge_base_id: string;
  base_generation_id: string;
  target_generation_id: string;
  lease_recovered: boolean;
  state: LexicalRebuildClaim["state"];
  phase: LexicalRebuildClaim["phase"];
  source_cursor: string | null;
  processed_source_count: number;
  total_source_count: number;
};

type SourceRow = {
  source_file_id: string;
  source_revision_id: string;
  relative_path: string;
  object_key: string;
  title: string;
  summary: string | null;
  source_url: string | null;
  metadata_json: LexicalRebuildSource["metadata"];
  suggestions_json: LexicalRebuildSource["suggestions"];
};

export function createPostgresLexicalRebuildRepository(
  sql: DatabaseClient
): LexicalRebuildRepository {
  return {
    async bootstrap(input) {
      const rows = await sql<Array<{ knowledge_base_id: string }>>`
        INSERT INTO focowiki.knowledge_base_lexical_rebuilds (
          knowledge_base_id, target_search_schema_version,
          target_tokenizer_contract_version, target_segmentation_version,
          target_content_profile_version,
          target_graph_lexical_projection_version,
          base_generation_id, state, phase, next_attempt_at, created_at, updated_at
        )
        SELECT knowledge_base.id, ${input.searchSchemaVersion},
               ${input.tokenizerContractVersion}, ${input.segmentationVersion},
               ${input.contentProfileVersion},
               ${input.graphLexicalProjectionVersion},
               knowledge_base.active_generation_id, 'pending', 'documents',
               ${input.now}, ${input.now}, ${input.now}
        FROM focowiki.knowledge_bases knowledge_base
        JOIN focowiki.publication_generations generation
          ON generation.knowledge_base_id = knowledge_base.id
         AND generation.id = knowledge_base.active_generation_id
         AND generation.state = 'active'
        WHERE knowledge_base.deleted_at IS NULL
          AND (
            ${input.knowledgeBaseIds === undefined}
            OR knowledge_base.id = ANY(${input.knowledgeBaseIds ?? []})
          )
          AND (
            generation.search_schema_version IS DISTINCT FROM ${input.searchSchemaVersion}
            OR generation.tokenizer_contract_version
                 IS DISTINCT FROM ${input.tokenizerContractVersion}
            OR generation.search_segmentation_version
                 IS DISTINCT FROM ${input.segmentationVersion}
            OR EXISTS (
              SELECT 1
              FROM focowiki.source_files source
              LEFT JOIN focowiki.source_file_graph_nodes node
                ON node.knowledge_base_id = source.knowledge_base_id
               AND node.source_file_id = source.id
              LEFT JOIN focowiki.source_file_graph_term_documents terms
                ON terms.knowledge_base_id = source.knowledge_base_id
               AND terms.source_file_id = source.id
              WHERE source.knowledge_base_id = knowledge_base.id
                AND source.deleted_at IS NULL
                AND source.deletion_intent_id IS NULL
                AND (
                  node.source_file_id IS NULL
                  OR node.tokenizer_contract_version
                       IS DISTINCT FROM ${input.tokenizerContractVersion}
                  OR node.lexical_projection_version
                       IS DISTINCT FROM ${input.contentProfileVersion}
                  OR terms.source_file_id IS NULL
                  OR terms.source_revision_id IS DISTINCT FROM source.active_revision_id
                  OR terms.tokenizer_contract_version
                       IS DISTINCT FROM ${input.tokenizerContractVersion}
                  OR terms.lexical_projection_version
                       IS DISTINCT FROM ${input.graphLexicalProjectionVersion}
                )
            )
          )
        ON CONFLICT (knowledge_base_id) DO UPDATE
        SET target_search_schema_version = EXCLUDED.target_search_schema_version,
            target_tokenizer_contract_version = EXCLUDED.target_tokenizer_contract_version,
            target_segmentation_version = EXCLUDED.target_segmentation_version,
            target_content_profile_version = EXCLUDED.target_content_profile_version,
            target_graph_lexical_projection_version =
              EXCLUDED.target_graph_lexical_projection_version,
            base_generation_id = EXCLUDED.base_generation_id,
            target_generation_id = NULL,
            state = 'pending',
            phase = 'documents',
            source_cursor = NULL,
            processed_source_count = 0,
            total_source_count = 0,
            rebase_count = 0,
            lease_owner = NULL,
            lease_token = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            attempt_count = 0,
            next_attempt_at = EXCLUDED.next_attempt_at,
            last_error_code = NULL,
            last_error_message = NULL,
            started_at = NULL,
            validated_at = NULL,
            completed_at = NULL,
            updated_at = EXCLUDED.updated_at
        WHERE knowledge_base_lexical_rebuilds.state
              IN ('completed', 'failed', 'cancelled')
        RETURNING knowledge_base_id
      `;
      return rows.length;
    },

    async claimNext(input) {
      return sql.begin(async (transaction) => {
        const rows = await transaction<ClaimRow[]>`
          WITH candidate AS MATERIALIZED (
            SELECT rebuild.knowledge_base_id,
                   rebuild.lease_owner IS NOT NULL
                     AND rebuild.lease_expires_at IS NOT NULL
                     AND rebuild.lease_expires_at <= ${input.now}
                     AS lease_recovered
            FROM focowiki.knowledge_base_lexical_rebuilds rebuild
            JOIN focowiki.knowledge_bases knowledge_base
              ON knowledge_base.id = rebuild.knowledge_base_id
             AND knowledge_base.deleted_at IS NULL
            WHERE rebuild.state IN (
              'pending', 'running', 'validating', 'activating', 'failed'
            )
              AND rebuild.attempt_count < rebuild.max_attempts
              AND rebuild.next_attempt_at <= ${input.now}
              AND (
                rebuild.lease_expires_at IS NULL
                OR rebuild.lease_expires_at <= ${input.now}
              )
            ORDER BY rebuild.updated_at, rebuild.knowledge_base_id
            LIMIT 1
            FOR UPDATE OF rebuild SKIP LOCKED
          )
          UPDATE focowiki.knowledge_base_lexical_rebuilds rebuild
          SET lease_owner = ${input.workerId},
              lease_token = ${input.leaseToken},
              lease_expires_at = ${input.leaseExpiresAt},
              heartbeat_at = ${input.now},
              started_at = coalesce(rebuild.started_at, ${input.now}),
              state = CASE
                WHEN rebuild.phase = 'validate' THEN 'validating'
                WHEN rebuild.phase = 'activate' THEN 'activating'
                ELSE 'running'
              END,
              last_error_code = NULL,
              last_error_message = NULL,
              updated_at = ${input.now}
          FROM candidate
          WHERE rebuild.knowledge_base_id = candidate.knowledge_base_id
          RETURNING rebuild.knowledge_base_id, rebuild.base_generation_id,
                    rebuild.target_generation_id, rebuild.state, rebuild.phase,
                    rebuild.source_cursor, rebuild.processed_source_count,
                    rebuild.total_source_count, candidate.lease_recovered
        `;
        const claimed = rows[0];
        if (!claimed?.base_generation_id) return null;
        if (!claimed.target_generation_id) {
          const generation = await transaction<Array<{ id: string }>>`
            INSERT INTO focowiki.publication_generations (
              id, knowledge_base_id, predecessor_generation_id, state,
              format_version, generation_kind, root_manifest_checksum_sha256,
              root_manifest_object_key
            )
            SELECT ${input.targetGenerationId}, base.knowledge_base_id, base.id,
                   'building', base.format_version, 'lexical_rebuild',
                   base.root_manifest_checksum_sha256, base.root_manifest_object_key
            FROM focowiki.publication_generations base
            WHERE base.knowledge_base_id = ${claimed.knowledge_base_id}
              AND base.id = ${claimed.base_generation_id}
              AND base.state = 'active'
            RETURNING id
          `;
          if (!generation[0]) {
            await releaseForRebase(transaction, {
              knowledgeBaseId: claimed.knowledge_base_id,
              updatedAt: input.now
            });
            return null;
          }
          claimed.target_generation_id = generation[0].id;
          await transaction`
            UPDATE focowiki.knowledge_base_lexical_rebuilds
            SET target_generation_id = ${generation[0].id},
                total_source_count = (
                  SELECT count(*)
                  FROM focowiki.source_files source
                  WHERE source.knowledge_base_id = ${claimed.knowledge_base_id}
                    AND source.deleted_at IS NULL
                    AND source.deletion_intent_id IS NULL
                ),
                updated_at = ${input.now}
            WHERE knowledge_base_id = ${claimed.knowledge_base_id}
          `;
        }
        return mapClaim(claimed);
      });
    },

    async listSourceBatch(input) {
      const rows = await sql<SourceRow[]>`
        WITH source_page AS MATERIALIZED (
          SELECT source.id, source.knowledge_base_id, source.active_revision_id,
                 source.name, source.relative_path, source.metadata_json,
                 source.model_suggestions_json
          FROM focowiki.source_files source
          WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
            AND source.deleted_at IS NULL
            AND source.deletion_intent_id IS NULL
            AND (${input.afterSourceFileId}::text IS NULL
                 OR source.id > ${input.afterSourceFileId})
            AND (
              ${input.targetGenerationId}::text IS NULL
              OR NOT EXISTS (
                SELECT 1
                FROM focowiki.generation_search_projection_refs reference
                JOIN focowiki.search_projection_documents document
                  ON document.knowledge_base_id = reference.knowledge_base_id
                 AND document.id = reference.search_document_id
                JOIN focowiki.knowledge_base_lexical_rebuilds rebuild
                  ON rebuild.knowledge_base_id = reference.knowledge_base_id
                WHERE reference.knowledge_base_id = source.knowledge_base_id
                  AND reference.generation_id = ${input.targetGenerationId}
                  AND reference.source_file_id = source.id
                  AND reference.source_revision_id = source.active_revision_id
                  AND reference.logical_path = 'pages/' || source.relative_path
                  AND reference.search_schema_version
                        = rebuild.target_search_schema_version
                  AND reference.tokenizer_contract_version
                        = rebuild.target_tokenizer_contract_version
                  AND reference.segmentation_version
                        = rebuild.target_segmentation_version
                  AND document.lifecycle_state = 'ready'
                  AND EXISTS (
                    SELECT 1
                    FROM focowiki.source_file_graph_nodes node
                    WHERE node.knowledge_base_id = source.knowledge_base_id
                      AND node.source_file_id = source.id
                      AND node.tokenizer_contract_version
                            = rebuild.target_tokenizer_contract_version
                      AND node.lexical_projection_version
                            = rebuild.target_content_profile_version
                  )
                  AND EXISTS (
                    SELECT 1
                    FROM focowiki.source_file_graph_term_documents terms
                    WHERE terms.knowledge_base_id = source.knowledge_base_id
                      AND terms.source_file_id = source.id
                      AND terms.source_revision_id = source.active_revision_id
                      AND terms.tokenizer_contract_version
                            = rebuild.target_tokenizer_contract_version
                      AND terms.lexical_projection_version
                            = rebuild.target_graph_lexical_projection_version
                  )
              )
            )
          ORDER BY source.id
          LIMIT ${boundedLimit(input.limit)}
        )
        SELECT source.id AS source_file_id,
               revision.id AS source_revision_id,
               source.relative_path, revision.object_key,
               coalesce(nullif(node.title, ''), source.name) AS title,
               coalesce(
                 nullif(node.summary, ''),
                 nullif(node.description, ''),
                 nullif(revision.metadata_json->>'description', '')
               ) AS summary,
               coalesce(
                 nullif(node.metadata_json->>'resource', ''),
                 nullif(node.metadata_json->>'sourceUrl', ''),
                 nullif(node.metadata_json->>'url', '')
               ) AS source_url,
               coalesce(revision.metadata_json, source.metadata_json, '{}'::jsonb)
                 AS metadata_json,
               source.model_suggestions_json AS suggestions_json
        FROM source_page source
        JOIN focowiki.source_revisions revision
          ON revision.knowledge_base_id = source.knowledge_base_id
         AND revision.source_file_id = source.id
         AND revision.id = source.active_revision_id
        LEFT JOIN focowiki.source_file_graph_nodes node
          ON node.knowledge_base_id = source.knowledge_base_id
         AND node.source_file_id = source.id
        ORDER BY source.id
      `;
      return rows.map((row) => ({
        sourceFileId: row.source_file_id,
        sourceRevisionId: row.source_revision_id,
        relativePath: row.relative_path,
        objectKey: row.object_key,
        title: row.title,
        summary: row.summary,
        sourceUrl: row.source_url,
        metadata: row.metadata_json,
        suggestions: row.suggestions_json
      }));
    },

    async removeStaleGenerationReferences(input) {
      const rows = await sql<Array<{ source_file_id: string }>>`
        DELETE FROM focowiki.generation_search_projection_refs reference
        USING focowiki.knowledge_base_lexical_rebuilds rebuild
        WHERE rebuild.knowledge_base_id = ${input.knowledgeBaseId}
          AND reference.knowledge_base_id = rebuild.knowledge_base_id
          AND reference.generation_id = ${input.targetGenerationId}
          AND (
            reference.search_schema_version
              IS DISTINCT FROM rebuild.target_search_schema_version
            OR reference.tokenizer_contract_version
              IS DISTINCT FROM rebuild.target_tokenizer_contract_version
            OR reference.segmentation_version
              IS DISTINCT FROM rebuild.target_segmentation_version
            OR NOT EXISTS (
              SELECT 1
              FROM focowiki.source_files source
              WHERE source.knowledge_base_id = reference.knowledge_base_id
                AND source.id = reference.source_file_id
                AND source.deleted_at IS NULL
                AND source.deletion_intent_id IS NULL
                AND source.active_revision_id = reference.source_revision_id
                AND 'pages/' || source.relative_path = reference.logical_path
            )
          )
        RETURNING reference.source_file_id
      `;
      return rows.length;
    },

    async heartbeat(input) {
      const rows = await sql<Array<{ knowledge_base_id: string }>>`
        UPDATE focowiki.knowledge_base_lexical_rebuilds
        SET heartbeat_at = ${input.heartbeatAt},
            lease_expires_at = ${input.leaseExpiresAt},
            updated_at = ${input.heartbeatAt}
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND lease_owner = ${input.workerId}
          AND lease_token = ${input.leaseToken}
        RETURNING knowledge_base_id
      `;
      assertOwned(rows);
    },

    async recordDocumentProgress(input) {
      const rows = await sql<Array<{ knowledge_base_id: string }>>`
        UPDATE focowiki.knowledge_base_lexical_rebuilds
        SET source_cursor = ${input.sourceCursor},
            processed_source_count = least(
              total_source_count,
              processed_source_count + ${input.processedCount}
            ),
            heartbeat_at = ${input.updatedAt},
            lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
            updated_at = ${input.updatedAt}
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND lease_owner = ${input.workerId}
          AND lease_token = ${input.leaseToken}
        RETURNING knowledge_base_id
      `;
      assertOwned(rows);
    },

    async advancePhase(input) {
      const rows = await sql<Array<{ knowledge_base_id: string }>>`
        UPDATE focowiki.knowledge_base_lexical_rebuilds
        SET phase = ${input.phase},
            state = CASE
              WHEN ${input.phase} = 'validate' THEN 'validating'
              WHEN ${input.phase} = 'activate' THEN 'activating'
              ELSE 'running'
            END,
            source_cursor = CASE
              WHEN ${input.phase} = 'reconcile' THEN NULL
              ELSE source_cursor
            END,
            processed_source_count = CASE
              WHEN ${input.phase} = 'reconcile' THEN least(
                processed_source_count,
                (
                  SELECT count(*)
                  FROM focowiki.source_files source
                  WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
                    AND source.deleted_at IS NULL
                    AND source.deletion_intent_id IS NULL
                )
              )
              ELSE processed_source_count
            END,
            total_source_count = CASE
              WHEN ${input.phase} = 'reconcile' THEN (
                SELECT count(*)
                FROM focowiki.source_files source
                WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
                  AND source.deleted_at IS NULL
                  AND source.deletion_intent_id IS NULL
              )
              ELSE total_source_count
            END,
            lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
            heartbeat_at = ${input.updatedAt}, updated_at = ${input.updatedAt}
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND lease_owner = ${input.workerId}
          AND lease_token = ${input.leaseToken}
        RETURNING knowledge_base_id
      `;
      assertOwned(rows);
    },

    async validate(input) {
      const rows = await sql<Array<{
        visible_count: number;
        reference_count: number;
        invalid_count: number;
        target_search_schema_version: string;
        target_tokenizer_contract_version: string;
        target_segmentation_version: string;
        invalid_profile_count: number;
        invalid_graph_term_count: number;
        invalid_accepted_edge_parity_count: number;
      }>>`
        SELECT
          (
            SELECT count(*)::int
            FROM focowiki.source_files source
            WHERE source.knowledge_base_id = rebuild.knowledge_base_id
              AND source.deleted_at IS NULL
              AND source.deletion_intent_id IS NULL
          ) AS visible_count,
          (
            SELECT count(*)::int
            FROM focowiki.generation_search_projection_refs reference
            WHERE reference.generation_id = rebuild.target_generation_id
          ) AS reference_count,
          (
            SELECT count(*)::int
            FROM focowiki.generation_search_projection_refs reference
            JOIN focowiki.search_projection_documents document
              ON document.knowledge_base_id = reference.knowledge_base_id
             AND document.id = reference.search_document_id
            LEFT JOIN focowiki.source_files source
              ON source.knowledge_base_id = reference.knowledge_base_id
             AND source.id = reference.source_file_id
             AND source.deleted_at IS NULL
             AND source.deletion_intent_id IS NULL
            WHERE reference.generation_id = rebuild.target_generation_id
              AND (
                source.id IS NULL
                OR source.active_revision_id
                     IS DISTINCT FROM reference.source_revision_id
                OR reference.logical_path
                     IS DISTINCT FROM 'pages/' || source.relative_path
                OR document.lifecycle_state <> 'ready'
                OR reference.search_schema_version
                     IS DISTINCT FROM rebuild.target_search_schema_version
                OR reference.tokenizer_contract_version
                     IS DISTINCT FROM rebuild.target_tokenizer_contract_version
                OR reference.segmentation_version
                     IS DISTINCT FROM rebuild.target_segmentation_version
              )
          ) AS invalid_count,
          (
            SELECT count(*)::int
            FROM focowiki.source_files source
            LEFT JOIN focowiki.source_file_graph_nodes node
              ON node.knowledge_base_id = source.knowledge_base_id
             AND node.source_file_id = source.id
            WHERE source.knowledge_base_id = rebuild.knowledge_base_id
              AND source.deleted_at IS NULL
              AND source.deletion_intent_id IS NULL
              AND (
                node.source_file_id IS NULL
                OR node.tokenizer_contract_version
                     IS DISTINCT FROM rebuild.target_tokenizer_contract_version
                OR node.lexical_projection_version
                     IS DISTINCT FROM ${input.contentProfileVersion}
              )
          ) AS invalid_profile_count,
          (
            SELECT count(*)::int
            FROM focowiki.source_files source
            LEFT JOIN focowiki.source_file_graph_term_documents terms
              ON terms.knowledge_base_id = source.knowledge_base_id
             AND terms.source_file_id = source.id
            WHERE source.knowledge_base_id = rebuild.knowledge_base_id
              AND source.deleted_at IS NULL
              AND source.deletion_intent_id IS NULL
              AND (
                terms.source_file_id IS NULL
                OR terms.source_revision_id IS DISTINCT FROM source.active_revision_id
                OR terms.tokenizer_contract_version
                     IS DISTINCT FROM rebuild.target_tokenizer_contract_version
                OR terms.lexical_projection_version
                     IS DISTINCT FROM ${input.graphLexicalProjectionVersion}
              )
          ) AS invalid_graph_term_count,
          (
            SELECT CASE
              WHEN count(summary.generation_id) = 0 THEN 0
              WHEN max(summary.edge_count) = (
                SELECT count(*)::int
                FROM focowiki.active_projection_records record
                WHERE record.knowledge_base_id = rebuild.knowledge_base_id
                  AND record.projection_kind = 'graph_edge'
              ) THEN 0
              ELSE 1
            END::int
            FROM focowiki.generation_graph_summaries summary
            WHERE summary.knowledge_base_id = rebuild.knowledge_base_id
              AND summary.generation_id = rebuild.base_generation_id
          ) AS invalid_accepted_edge_parity_count,
          rebuild.target_search_schema_version,
          rebuild.target_tokenizer_contract_version,
          rebuild.target_segmentation_version
        FROM focowiki.knowledge_base_lexical_rebuilds rebuild
        WHERE rebuild.knowledge_base_id = ${input.knowledgeBaseId}
          AND rebuild.lease_owner = ${input.workerId}
          AND rebuild.lease_token = ${input.leaseToken}
      `;
      const row = rows[0];
      if (!row) throw new Error("Lexical rebuild lease was lost");
      const passed = row.visible_count === row.reference_count
        && row.invalid_count === 0
        && row.invalid_profile_count === 0
        && row.invalid_graph_term_count === 0
        && row.invalid_accepted_edge_parity_count === 0;
      return {
        passed,
        reason: passed ? null : "Lexical search projection parity validation failed"
      };
    },

    async activate(input) {
      return sql.begin(async (transaction) => {
        const context = await lockActivationContext(transaction, input);
        if (context.activeGenerationId !== context.baseGenerationId) {
          await rebase(transaction, {
            knowledgeBaseId: input.knowledgeBaseId,
            activeGenerationId: context.activeGenerationId,
            updatedAt: input.activatedAt
          });
          return "rebased";
        }
        if (await hasPendingForwardWork(transaction, input.knowledgeBaseId)) {
          await deferActivation(transaction, input);
          return "deferred";
        }
        await copyGenerationLineage(transaction, {
          knowledgeBaseId: input.knowledgeBaseId,
          baseGenerationId: context.baseGenerationId,
          targetGenerationId: context.targetGenerationId,
          now: input.activatedAt
        });
        await transaction`
          UPDATE focowiki.publication_generations
          SET state = 'superseded',
              successor_generation_id = ${context.targetGenerationId},
              updated_at = ${input.activatedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND id = ${context.baseGenerationId}
            AND state = 'active'
        `;
        await transaction`
          UPDATE focowiki.publication_generations target
          SET state = 'active',
              search_schema_version = rebuild.target_search_schema_version,
              tokenizer_contract_version = rebuild.target_tokenizer_contract_version,
              search_segmentation_version = rebuild.target_segmentation_version,
              validated_at = ${input.activatedAt},
              activated_at = ${input.activatedAt},
              updated_at = ${input.activatedAt}
          FROM focowiki.knowledge_base_lexical_rebuilds rebuild
          WHERE rebuild.knowledge_base_id = ${input.knowledgeBaseId}
            AND target.id = rebuild.target_generation_id
            AND target.state = 'building'
        `;
        await refreshActiveLexicalProjectionRecords(transaction, {
          knowledgeBaseId: input.knowledgeBaseId,
          targetGenerationId: context.targetGenerationId,
          updatedAt: input.activatedAt
        });
        await transaction`
          UPDATE focowiki.knowledge_bases
          SET active_generation_id = ${context.targetGenerationId},
              updated_at = ${input.activatedAt}
          WHERE id = ${input.knowledgeBaseId}
            AND active_generation_id = ${context.baseGenerationId}
        `;
        await transaction`
          UPDATE focowiki.knowledge_base_search_states
          SET active_generation_id = ${context.targetGenerationId},
              updated_at = ${input.activatedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND active_generation_id = ${context.baseGenerationId}
            AND pending_epoch IS NULL
        `;
        await advanceProjectionVersionOwnership(transaction, {
          knowledgeBaseId: input.knowledgeBaseId,
          activeGenerationId: context.targetGenerationId,
          updatedAt: input.activatedAt
        });
        await transaction`
          UPDATE focowiki.publication_generations
          SET predecessor_generation_id = ${context.targetGenerationId},
              updated_at = ${input.activatedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND generation_kind = 'normal'
            AND state IN ('open', 'frozen', 'building', 'validating')
            AND predecessor_generation_id = ${context.baseGenerationId}
        `;
        await transaction`
          UPDATE focowiki.knowledge_base_lexical_rebuilds
          SET phase = 'cleanup', state = 'running',
              validated_at = ${input.activatedAt},
              lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
              heartbeat_at = ${input.activatedAt}, updated_at = ${input.activatedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
        `;
        return "activated";
      });
    },

    async complete(input) {
      const rows = await sql<Array<{ knowledge_base_id: string }>>`
        UPDATE focowiki.knowledge_base_lexical_rebuilds
        SET state = 'completed', completed_at = ${input.completedAt},
            lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
            heartbeat_at = ${input.completedAt}, updated_at = ${input.completedAt}
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND lease_owner = ${input.workerId}
          AND lease_token = ${input.leaseToken}
        RETURNING knowledge_base_id
      `;
      assertOwned(rows);
    },

    async fail(input) {
      const rows = await sql<Array<{
        attempt_count: number;
        max_attempts: number;
      }>>`
        UPDATE focowiki.knowledge_base_lexical_rebuilds
        SET state = 'failed',
            attempt_count = attempt_count + 1,
            next_attempt_at = ${new Date(
              new Date(input.failedAt).getTime() + input.retryDelayMs
            ).toISOString()},
            last_error_code = ${input.errorCode.slice(0, 128)},
            last_error_message = ${input.errorMessage.slice(0, 1_000)},
            lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
            heartbeat_at = ${input.failedAt}, updated_at = ${input.failedAt}
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND lease_owner = ${input.workerId}
          AND lease_token = ${input.leaseToken}
        RETURNING attempt_count, max_attempts
      `;
      const row = rows[0];
      if (!row) throw new Error("Lexical rebuild lease was lost");
      return {
        attemptCount: Number(row.attempt_count),
        maxAttempts: Number(row.max_attempts),
        terminal: Number(row.attempt_count) >= Number(row.max_attempts)
      };
    }
  };
}

async function deferActivation(
  transaction: TransactionSql<Record<string, never>>,
  input: {
    knowledgeBaseId: string;
    workerId: string;
    leaseToken: string;
    activatedAt: string;
    retryDelayMs: number;
  }
): Promise<void> {
  const nextAttemptAt = new Date(
    new Date(input.activatedAt).getTime() + input.retryDelayMs
  ).toISOString();
  const rows = await transaction<Array<{ knowledge_base_id: string }>>`
    UPDATE focowiki.knowledge_base_lexical_rebuilds
    SET state = 'pending',
        phase = 'activate',
        next_attempt_at = ${nextAttemptAt},
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        heartbeat_at = ${input.activatedAt},
        last_worker_heartbeat_at = ${input.activatedAt},
        updated_at = ${input.activatedAt}
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND lease_owner = ${input.workerId}
      AND lease_token = ${input.leaseToken}
    RETURNING knowledge_base_id
  `;
  if (!rows[0]) throw new Error("Lexical rebuild lease was lost");
}

async function refreshActiveLexicalProjectionRecords(
  transaction: TransactionSql<Record<string, never>>,
  input: {
    knowledgeBaseId: string;
    targetGenerationId: string;
    updatedAt: string;
  }
): Promise<void> {
  await transaction`
    UPDATE focowiki.active_projection_records active
    SET last_changed_generation_id = ${input.targetGenerationId},
        logical_path = node.path,
        sort_key = lower(node.path),
        title = node.title,
        summary = node.summary,
        searchable_text = concat_ws(
          ' ', node.title, node.summary, node.description,
          node.subjects_json::text,
          node.tags_json::text,
          node.entities_json::text,
          node.headings_json::text,
          node.keywords_json::text
        ),
        payload_json = jsonb_strip_nulls(jsonb_build_object(
          'id', node.source_file_id,
          'fileId', node.source_file_id,
          'path', node.path,
          'title', node.title,
          'summary', node.summary,
          'type', node.type,
          'description', node.description,
          'subjects', node.subjects_json,
          'tags', node.tags_json,
          'entities', node.entities_json,
          'explicitReferences', node.explicit_references_json,
          'relationshipHints', node.relationship_hints_json,
          'headings', node.headings_json,
          'keywords', node.keywords_json,
          'language', node.language,
          'profileVersion', coalesce(
            node.profile_version,
            node.metadata_json->'contentProfile'->>'profileVersion'
          ),
          'profileSource', coalesce(
            node.profile_source,
            node.metadata_json->'contentProfile'->>'profileSource'
          ),
          'metadata', node.metadata_json
        )),
        updated_at = ${input.updatedAt}
    FROM focowiki.generation_search_projection_refs reference
    JOIN focowiki.source_file_graph_nodes node
      ON node.knowledge_base_id = reference.knowledge_base_id
     AND node.source_file_id = reference.source_file_id
    WHERE reference.knowledge_base_id = ${input.knowledgeBaseId}
      AND reference.generation_id = ${input.targetGenerationId}
      AND active.knowledge_base_id = reference.knowledge_base_id
      AND active.projection_kind = 'graph_node'
      AND active.source_file_id = reference.source_file_id
  `;
  await transaction`
    UPDATE focowiki.active_projection_records active
    SET last_changed_generation_id = ${input.targetGenerationId},
        logical_path = reference.logical_path,
        sort_key = lower(reference.logical_path),
        title = reference.title,
        summary = reference.summary,
        searchable_text = concat_ws(
          ' ', reference.title, reference.summary, node.description,
          node.subjects_json::text,
          node.tags_json::text,
          node.entities_json::text,
          node.headings_json::text,
          node.keywords_json::text
        ),
        payload_json = jsonb_strip_nulls(jsonb_build_object(
          'id', reference.source_file_id,
          'fileId', reference.source_file_id,
          'path', reference.logical_path,
          'title', reference.title,
          'summary', reference.summary,
          'type', node.type,
          'description', node.description,
          'tags', node.tags_json,
          'resource', coalesce(
            reference.source_url,
            reference.metadata_json->>'resource'
          ),
          'timestamp', reference.metadata_json->>'timestamp',
          'subjects', node.subjects_json,
          'entities', node.entities_json,
          'headings', node.headings_json,
          'keywords', node.keywords_json,
          'language', node.language,
          'metadata', reference.metadata_json
        )),
        updated_at = ${input.updatedAt}
    FROM focowiki.generation_search_projection_refs reference
    JOIN focowiki.source_file_graph_nodes node
      ON node.knowledge_base_id = reference.knowledge_base_id
     AND node.source_file_id = reference.source_file_id
    WHERE reference.knowledge_base_id = ${input.knowledgeBaseId}
      AND reference.generation_id = ${input.targetGenerationId}
      AND active.knowledge_base_id = reference.knowledge_base_id
      AND active.projection_kind = 'search'
      AND active.source_file_id = reference.source_file_id
  `;
}

async function lockActivationContext(
  transaction: TransactionSql<Record<string, never>>,
  input: { knowledgeBaseId: string; workerId: string; leaseToken: string }
): Promise<{
  activeGenerationId: string;
  baseGenerationId: string;
  targetGenerationId: string;
}> {
  await transaction`
    SELECT pg_advisory_xact_lock(
      hashtextextended('focowiki:generation:' || ${input.knowledgeBaseId}, 0)
    )
  `;
  const rows = await transaction<Array<{
    active_generation_id: string;
    base_generation_id: string;
    target_generation_id: string;
  }>>`
    SELECT knowledge_base.active_generation_id,
           rebuild.base_generation_id, rebuild.target_generation_id
    FROM focowiki.knowledge_bases knowledge_base
    JOIN focowiki.knowledge_base_lexical_rebuilds rebuild
      ON rebuild.knowledge_base_id = knowledge_base.id
    WHERE knowledge_base.id = ${input.knowledgeBaseId}
      AND rebuild.lease_owner = ${input.workerId}
      AND rebuild.lease_token = ${input.leaseToken}
    FOR UPDATE OF knowledge_base, rebuild
  `;
  const row = rows[0];
  if (!row?.active_generation_id || !row.base_generation_id || !row.target_generation_id) {
    throw new Error("Lexical rebuild activation context is unavailable");
  }
  return {
    activeGenerationId: row.active_generation_id,
    baseGenerationId: row.base_generation_id,
    targetGenerationId: row.target_generation_id
  };
}

async function copyGenerationLineage(
  transaction: TransactionSql<Record<string, never>>,
  input: {
    knowledgeBaseId: string;
    baseGenerationId: string;
    targetGenerationId: string;
    now: string;
  }
): Promise<void> {
  await transaction`
    INSERT INTO focowiki.generation_object_refs (
      generation_id, knowledge_base_id, ref_kind, ref_key, action,
      checksum_sha256, format_version, logical_path, source_file_id,
      projection_shard_id, file_id, created_at
    )
    SELECT ${input.targetGenerationId}, knowledge_base_id, ref_kind, ref_key, action,
           checksum_sha256, format_version, logical_path, source_file_id,
           projection_shard_id, file_id, ${input.now}
    FROM focowiki.generation_object_refs
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND generation_id = ${input.baseGenerationId}
    ON CONFLICT (generation_id, ref_kind, ref_key) DO NOTHING
  `;
  await transaction`
    INSERT INTO focowiki.generation_projection_segments (
      generation_id, segment_id, ordinal, effective, created_at
    )
    SELECT ${input.targetGenerationId}, segment_id, ordinal, effective, ${input.now}
    FROM focowiki.generation_projection_segments
    WHERE generation_id = ${input.baseGenerationId}
    ON CONFLICT (generation_id, segment_id) DO NOTHING
  `;
  await transaction`
    INSERT INTO focowiki.generation_projection_partition_stats (
      knowledge_base_id, generation_id, projection_kind, logical_partition,
      record_count, updated_at
    )
    SELECT knowledge_base_id, ${input.targetGenerationId}, projection_kind,
           logical_partition, record_count, ${input.now}
    FROM focowiki.generation_projection_partition_stats
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND generation_id = ${input.baseGenerationId}
    ON CONFLICT (generation_id, projection_kind, logical_partition) DO NOTHING
  `;
  await transaction`
    INSERT INTO focowiki.generation_tree_directory_stats (
      knowledge_base_id, generation_id, path, parent_path,
      direct_entry_count, direct_directory_count, direct_file_count,
      descendant_file_count, created_at, updated_at
    )
    SELECT knowledge_base_id, ${input.targetGenerationId}, path, parent_path,
           direct_entry_count, direct_directory_count, direct_file_count,
           descendant_file_count, ${input.now}, ${input.now}
    FROM focowiki.generation_tree_directory_stats
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND generation_id = ${input.baseGenerationId}
    ON CONFLICT (generation_id, path) DO NOTHING
  `;
  await transaction`
    INSERT INTO focowiki.generation_graph_summaries (
      knowledge_base_id, generation_id, node_count, edge_count,
      graph_index_available, created_at, updated_at
    )
    SELECT knowledge_base_id, ${input.targetGenerationId}, node_count, edge_count,
           graph_index_available, ${input.now}, ${input.now}
    FROM focowiki.generation_graph_summaries
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND generation_id = ${input.baseGenerationId}
    ON CONFLICT (generation_id) DO NOTHING
  `;
}

async function rebase(
  transaction: TransactionSql<Record<string, never>>,
  input: { knowledgeBaseId: string; activeGenerationId: string; updatedAt: string }
): Promise<void> {
  await transaction`
    UPDATE focowiki.publication_generations target
    SET predecessor_generation_id = active.id,
        format_version = active.format_version,
        root_manifest_checksum_sha256 = active.root_manifest_checksum_sha256,
        root_manifest_object_key = active.root_manifest_object_key,
        updated_at = ${input.updatedAt}
    FROM focowiki.knowledge_base_lexical_rebuilds rebuild
    JOIN focowiki.publication_generations active
      ON active.knowledge_base_id = rebuild.knowledge_base_id
     AND active.id = ${input.activeGenerationId}
     AND active.state = 'active'
    WHERE rebuild.knowledge_base_id = ${input.knowledgeBaseId}
      AND target.knowledge_base_id = rebuild.knowledge_base_id
      AND target.id = rebuild.target_generation_id
      AND target.state = 'building'
  `;
  await transaction`
    UPDATE focowiki.knowledge_base_lexical_rebuilds rebuild
    SET base_generation_id = ${input.activeGenerationId},
        state = 'pending', phase = 'validate', source_cursor = NULL,
        rebase_count = rebase_count + 1,
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
        validated_at = NULL,
        updated_at = ${input.updatedAt}
    WHERE rebuild.knowledge_base_id = ${input.knowledgeBaseId}
  `;
}

async function releaseForRebase(
  transaction: TransactionSql<Record<string, never>>,
  input: { knowledgeBaseId: string; updatedAt: string }
): Promise<void> {
  const active = await transaction<Array<{ active_generation_id: string }>>`
    SELECT active_generation_id
    FROM focowiki.knowledge_bases
    WHERE id = ${input.knowledgeBaseId}
  `;
  if (!active[0]?.active_generation_id) return;
  await rebase(transaction, {
    knowledgeBaseId: input.knowledgeBaseId,
    activeGenerationId: active[0].active_generation_id,
    updatedAt: input.updatedAt
  });
}

function mapClaim(row: ClaimRow): LexicalRebuildClaim {
  return {
    knowledgeBaseId: row.knowledge_base_id,
    baseGenerationId: row.base_generation_id,
    targetGenerationId: row.target_generation_id,
    leaseRecovered: row.lease_recovered,
    state: row.state,
    phase: row.phase,
    sourceCursor: row.source_cursor,
    processedSourceCount: Number(row.processed_source_count),
    totalSourceCount: Number(row.total_source_count)
  };
}

function boundedLimit(value: number): number {
  return Math.min(1_000, Math.max(1, Math.trunc(value)));
}

function assertOwned(rows: Array<{ knowledge_base_id: string }>): void {
  if (rows.length !== 1) throw new Error("Lexical rebuild lease was lost");
}
