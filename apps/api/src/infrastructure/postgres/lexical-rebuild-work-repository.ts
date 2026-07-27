import type { OkfGraphNode } from "@focowiki/okf";
import type {
  LexicalRebuildProgress,
  LexicalRebuildProjectionResult,
  LexicalRebuildSettingsSnapshot,
  LexicalRebuildWorkClaim,
  LexicalRebuildWorkRepository,
  LexicalRebuildWorkSource
} from "../../application/ports/lexical-rebuild-work-repository.js";
import type { LexicalRebuildClaim } from "../../application/ports/lexical-rebuild-repository.js";
import type { DatabaseClient } from "../../db/client.js";
import type { TransactionSql } from "postgres";

type WriteSql = DatabaseClient | TransactionSql;

type ClaimRow = {
  knowledge_base_id: string;
  target_generation_id: string;
  source_file_id: string;
  source_revision_id: string;
  logical_path: string;
  lease_token: string;
  attempt_count: number;
  max_attempts: number;
  settings_revision: number;
  settings_snapshot_json: LexicalRebuildSettingsSnapshot;
};

type ClaimedRow = ClaimRow & {
  previous_state: "pending" | "retry" | "running";
};

type SourceRow = ClaimRow & {
  relative_path: string;
  object_key: string;
  size_bytes: number;
  checksum_sha256: string;
  title: string;
  summary: string | null;
  source_url: string | null;
  metadata_json: LexicalRebuildWorkSource["metadata"];
  suggestions_json: LexicalRebuildWorkSource["suggestions"];
};

type FinalizationRow = {
  knowledge_base_id: string;
  base_generation_id: string;
  target_generation_id: string;
  state: LexicalRebuildClaim["state"];
  phase: LexicalRebuildClaim["phase"];
  source_cursor: string | null;
  processed_source_count: number;
  total_source_count: number;
};

type ProgressRow = {
  knowledge_base_id: string;
  target_generation_id: string | null;
  state: string;
  phase: string;
  processed_source_count: number;
  pending_source_count: number;
  running_source_count: number;
  retry_source_count: number;
  failed_source_count: number;
  total_source_count: number;
  source_read_retry_count: number;
  database_retry_count: number;
  recent_files_per_second: number | null;
  rolling_source_read_latency_ms: number | null;
  rolling_database_batch_latency_ms: number | null;
  last_progress_at: Date | null;
  last_worker_heartbeat_at: Date | null;
  estimated_completion_at: Date | null;
};

export function createPostgresLexicalRebuildWorkRepository(
  sql: DatabaseClient
): LexicalRebuildWorkRepository {
  return {
    async planNext(input) {
      return sql.begin(async (transaction) => {
        const coordinators = await transaction<Array<{
          knowledge_base_id: string;
          base_generation_id: string | null;
          target_generation_id: string | null;
          active_generation_id: string | null;
        }>>`
          SELECT rebuild.knowledge_base_id, rebuild.base_generation_id,
                 rebuild.target_generation_id,
                 knowledge_base.active_generation_id
          FROM focowiki.knowledge_base_lexical_rebuilds rebuild
          JOIN focowiki.knowledge_bases knowledge_base
            ON knowledge_base.id = rebuild.knowledge_base_id
           AND knowledge_base.deleted_at IS NULL
          WHERE rebuild.state IN ('pending', 'running', 'failed')
            AND rebuild.phase IN ('documents', 'reconcile')
            AND rebuild.attempt_count < rebuild.max_attempts
            AND rebuild.next_attempt_at <= ${input.now}
            AND rebuild.updated_at < ${input.now}
            AND (
              rebuild.lease_expires_at IS NULL
              OR rebuild.lease_expires_at <= ${input.now}
            )
          ORDER BY rebuild.updated_at, rebuild.knowledge_base_id
          LIMIT 1
          FOR UPDATE OF rebuild SKIP LOCKED
        `;
        const coordinator = coordinators[0];
        if (!coordinator) return null;

        let targetGenerationId = coordinator.target_generation_id;
        let targetCreated = false;
        if (!targetGenerationId) {
          const baseGenerationId = coordinator.active_generation_id;
          if (!baseGenerationId) return null;
          const generations = await transaction<Array<{ id: string }>>`
            INSERT INTO focowiki.publication_generations (
              id, knowledge_base_id, predecessor_generation_id, state,
              format_version, generation_kind, root_manifest_checksum_sha256,
              root_manifest_object_key
            )
            SELECT ${input.targetGenerationId}, base.knowledge_base_id, base.id,
                   'building', base.format_version, 'lexical_rebuild',
                   base.root_manifest_checksum_sha256,
                   base.root_manifest_object_key
            FROM focowiki.publication_generations base
            WHERE base.knowledge_base_id = ${coordinator.knowledge_base_id}
              AND base.id = ${baseGenerationId}
              AND base.state = 'active'
            ON CONFLICT (id) DO NOTHING
            RETURNING id
          `;
          targetGenerationId = generations[0]?.id ?? null;
          if (!targetGenerationId) return null;
          targetCreated = true;
          await transaction`
            UPDATE focowiki.knowledge_base_lexical_rebuilds
            SET base_generation_id = ${baseGenerationId},
                target_generation_id = ${targetGenerationId},
                settings_revision = ${input.settingsRevision},
                settings_snapshot_json = ${transaction.json(input.settings as never)},
                started_at = coalesce(started_at, ${input.now}),
                updated_at = ${input.now}
            WHERE knowledge_base_id = ${coordinator.knowledge_base_id}
          `;
        }

        const existingWork = await transaction<Array<{ exists: boolean }>>`
          SELECT EXISTS (
            SELECT 1
            FROM focowiki.lexical_rebuild_work_items
            WHERE knowledge_base_id = ${coordinator.knowledge_base_id}
              AND target_generation_id = ${targetGenerationId}
            LIMIT 1
          ) AS exists
        `;
        const requiresFullReconcile = targetCreated || !existingWork[0]?.exists;
        const planned = requiresFullReconcile
          ? await transaction<Array<{ source_file_id: string }>>`
          INSERT INTO focowiki.lexical_rebuild_work_items (
            knowledge_base_id, target_generation_id, source_file_id,
            source_revision_id, logical_path,
            target_search_schema_version,
            target_tokenizer_contract_version,
            target_segmentation_version,
            target_content_profile_version,
            target_graph_lexical_projection_version,
            state, max_attempts, next_attempt_at,
            settings_revision, settings_snapshot_json,
            created_at, updated_at
          )
          SELECT
            rebuild.knowledge_base_id, rebuild.target_generation_id, source.id,
            source.active_revision_id, 'pages/' || source.relative_path,
            rebuild.target_search_schema_version,
            rebuild.target_tokenizer_contract_version,
            rebuild.target_segmentation_version,
            rebuild.target_content_profile_version,
            rebuild.target_graph_lexical_projection_version,
            'pending', ${input.maxAttempts}, ${input.now},
            ${input.settingsRevision}, ${transaction.json(input.settings as never)},
            ${input.now}, ${input.now}
          FROM focowiki.knowledge_base_lexical_rebuilds rebuild
          JOIN focowiki.source_files source
            ON source.knowledge_base_id = rebuild.knowledge_base_id
           AND source.deleted_at IS NULL
           AND source.deletion_intent_id IS NULL
          WHERE rebuild.knowledge_base_id = ${coordinator.knowledge_base_id}
            AND rebuild.target_generation_id = ${targetGenerationId}
          ON CONFLICT (target_generation_id, source_file_id) DO UPDATE
          SET source_revision_id = EXCLUDED.source_revision_id,
              logical_path = EXCLUDED.logical_path,
              target_search_schema_version =
                EXCLUDED.target_search_schema_version,
              target_tokenizer_contract_version =
                EXCLUDED.target_tokenizer_contract_version,
              target_segmentation_version =
                EXCLUDED.target_segmentation_version,
              target_content_profile_version =
                EXCLUDED.target_content_profile_version,
              target_graph_lexical_projection_version =
                EXCLUDED.target_graph_lexical_projection_version,
              state = 'pending',
              attempt_count = 0,
              next_attempt_at = EXCLUDED.next_attempt_at,
              settings_revision = EXCLUDED.settings_revision,
              settings_snapshot_json = EXCLUDED.settings_snapshot_json,
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              last_error_stage = NULL,
              last_error_code = NULL,
              last_error_message = NULL,
              claimed_at = NULL,
              completed_at = NULL,
              updated_at = EXCLUDED.updated_at
          WHERE lexical_rebuild_work_items.source_revision_id
                  IS DISTINCT FROM EXCLUDED.source_revision_id
             OR lexical_rebuild_work_items.logical_path
                  IS DISTINCT FROM EXCLUDED.logical_path
             OR lexical_rebuild_work_items.target_search_schema_version
                  IS DISTINCT FROM EXCLUDED.target_search_schema_version
             OR lexical_rebuild_work_items.target_tokenizer_contract_version
                  IS DISTINCT FROM EXCLUDED.target_tokenizer_contract_version
             OR lexical_rebuild_work_items.target_segmentation_version
                  IS DISTINCT FROM EXCLUDED.target_segmentation_version
             OR lexical_rebuild_work_items.target_content_profile_version
                  IS DISTINCT FROM EXCLUDED.target_content_profile_version
             OR lexical_rebuild_work_items.target_graph_lexical_projection_version
                  IS DISTINCT FROM EXCLUDED.target_graph_lexical_projection_version
          RETURNING source_file_id
        `
          : [];
        const cancelled = requiresFullReconcile
          ? await transaction<Array<{ source_file_id: string }>>`
          UPDATE focowiki.lexical_rebuild_work_items item
          SET state = 'cancelled',
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              updated_at = ${input.now}
          WHERE item.knowledge_base_id = ${coordinator.knowledge_base_id}
            AND item.target_generation_id = ${targetGenerationId}
            AND item.state <> 'cancelled'
            AND NOT EXISTS (
              SELECT 1
              FROM focowiki.source_files source
              WHERE source.knowledge_base_id = item.knowledge_base_id
                AND source.id = item.source_file_id
                AND source.active_revision_id = item.source_revision_id
                AND source.deleted_at IS NULL
                AND source.deletion_intent_id IS NULL
          )
          RETURNING source_file_id
        `
          : [];
        if (cancelled.length > 0) {
          await removeCancelledReferences(transaction, {
            knowledgeBaseId: coordinator.knowledge_base_id,
            targetGenerationId,
            now: input.now
          });
        }
        const counts = requiresFullReconcile
          ? await refreshCoordinatorProgress(transaction, {
              knowledgeBaseId: coordinator.knowledge_base_id,
              targetGenerationId,
              now: input.now
            })
          : await readCoordinatorProgress(transaction, {
              knowledgeBaseId: coordinator.knowledge_base_id,
              targetGenerationId
            });
        const readyForValidation = counts.pending === 0
          && counts.running === 0
          && counts.retrying === 0
          && counts.failed === 0;
        if (readyForValidation) {
          await transaction`
            UPDATE focowiki.knowledge_base_lexical_rebuilds
            SET phase = 'validate', state = 'pending',
                source_cursor = NULL,
                next_attempt_at = ${input.now},
                updated_at = ${input.now}
            WHERE knowledge_base_id = ${coordinator.knowledge_base_id}
              AND target_generation_id = ${targetGenerationId}
          `;
        }
        return {
          knowledgeBaseId: coordinator.knowledge_base_id,
          targetGenerationId,
          planned: planned.length,
          cancelled: cancelled.length,
          readyForValidation
        };
      });
    },

    async claimBatch(input) {
      return sql.begin(async (transaction) => {
        const rows = await transaction<ClaimedRow[]>`
          WITH eligible_knowledge_bases AS MATERIALIZED (
            SELECT rebuild.knowledge_base_id, rebuild.target_generation_id,
                   row_number() OVER (
                     ORDER BY rebuild.updated_at, rebuild.knowledge_base_id
                   )::integer AS fair_ordinal
            FROM focowiki.knowledge_base_lexical_rebuilds rebuild
            JOIN focowiki.knowledge_bases knowledge_base
              ON knowledge_base.id = rebuild.knowledge_base_id
             AND knowledge_base.deleted_at IS NULL
            WHERE rebuild.phase IN ('documents', 'reconcile')
              AND rebuild.state IN ('pending', 'running', 'failed')
              AND (
                rebuild.lease_expires_at IS NULL
                OR rebuild.lease_expires_at <= ${input.now}
              )
              AND EXISTS (
                SELECT 1
                FROM focowiki.lexical_rebuild_work_items item
                WHERE item.knowledge_base_id = rebuild.knowledge_base_id
                  AND item.target_generation_id = rebuild.target_generation_id
                  AND item.attempt_count < item.max_attempts
                  AND item.next_attempt_at <= ${input.now}
                  AND (
                    item.state IN ('pending', 'retry')
                    OR (
                      item.state = 'running'
                      AND item.lease_expires_at <= ${input.now}
                    )
                  )
                LIMIT 1
              )
            ORDER BY rebuild.updated_at, rebuild.knowledge_base_id
            LIMIT ${Math.min(boundedClaimLimit(input.limit), 64)}
          ), knowledge_base_slots AS MATERIALIZED (
            SELECT eligible.*,
                   count(*) OVER ()::integer AS knowledge_base_count
            FROM eligible_knowledge_bases eligible
          ), candidates AS MATERIALIZED (
            SELECT locked.target_generation_id, locked.source_file_id,
                   locked.previous_state
            FROM knowledge_base_slots eligible
            CROSS JOIN LATERAL (
              SELECT item.target_generation_id, item.source_file_id,
                     item.state AS previous_state
              FROM focowiki.lexical_rebuild_work_items item
              WHERE item.knowledge_base_id = eligible.knowledge_base_id
                AND item.target_generation_id = eligible.target_generation_id
                AND item.attempt_count < item.max_attempts
                AND item.next_attempt_at <= ${input.now}
                AND (
                  item.state IN ('pending', 'retry')
                  OR (
                    item.state = 'running'
                    AND item.lease_expires_at <= ${input.now}
                  )
                )
              ORDER BY item.next_attempt_at, item.updated_at, item.source_file_id
              LIMIT (
                ${boundedClaimLimit(input.limit)} / eligible.knowledge_base_count
                + CASE
                    WHEN eligible.fair_ordinal <= (
                      ${boundedClaimLimit(input.limit)}
                        % eligible.knowledge_base_count
                    )
                      THEN 1
                    ELSE 0
                  END
              )
              FOR UPDATE OF item SKIP LOCKED
            ) locked
          )
          UPDATE focowiki.lexical_rebuild_work_items item
          SET state = 'running',
              lease_owner = ${input.workerId},
              lease_token = ${input.leaseTokenPrefix} || ':' || item.source_file_id,
              lease_expires_at = ${input.leaseExpiresAt},
              heartbeat_at = ${input.now},
              claimed_at = coalesce(item.claimed_at, ${input.now}),
              settings_revision = ${input.settingsRevision},
              settings_snapshot_json = ${transaction.json(input.settings as never)},
              last_error_stage = NULL,
              last_error_code = NULL,
              last_error_message = NULL,
              updated_at = ${input.now}
          FROM candidates
          WHERE item.target_generation_id = candidates.target_generation_id
            AND item.source_file_id = candidates.source_file_id
          RETURNING item.knowledge_base_id, item.target_generation_id,
                    item.source_file_id, item.source_revision_id,
                    item.logical_path, item.lease_token,
                    item.attempt_count, item.max_attempts,
                    item.settings_revision, item.settings_snapshot_json,
                    candidates.previous_state
        `;
        await updateCoordinatorAfterClaims(transaction, rows, input.now);
        return rows.map(mapClaim);
      });
    },

    async loadSources(claims) {
      if (claims.length === 0) return [];
      const identities = claims.map((claim) => ({
        target_generation_id: claim.targetGenerationId,
        source_file_id: claim.sourceFileId,
        lease_token: claim.leaseToken
      }));
      const rows = await sql<SourceRow[]>`
        WITH claimed AS (
          SELECT *
          FROM jsonb_to_recordset(${sql.json(identities as never)}) AS item(
            target_generation_id text,
            source_file_id text,
            lease_token text
          )
        )
        SELECT item.knowledge_base_id, item.target_generation_id,
               item.source_file_id, item.source_revision_id,
               item.logical_path, item.lease_token,
               item.attempt_count, item.max_attempts,
               item.settings_revision, item.settings_snapshot_json,
               source.relative_path, revision.object_key, revision.size_bytes,
               revision.checksum_sha256,
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
        FROM claimed
        JOIN focowiki.lexical_rebuild_work_items item
          ON item.target_generation_id = claimed.target_generation_id
         AND item.source_file_id = claimed.source_file_id
         AND item.lease_token = claimed.lease_token
         AND item.state = 'running'
        JOIN focowiki.source_files source
          ON source.knowledge_base_id = item.knowledge_base_id
         AND source.id = item.source_file_id
         AND source.active_revision_id = item.source_revision_id
         AND source.deleted_at IS NULL
         AND source.deletion_intent_id IS NULL
        JOIN focowiki.source_revisions revision
          ON revision.knowledge_base_id = source.knowledge_base_id
         AND revision.source_file_id = source.id
         AND revision.id = source.active_revision_id
        LEFT JOIN focowiki.source_file_graph_nodes node
          ON node.knowledge_base_id = source.knowledge_base_id
         AND node.source_file_id = source.id
        ORDER BY item.target_generation_id, item.source_file_id
      `;
      return rows.map(mapSource);
    },

    async heartbeat(input) {
      if (input.claims.length === 0) return 0;
      const identities = input.claims.map((claim) => ({
        target_generation_id: claim.targetGenerationId,
        source_file_id: claim.sourceFileId,
        lease_token: claim.leaseToken
      }));
      const rows = await sql<Array<{ source_file_id: string }>>`
        WITH claimed AS (
          SELECT *
          FROM jsonb_to_recordset(${sql.json(identities as never)}) AS item(
            target_generation_id text,
            source_file_id text,
            lease_token text
          )
        )
        UPDATE focowiki.lexical_rebuild_work_items item
        SET heartbeat_at = ${input.heartbeatAt},
            lease_expires_at = ${input.leaseExpiresAt},
            updated_at = ${input.heartbeatAt}
        FROM claimed
        WHERE item.target_generation_id = claimed.target_generation_id
          AND item.source_file_id = claimed.source_file_id
          AND item.lease_owner = ${input.workerId}
          AND item.lease_token = claimed.lease_token
          AND item.state = 'running'
          AND item.lease_expires_at > now()
        RETURNING item.source_file_id
      `;
      await updateCoordinatorHeartbeats(sql, input.claims, input.heartbeatAt);
      return rows.length;
    },

    async persistBatch(input) {
      if (input.results.length === 0) return;
      const transactionStartedAt = performance.now();
      await sql.begin(async (transaction) => {
        const documentRows = input.results.map(({ searchDocument }) => ({
          id: searchDocument.documentId,
          knowledge_base_id: searchDocument.knowledgeBaseId,
          source_file_id: searchDocument.sourceFileId,
          source_revision_id: searchDocument.sourceRevisionId,
          source_body_checksum_sha256: searchDocument.sourceBodyChecksumSha256,
          search_schema_version: searchDocument.searchSchemaVersion,
          tokenizer_contract_version: searchDocument.tokenizerContractVersion,
          segmentation_version: searchDocument.segmentationVersion,
          segment_count: searchDocument.segments.length
        }));
        await transaction`
          INSERT INTO focowiki.search_projection_documents (
            id, knowledge_base_id, source_file_id, source_revision_id,
            source_body_checksum_sha256, search_schema_version,
            tokenizer_contract_version, segmentation_version,
            segment_count, lifecycle_state, completed_at, updated_at
          )
          SELECT document.id, document.knowledge_base_id,
                 document.source_file_id, document.source_revision_id,
                 document.source_body_checksum_sha256,
                 document.search_schema_version,
                 document.tokenizer_contract_version,
                 document.segmentation_version, document.segment_count,
                 'ready', ${input.completedAt}, ${input.completedAt}
          FROM jsonb_to_recordset(${transaction.json(documentRows as never)}) AS document(
            id text, knowledge_base_id text, source_file_id text,
            source_revision_id text, source_body_checksum_sha256 text,
            search_schema_version text, tokenizer_contract_version text,
            segmentation_version text, segment_count integer
          )
          ON CONFLICT (id) DO UPDATE
          SET source_revision_id = EXCLUDED.source_revision_id,
              segment_count = EXCLUDED.segment_count,
              lifecycle_state = 'ready',
              safe_error_code = NULL,
              safe_error_message = NULL,
              completed_at = EXCLUDED.completed_at,
              updated_at = EXCLUDED.updated_at
        `;
        const documentIds = documentRows.map((row) => row.id);
        await transaction`
          DELETE FROM focowiki.search_projection_segments
          WHERE document_id = ANY(${documentIds})
        `;
        const segmentRows = input.results.flatMap(({ searchDocument }) =>
          searchDocument.segments.map((segment) => ({
            document_id: searchDocument.documentId,
            knowledge_base_id: searchDocument.knowledgeBaseId,
            ordinal: segment.ordinal,
            heading: segment.heading,
            normalized_text: segment.normalizedText,
            tokens: segment.tokens,
            token_text: segment.tokens.join(" "),
            character_count: [...segment.normalizedText].length,
            byte_count: Buffer.byteLength(segment.normalizedText, "utf8")
          }))
        );
        if (segmentRows.length > 0) {
          await transaction`
            INSERT INTO focowiki.search_projection_segments (
              document_id, knowledge_base_id, ordinal, heading,
              normalized_text, tokens, token_text, character_count, byte_count
            )
            SELECT segment.document_id, segment.knowledge_base_id,
                   segment.ordinal, segment.heading, segment.normalized_text,
                   segment.tokens, segment.token_text,
                   segment.character_count, segment.byte_count
            FROM jsonb_to_recordset(${transaction.json(segmentRows as never)}) AS segment(
              document_id text, knowledge_base_id text, ordinal integer,
              heading text, normalized_text text, tokens text[],
              token_text text, character_count integer, byte_count integer
            )
          `;
        }
        await persistGenerationReferences(transaction, input.results, input.completedAt);
        await persistGraphNodes(transaction, input.results);
        await persistGraphTerms(transaction, input.results);
        const completed = await completeOwnedItems(transaction, input);
        if (completed.length !== input.results.length) {
          throw new Error("Lexical rebuild work-item ownership changed before commit");
        }
        for (const completion of groupCompletions(completed)) {
          const progress = await updateCoordinatorAfterCompletion(transaction, {
            ...completion,
            now: input.completedAt,
            databaseBatchLatencyMs: performance.now() - transactionStartedAt,
            sourceReadLatencyMs: average(
              input.results
                .filter(
                  (result) =>
                    result.claim.knowledgeBaseId === completion.knowledgeBaseId
                )
                .map((result) => result.sourceReadLatencyMs)
            )
          });
          await promoteCoordinatorWhenReady(transaction, {
            knowledgeBaseId: completion.knowledgeBaseId,
            targetGenerationId: completion.targetGenerationId,
            now: input.completedAt,
            progress
          });
        }
      });
    },

    async retry(input) {
      if (input.claims.length === 0) return;
      const rows = input.claims.map((claim) => ({
        target_generation_id: claim.targetGenerationId,
        source_file_id: claim.sourceFileId,
        lease_token: claim.leaseToken
      }));
      await sql.begin(async (transaction) => {
        const changed = await transaction<Array<{
          knowledge_base_id: string;
          target_generation_id: string;
          state: "retry" | "failed";
        }>>`
          WITH failed AS (
            SELECT *
            FROM jsonb_to_recordset(${transaction.json(rows as never)}) AS item(
              target_generation_id text,
              source_file_id text,
              lease_token text
            )
          )
          UPDATE focowiki.lexical_rebuild_work_items item
          SET attempt_count = item.attempt_count + 1,
              state = CASE
                WHEN item.attempt_count + 1 >= item.max_attempts
                  THEN 'failed'
                ELSE 'retry'
              END,
              next_attempt_at = ${new Date(
                Date.parse(input.failedAt) + Math.max(1, input.retryDelayMs)
              ).toISOString()},
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              last_error_stage = ${input.stage},
              last_error_code = ${input.errorCode},
              last_error_message = ${input.errorMessage.slice(0, 500)},
              source_read_retry_count = item.source_read_retry_count
                + CASE WHEN ${input.stage} = 'source_read' THEN 1 ELSE 0 END,
              database_retry_count = item.database_retry_count
                + CASE WHEN ${input.stage} = 'database_write' THEN 1 ELSE 0 END,
              updated_at = ${input.failedAt}
          FROM failed
          WHERE item.target_generation_id = failed.target_generation_id
            AND item.source_file_id = failed.source_file_id
            AND item.lease_owner = ${input.workerId}
            AND item.lease_token = failed.lease_token
            AND item.state = 'running'
          RETURNING item.knowledge_base_id, item.target_generation_id, item.state
        `;
        await updateCoordinatorAfterRetries(transaction, {
          changed,
          stage: input.stage,
          failedAt: input.failedAt
        });
      });
    },

    async claimFinalization(input) {
      const rows = await sql<FinalizationRow[]>`
        WITH candidate AS MATERIALIZED (
          SELECT rebuild.knowledge_base_id
          FROM focowiki.knowledge_base_lexical_rebuilds rebuild
          WHERE rebuild.phase IN ('validate', 'activate', 'cleanup')
            AND rebuild.state IN (
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
            last_worker_heartbeat_at = ${input.now},
            state = CASE
              WHEN rebuild.phase = 'validate' THEN 'validating'
              WHEN rebuild.phase = 'activate' THEN 'activating'
              ELSE 'running'
            END,
            updated_at = ${input.now}
        FROM candidate
        WHERE rebuild.knowledge_base_id = candidate.knowledge_base_id
        RETURNING rebuild.knowledge_base_id, rebuild.base_generation_id,
                  rebuild.target_generation_id, rebuild.state, rebuild.phase,
                  rebuild.source_cursor, rebuild.processed_source_count,
                  rebuild.total_source_count
      `;
      const row = rows[0];
      return row?.base_generation_id && row.target_generation_id
        ? {
            knowledgeBaseId: row.knowledge_base_id,
            baseGenerationId: row.base_generation_id,
            targetGenerationId: row.target_generation_id,
            leaseRecovered: false,
            state: row.state,
            phase: row.phase,
            sourceCursor: row.source_cursor,
            processedSourceCount: Number(row.processed_source_count),
            totalSourceCount: Number(row.total_source_count)
          }
        : null;
    },

    async listProgress() {
      const rows = await sql<ProgressRow[]>`
        SELECT knowledge_base_id, target_generation_id, state, phase,
               processed_source_count, pending_source_count,
               running_source_count, retry_source_count, failed_source_count,
               total_source_count, source_read_retry_count,
               database_retry_count, recent_files_per_second,
               rolling_source_read_latency_ms,
               rolling_database_batch_latency_ms,
               last_progress_at, last_worker_heartbeat_at,
               estimated_completion_at
        FROM focowiki.knowledge_base_lexical_rebuilds
        WHERE state NOT IN ('completed', 'cancelled')
        ORDER BY updated_at, knowledge_base_id
      `;
      return rows.map(mapProgress);
    }
  };
}

async function persistGenerationReferences(
  transaction: WriteSql,
  results: LexicalRebuildProjectionResult[],
  completedAt: string
): Promise<void> {
  const rows = results.map((result) => ({
    knowledge_base_id: result.claim.knowledgeBaseId,
    generation_id: result.claim.targetGenerationId,
    source_file_id: result.claim.sourceFileId,
    source_revision_id: result.claim.sourceRevisionId,
    search_document_id: result.searchDocument.documentId,
    search_schema_version: result.searchDocument.searchSchemaVersion,
    tokenizer_contract_version: result.searchDocument.tokenizerContractVersion,
    segmentation_version: result.searchDocument.segmentationVersion,
    logical_path: result.claim.logicalPath,
    title: result.graphNode.title,
    summary: result.graphNode.summary ?? result.graphNode.description ?? null,
    source_url: result.sourceUrl,
    metadata_json: result.metadata
  }));
  await transaction`
    INSERT INTO focowiki.generation_search_projection_refs (
      knowledge_base_id, generation_id, source_file_id, source_revision_id,
      search_document_id, search_schema_version, tokenizer_contract_version,
      segmentation_version, logical_path, title, summary, source_url,
      metadata_json, updated_at
    )
    SELECT reference.knowledge_base_id, reference.generation_id,
           reference.source_file_id, reference.source_revision_id,
           reference.search_document_id, reference.search_schema_version,
           reference.tokenizer_contract_version,
           reference.segmentation_version, reference.logical_path,
           reference.title, reference.summary, reference.source_url,
           reference.metadata_json, ${completedAt}
    FROM jsonb_to_recordset(${transaction.json(rows as never)}) AS reference(
      knowledge_base_id text, generation_id text, source_file_id text,
      source_revision_id text, search_document_id text,
      search_schema_version text, tokenizer_contract_version text,
      segmentation_version text, logical_path text, title text,
      summary text, source_url text, metadata_json jsonb
    )
    ON CONFLICT (generation_id, source_file_id) DO UPDATE
    SET source_revision_id = EXCLUDED.source_revision_id,
        search_document_id = EXCLUDED.search_document_id,
        search_schema_version = EXCLUDED.search_schema_version,
        tokenizer_contract_version = EXCLUDED.tokenizer_contract_version,
        segmentation_version = EXCLUDED.segmentation_version,
        logical_path = EXCLUDED.logical_path,
        title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        source_url = EXCLUDED.source_url,
        metadata_json = EXCLUDED.metadata_json,
        updated_at = EXCLUDED.updated_at
  `;
}

async function persistGraphNodes(
  transaction: WriteSql,
  results: LexicalRebuildProjectionResult[]
): Promise<void> {
  const rows = results.map(({ claim, graphNode }) => graphNodeRow(claim.knowledgeBaseId, graphNode));
  await transaction`
    INSERT INTO focowiki.source_file_graph_nodes (
      knowledge_base_id, source_file_id, path, title, type, description,
      summary, subjects_json, tags_json, entities_json,
      explicit_references_json, relationship_hints_json, headings_json,
      keywords_json, language, profile_version, profile_source,
      profile_json, metadata_json, tokenizer_contract_version,
      lexical_projection_version, updated_at
    )
    SELECT node.knowledge_base_id, node.source_file_id, node.path,
           node.title, node.type, node.description, node.summary,
           node.subjects_json, node.tags_json, node.entities_json,
           node.explicit_references_json, node.relationship_hints_json,
           node.headings_json, node.keywords_json, node.language,
           node.profile_version, node.profile_source, node.profile_json,
           node.metadata_json, node.tokenizer_contract_version,
           node.lexical_projection_version, now()
    FROM jsonb_to_recordset(${transaction.json(rows as never)}) AS node(
      knowledge_base_id text, source_file_id text, path text, title text,
      type text, description text, summary text, subjects_json jsonb,
      tags_json jsonb, entities_json jsonb, explicit_references_json jsonb,
      relationship_hints_json jsonb, headings_json jsonb, keywords_json jsonb,
      language text, profile_version text, profile_source text,
      profile_json jsonb, metadata_json jsonb,
      tokenizer_contract_version text, lexical_projection_version text
    )
    ON CONFLICT (knowledge_base_id, source_file_id) DO UPDATE
    SET path = EXCLUDED.path, title = EXCLUDED.title, type = EXCLUDED.type,
        description = EXCLUDED.description, summary = EXCLUDED.summary,
        subjects_json = EXCLUDED.subjects_json, tags_json = EXCLUDED.tags_json,
        entities_json = EXCLUDED.entities_json,
        explicit_references_json = EXCLUDED.explicit_references_json,
        relationship_hints_json = EXCLUDED.relationship_hints_json,
        headings_json = EXCLUDED.headings_json,
        keywords_json = EXCLUDED.keywords_json,
        language = EXCLUDED.language,
        profile_version = EXCLUDED.profile_version,
        profile_source = EXCLUDED.profile_source,
        profile_json = EXCLUDED.profile_json,
        metadata_json = EXCLUDED.metadata_json,
        tokenizer_contract_version = EXCLUDED.tokenizer_contract_version,
        lexical_projection_version = EXCLUDED.lexical_projection_version,
        updated_at = now()
  `;
}

async function persistGraphTerms(
  transaction: WriteSql,
  results: LexicalRebuildProjectionResult[]
): Promise<void> {
  const rows = results.map(({ claim, graphTermDocument: document }) => ({
    knowledge_base_id: claim.knowledgeBaseId,
    source_file_id: document.sourceFileId,
    source_revision_id: document.sourceRevisionId,
    term_fingerprint: document.fingerprint,
    lexical_text: document.lexicalText,
    exact_terms: document.exactTerms,
    phrase_terms: document.phraseTerms,
    explicit_references: document.explicitReferences,
    tokenizer_contract_version: document.tokenizerContractVersion,
    lexical_projection_version: document.lexicalProjectionVersion
  }));
  await transaction`
    INSERT INTO focowiki.source_file_graph_term_documents (
      knowledge_base_id, source_file_id, source_revision_id,
      term_fingerprint, lexical_text, exact_terms, phrase_terms,
      explicit_references, tokenizer_contract_version,
      lexical_projection_version, updated_at
    )
    SELECT term.knowledge_base_id, term.source_file_id,
           term.source_revision_id, term.term_fingerprint, term.lexical_text,
           term.exact_terms, term.phrase_terms, term.explicit_references,
           term.tokenizer_contract_version, term.lexical_projection_version,
           now()
    FROM jsonb_to_recordset(${transaction.json(rows as never)}) AS term(
      knowledge_base_id text, source_file_id text, source_revision_id text,
      term_fingerprint text, lexical_text text, exact_terms text[],
      phrase_terms text[], explicit_references text[],
      tokenizer_contract_version text, lexical_projection_version text
    )
    ON CONFLICT (knowledge_base_id, source_file_id) DO UPDATE
    SET source_revision_id = EXCLUDED.source_revision_id,
        term_fingerprint = EXCLUDED.term_fingerprint,
        lexical_text = EXCLUDED.lexical_text,
        exact_terms = EXCLUDED.exact_terms,
        phrase_terms = EXCLUDED.phrase_terms,
        explicit_references = EXCLUDED.explicit_references,
        tokenizer_contract_version = EXCLUDED.tokenizer_contract_version,
        lexical_projection_version = EXCLUDED.lexical_projection_version,
        updated_at = now()
  `;
}

async function completeOwnedItems(
  transaction: WriteSql,
  input: {
    workerId: string;
    results: LexicalRebuildProjectionResult[];
    completedAt: string;
  }
): Promise<Array<{
  knowledge_base_id: string;
  target_generation_id: string;
  source_file_id: string;
  source_read_retry_count: number;
}>> {
  const rows = input.results.map(({ claim, sourceReadRetries }) => ({
    target_generation_id: claim.targetGenerationId,
    source_file_id: claim.sourceFileId,
    source_revision_id: claim.sourceRevisionId,
    lease_token: claim.leaseToken,
    source_read_retry_count: sourceReadRetries
  }));
  return transaction<Array<{
    knowledge_base_id: string;
    target_generation_id: string;
    source_file_id: string;
    source_read_retry_count: number;
  }>>`
    WITH owned AS (
      SELECT *
      FROM jsonb_to_recordset(${transaction.json(rows as never)}) AS item(
        target_generation_id text, source_file_id text,
        source_revision_id text, lease_token text,
        source_read_retry_count integer
      )
    )
    UPDATE focowiki.lexical_rebuild_work_items item
    SET state = 'completed', lease_owner = NULL, lease_token = NULL,
        lease_expires_at = NULL, heartbeat_at = NULL,
        completed_at = ${input.completedAt}, updated_at = ${input.completedAt},
        source_read_retry_count = item.source_read_retry_count
          + owned.source_read_retry_count,
        last_error_stage = NULL, last_error_code = NULL,
        last_error_message = NULL
    FROM owned
    WHERE item.target_generation_id = owned.target_generation_id
      AND item.source_file_id = owned.source_file_id
      AND item.source_revision_id = owned.source_revision_id
      AND item.lease_owner = ${input.workerId}
      AND item.lease_token = owned.lease_token
      AND item.state = 'running'
    RETURNING item.knowledge_base_id, item.target_generation_id,
              item.source_file_id, owned.source_read_retry_count
  `;
}

async function updateCoordinatorAfterClaims(
  transaction: WriteSql,
  rows: ClaimedRow[],
  claimedAt: string
): Promise<void> {
  for (const claimed of groupClaims(rows)) {
    await transaction`
      UPDATE focowiki.knowledge_base_lexical_rebuilds
      SET pending_source_count = greatest(
            0,
            pending_source_count - ${claimed.pending}
          ),
          retry_source_count = greatest(
            0,
            retry_source_count - ${claimed.retrying}
          ),
          running_source_count = running_source_count
            + ${claimed.pending + claimed.retrying},
          last_worker_heartbeat_at = ${claimedAt},
          updated_at = ${claimedAt}
      WHERE knowledge_base_id = ${claimed.knowledgeBaseId}
        AND target_generation_id = ${claimed.targetGenerationId}
    `;
  }
}

async function updateCoordinatorAfterCompletion(
  transaction: WriteSql,
  input: {
    knowledgeBaseId: string;
    targetGenerationId: string;
    completed: number;
    sourceReadRetries: number;
    now: string;
    databaseBatchLatencyMs: number;
    sourceReadLatencyMs: number | null;
  }
): Promise<{
  completed: number;
  pending: number;
  running: number;
  retrying: number;
  failed: number;
  total: number;
}> {
  const rows = await transaction<Array<{
    completed: number;
    pending: number;
    running: number;
    retrying: number;
    failed: number;
    total: number;
  }>>`
    UPDATE focowiki.knowledge_base_lexical_rebuilds rebuild
    SET processed_source_count = rebuild.processed_source_count + ${input.completed},
        running_source_count = greatest(
          0,
          rebuild.running_source_count - ${input.completed}
        ),
        source_read_retry_count = rebuild.source_read_retry_count
          + ${input.sourceReadRetries},
        recent_files_per_second = CASE
          WHEN extract(epoch FROM (
            ${input.now}::timestamptz
            - coalesce(
                rebuild.last_progress_at,
                rebuild.started_at,
                rebuild.created_at
              )
          )) > 0
            THEN ${input.completed}
              / extract(epoch FROM (
                  ${input.now}::timestamptz
                  - coalesce(
                      rebuild.last_progress_at,
                      rebuild.started_at,
                      rebuild.created_at
                    )
                ))
          ELSE rebuild.recent_files_per_second
        END,
        rolling_source_read_latency_ms = coalesce(
          ${input.sourceReadLatencyMs},
          rebuild.rolling_source_read_latency_ms
        ),
        rolling_database_batch_latency_ms = ${input.databaseBatchLatencyMs},
        last_progress_at = ${input.now},
        last_worker_heartbeat_at = ${input.now},
        estimated_completion_at = CASE
          WHEN rebuild.recent_files_per_second > 0
            THEN ${input.now}::timestamptz
              + make_interval(
                  secs => greatest(
                    0,
                    rebuild.total_source_count
                      - rebuild.processed_source_count
                      - ${input.completed}
                  ) / rebuild.recent_files_per_second
                )
          ELSE NULL
        END,
        updated_at = ${input.now}
    WHERE rebuild.knowledge_base_id = ${input.knowledgeBaseId}
      AND rebuild.target_generation_id = ${input.targetGenerationId}
    RETURNING rebuild.processed_source_count AS completed,
              rebuild.pending_source_count AS pending,
              rebuild.running_source_count AS running,
              rebuild.retry_source_count AS retrying,
              rebuild.failed_source_count AS failed,
              rebuild.total_source_count AS total
  `;
  return progressCounts(rows[0]);
}

async function updateCoordinatorAfterRetries(
  transaction: WriteSql,
  input: {
    changed: Array<{
      knowledge_base_id: string;
      target_generation_id: string;
      state: "retry" | "failed";
    }>;
    stage: "source_read" | "database_write" | "derive";
    failedAt: string;
  }
): Promise<void> {
  const grouped = new Map<string, {
    knowledgeBaseId: string;
    targetGenerationId: string;
    retrying: number;
    failed: number;
  }>();
  for (const row of input.changed) {
    const key = `${row.knowledge_base_id}:${row.target_generation_id}`;
    const current = grouped.get(key) ?? {
      knowledgeBaseId: row.knowledge_base_id,
      targetGenerationId: row.target_generation_id,
      retrying: 0,
      failed: 0
    };
    if (row.state === "retry") current.retrying += 1;
    if (row.state === "failed") current.failed += 1;
    grouped.set(key, current);
  }
  for (const change of grouped.values()) {
    const changedCount = change.retrying + change.failed;
    await transaction`
      UPDATE focowiki.knowledge_base_lexical_rebuilds
      SET running_source_count = greatest(
            0,
            running_source_count - ${changedCount}
          ),
          retry_source_count = retry_source_count + ${change.retrying},
          failed_source_count = failed_source_count + ${change.failed},
          source_read_retry_count = source_read_retry_count
            + CASE
                WHEN ${input.stage} = 'source_read' THEN ${changedCount}
                ELSE 0
              END,
          database_retry_count = database_retry_count
            + CASE
                WHEN ${input.stage} = 'database_write' THEN ${changedCount}
                ELSE 0
              END,
          last_worker_heartbeat_at = ${input.failedAt},
          updated_at = ${input.failedAt}
      WHERE knowledge_base_id = ${change.knowledgeBaseId}
        AND target_generation_id = ${change.targetGenerationId}
    `;
  }
}

async function removeCancelledReferences(
  transaction: WriteSql,
  input: { knowledgeBaseId: string; targetGenerationId: string; now: string }
): Promise<void> {
  await transaction`
    DELETE FROM focowiki.generation_search_projection_refs reference
    USING focowiki.lexical_rebuild_work_items item
    WHERE item.knowledge_base_id = ${input.knowledgeBaseId}
      AND item.target_generation_id = ${input.targetGenerationId}
      AND item.state = 'cancelled'
      AND reference.knowledge_base_id = item.knowledge_base_id
      AND reference.generation_id = item.target_generation_id
      AND reference.source_file_id = item.source_file_id
  `;
}

async function readCoordinatorProgress(
  transaction: WriteSql,
  input: { knowledgeBaseId: string; targetGenerationId: string }
): Promise<{
  completed: number;
  pending: number;
  running: number;
  retrying: number;
  failed: number;
  total: number;
}> {
  const rows = await transaction<Array<{
    completed: number;
    pending: number;
    running: number;
    retrying: number;
    failed: number;
    total: number;
  }>>`
    SELECT processed_source_count AS completed,
           pending_source_count AS pending,
           running_source_count AS running,
           retry_source_count AS retrying,
           failed_source_count AS failed,
           total_source_count AS total
    FROM focowiki.knowledge_base_lexical_rebuilds
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND target_generation_id = ${input.targetGenerationId}
    LIMIT 1
  `;
  return progressCounts(rows[0]);
}

async function refreshCoordinatorProgress(
  transaction: WriteSql,
  input: {
    knowledgeBaseId: string;
    targetGenerationId: string;
    now: string;
    databaseBatchLatencyMs?: number | undefined;
    sourceReadLatencyMs?: number | undefined;
  }
): Promise<{
  completed: number;
  pending: number;
  running: number;
  retrying: number;
  failed: number;
  total: number;
}> {
  const rows = await transaction<Array<{
    completed: number;
    pending: number;
    running: number;
    retrying: number;
    failed: number;
    total: number;
  }>>`
    WITH counts AS (
      SELECT count(*) FILTER (WHERE state = 'completed')::bigint AS completed,
             count(*) FILTER (WHERE state = 'pending')::bigint AS pending,
             count(*) FILTER (WHERE state = 'running')::bigint AS running,
             count(*) FILTER (WHERE state = 'retry')::bigint AS retrying,
             count(*) FILTER (WHERE state = 'failed')::bigint AS failed,
             count(*) FILTER (WHERE state <> 'cancelled')::bigint AS total,
             coalesce(sum(source_read_retry_count), 0)::bigint
               AS source_read_retries,
             coalesce(sum(database_retry_count), 0)::bigint
               AS database_retries
      FROM focowiki.lexical_rebuild_work_items
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND target_generation_id = ${input.targetGenerationId}
    )
    UPDATE focowiki.knowledge_base_lexical_rebuilds rebuild
    SET processed_source_count = counts.completed,
        pending_source_count = counts.pending,
        running_source_count = counts.running,
        retry_source_count = counts.retrying,
        failed_source_count = counts.failed,
        total_source_count = counts.total,
        source_read_retry_count = counts.source_read_retries,
        database_retry_count = counts.database_retries,
        last_progress_at = CASE
          WHEN counts.completed > rebuild.processed_source_count
            THEN ${input.now}
          ELSE rebuild.last_progress_at
        END,
        recent_files_per_second = CASE
          WHEN counts.completed > rebuild.processed_source_count
            AND extract(epoch FROM (
              ${input.now}::timestamptz
              - coalesce(rebuild.last_progress_at, rebuild.started_at, rebuild.created_at)
            )) > 0
            THEN (counts.completed - rebuild.processed_source_count)
              / extract(epoch FROM (
                  ${input.now}::timestamptz
                  - coalesce(
                      rebuild.last_progress_at,
                      rebuild.started_at,
                      rebuild.created_at
                    )
                ))
          ELSE rebuild.recent_files_per_second
        END,
        rolling_source_read_latency_ms = coalesce(
          ${input.sourceReadLatencyMs ?? null},
          rebuild.rolling_source_read_latency_ms
        ),
        rolling_database_batch_latency_ms = coalesce(
          ${input.databaseBatchLatencyMs ?? null},
          rebuild.rolling_database_batch_latency_ms
        ),
        last_worker_heartbeat_at = ${input.now},
        estimated_completion_at = CASE
          WHEN rebuild.recent_files_per_second > 0
            THEN ${input.now}::timestamptz
              + make_interval(
                  secs => ((counts.total - counts.completed)
                    / rebuild.recent_files_per_second)::double precision
                )
          ELSE NULL
        END,
        updated_at = ${input.now}
    FROM counts
    WHERE rebuild.knowledge_base_id = ${input.knowledgeBaseId}
      AND rebuild.target_generation_id = ${input.targetGenerationId}
    RETURNING counts.completed, counts.pending, counts.running,
              counts.retrying, counts.failed, counts.total
  `;
  const row = rows[0] ?? {
    completed: 0,
    pending: 0,
    running: 0,
    retrying: 0,
    failed: 0,
    total: 0
  };
  return {
    completed: Number(row.completed),
    pending: Number(row.pending),
    running: Number(row.running),
    retrying: Number(row.retrying),
    failed: Number(row.failed),
    total: Number(row.total)
  };
}

async function promoteCoordinatorWhenReady(
  transaction: WriteSql,
  input: {
    knowledgeBaseId: string;
    targetGenerationId: string;
    now: string;
    progress: {
      completed: number;
      pending: number;
      running: number;
      retrying: number;
      failed: number;
      total: number;
    };
  }
): Promise<void> {
  if (
    input.progress.pending > 0
    || input.progress.running > 0
    || input.progress.retrying > 0
    || input.progress.failed > 0
    || input.progress.completed !== input.progress.total
  ) {
    return;
  }
  await transaction`
    UPDATE focowiki.knowledge_base_lexical_rebuilds
    SET phase = 'validate', state = 'pending',
        source_cursor = NULL, next_attempt_at = ${input.now},
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
        updated_at = ${input.now}
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND target_generation_id = ${input.targetGenerationId}
      AND phase IN ('documents', 'reconcile')
  `;
}

async function updateCoordinatorHeartbeats(
  sql: DatabaseClient,
  claims: LexicalRebuildWorkClaim[],
  heartbeatAt: string
): Promise<void> {
  const targets = Array.from(new Set(claims.map((claim) => claim.targetGenerationId)));
  if (targets.length === 0) return;
  await sql`
    UPDATE focowiki.knowledge_base_lexical_rebuilds
    SET last_worker_heartbeat_at = ${heartbeatAt},
        updated_at = ${heartbeatAt}
    WHERE target_generation_id = ANY(${targets})
  `;
}

function mapClaim(row: ClaimRow): LexicalRebuildWorkClaim {
  return {
    knowledgeBaseId: row.knowledge_base_id,
    targetGenerationId: row.target_generation_id,
    sourceFileId: row.source_file_id,
    sourceRevisionId: row.source_revision_id,
    logicalPath: row.logical_path,
    leaseToken: row.lease_token,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    settingsRevision: Number(row.settings_revision),
    settings: row.settings_snapshot_json
  };
}

function mapSource(row: SourceRow): LexicalRebuildWorkSource {
  return {
    ...mapClaim(row),
    relativePath: row.relative_path,
    objectKey: row.object_key,
    sizeBytes: Number(row.size_bytes),
    checksumSha256: row.checksum_sha256,
    title: row.title,
    summary: row.summary,
    sourceUrl: row.source_url,
    metadata: row.metadata_json,
    suggestions: row.suggestions_json
  };
}

function mapProgress(row: ProgressRow): LexicalRebuildProgress {
  return {
    knowledgeBaseId: row.knowledge_base_id,
    targetGenerationId: row.target_generation_id,
    state: row.state,
    phase: row.phase,
    completed: Number(row.processed_source_count),
    pending: Number(row.pending_source_count),
    running: Number(row.running_source_count),
    retrying: Number(row.retry_source_count),
    failed: Number(row.failed_source_count),
    total: Number(row.total_source_count),
    sourceReadRetries: Number(row.source_read_retry_count),
    databaseRetries: Number(row.database_retry_count),
    recentFilesPerSecond: nullableNumber(row.recent_files_per_second),
    sourceReadLatencyMs: nullableNumber(row.rolling_source_read_latency_ms),
    databaseBatchLatencyMs: nullableNumber(row.rolling_database_batch_latency_ms),
    lastProgressAt: row.last_progress_at?.toISOString() ?? null,
    lastHeartbeatAt: row.last_worker_heartbeat_at?.toISOString() ?? null,
    estimatedCompletionAt: row.estimated_completion_at?.toISOString() ?? null
  };
}

function graphNodeRow(knowledgeBaseId: string, node: OkfGraphNode) {
  const metadata = node.metadata ?? {};
  const profile = objectValue(metadata.contentProfile);
  return {
    knowledge_base_id: knowledgeBaseId,
    source_file_id: node.fileId,
    path: node.path,
    title: node.title,
    type: node.type ?? null,
    description: node.description ?? null,
    summary: node.summary ?? null,
    subjects_json: node.subjects ?? [],
    tags_json: node.tags ?? [],
    entities_json: node.entities ?? [],
    explicit_references_json: node.explicitReferences ?? [],
    relationship_hints_json: node.relationshipHints ?? [],
    headings_json: node.headings ?? [],
    keywords_json: node.keywords ?? [],
    language: node.language ?? null,
    profile_version: node.profileVersion ?? null,
    profile_source: node.profileSource ?? null,
    profile_json: metadata,
    metadata_json: metadata,
    tokenizer_contract_version: stringValue(profile.tokenizerContractVersion),
    lexical_projection_version: stringValue(profile.profileVersion)
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function groupClaims(rows: ClaimedRow[]): Array<{
  knowledgeBaseId: string;
  targetGenerationId: string;
  pending: number;
  retrying: number;
}> {
  const grouped = new Map<string, {
    knowledgeBaseId: string;
    targetGenerationId: string;
    pending: number;
    retrying: number;
  }>();
  for (const row of rows) {
    const key = `${row.knowledge_base_id}:${row.target_generation_id}`;
    const current = grouped.get(key) ?? {
      knowledgeBaseId: row.knowledge_base_id,
      targetGenerationId: row.target_generation_id,
      pending: 0,
      retrying: 0
    };
    if (row.previous_state === "pending") current.pending += 1;
    if (row.previous_state === "retry") current.retrying += 1;
    grouped.set(key, current);
  }
  return [...grouped.values()];
}

function groupCompletions(rows: Array<{
  knowledge_base_id: string;
  target_generation_id: string;
  source_read_retry_count: number;
}>): Array<{
  knowledgeBaseId: string;
  targetGenerationId: string;
  completed: number;
  sourceReadRetries: number;
}> {
  const grouped = new Map<string, {
    knowledgeBaseId: string;
    targetGenerationId: string;
    completed: number;
    sourceReadRetries: number;
  }>();
  for (const row of rows) {
    const key = `${row.knowledge_base_id}:${row.target_generation_id}`;
    const current = grouped.get(key) ?? {
      knowledgeBaseId: row.knowledge_base_id,
      targetGenerationId: row.target_generation_id,
      completed: 0,
      sourceReadRetries: 0
    };
    current.completed += 1;
    current.sourceReadRetries += Number(row.source_read_retry_count);
    grouped.set(key, current);
  }
  return [...grouped.values()];
}

function progressCounts(row: {
  completed: number;
  pending: number;
  running: number;
  retrying: number;
  failed: number;
  total: number;
} | undefined) {
  return {
    completed: Number(row?.completed ?? 0),
    pending: Number(row?.pending ?? 0),
    running: Number(row?.running ?? 0),
    retrying: Number(row?.retrying ?? 0),
    failed: Number(row?.failed ?? 0),
    total: Number(row?.total ?? 0)
  };
}

function boundedClaimLimit(value: number): number {
  return Math.max(1, Math.min(2_000, Math.floor(value)));
}

function nullableNumber(value: number | null): number | null {
  return value === null ? null : Number(value);
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
