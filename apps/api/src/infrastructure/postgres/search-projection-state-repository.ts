import type {
  KnowledgeBaseSearchState,
  SearchProjectionStateRepository,
  SearchProjectionWork,
  SearchProjectionWorkDraft
} from "../../application/ports/search-projection-state-repository.js";
import type { DatabaseClient } from "../../db/client.js";
import type { TransactionSql } from "postgres";

type SearchStateRow = {
  knowledge_base_id: string;
  route_state: KnowledgeBaseSearchState["routeState"];
  active_epoch: number | string;
  pending_epoch: number | string | null;
  pending_activation_state: KnowledgeBaseSearchState["pendingActivationState"];
  pending_full_rebuild: boolean;
  active_generation_id: string | null;
  pending_generation_id: string | null;
  content_schema_version: string | null;
  graph_schema_version: string | null;
  content_settings_checksum: string | null;
  graph_settings_checksum: string | null;
  pending_content_schema_version: string | null;
  pending_graph_schema_version: string | null;
  pending_content_settings_checksum: string | null;
  pending_graph_settings_checksum: string | null;
  maintenance_required: boolean;
  updated_at: Date;
};

type SearchWorkRow = {
  id: string;
  knowledge_base_id: string;
  epoch: number | string;
  generation_id: string | null;
  maintenance_request_id: string | null;
  index_kind: SearchProjectionWork["indexKind"];
  work_kind: SearchProjectionWork["workKind"];
  batch_ordinal: number;
  payload_checksum: string;
  document_count: number;
  compressed_bytes: number | string;
  state: SearchProjectionWork["state"];
  task_uid: number | string | null;
  task_correlation: string;
  checkpoint_json: Record<string, unknown>;
  lease_owner: string | null;
  lease_token: string | null;
  attempt_count: number;
  max_attempts: number;
  run_after: Date;
  safe_error_code: string | null;
  safe_error_message: string | null;
};

export function createPostgresSearchProjectionStateRepository(
  sql: DatabaseClient
): SearchProjectionStateRepository {
  return {
    async getState(knowledgeBaseId) {
      const rows = await selectSearchState(sql, knowledgeBaseId);
      return rows[0] ? mapState(rows[0]) : null;
    },

    async reservePendingEpoch(input) {
      return sql.begin(async (transaction) => {
        await transaction`
          SELECT pg_advisory_xact_lock(
            hashtextextended('focowiki:search-epoch:' || ${input.knowledgeBaseId}, 0)
          )
        `;
        const existing = await selectSearchState(
          transaction,
          input.knowledgeBaseId,
          true
        );
        if (!existing[0]) return { outcome: "not_found" as const };
        const current = mapState(existing[0]);
        if (current.pendingEpoch !== null) {
          return {
            outcome: current.pendingGenerationId === input.generationId
              ? "existing" as const
              : "busy" as const,
            state: current
          };
        }
        const rows = await transaction<SearchStateRow[]>`
          UPDATE focowiki.knowledge_base_search_states
          SET pending_epoch = active_epoch + 1,
              pending_activation_state = 'indexing',
              pending_full_rebuild = (
                ${input.forceFullRebuild === true}
                OR active_epoch = 0
                OR content_schema_version IS DISTINCT FROM
                  ${input.contract.contentSchemaVersion}
                OR graph_schema_version IS DISTINCT FROM
                  ${input.contract.graphSchemaVersion}
                OR content_settings_checksum IS DISTINCT FROM
                  ${input.contract.contentSettingsChecksum}
                OR graph_settings_checksum IS DISTINCT FROM
                  ${input.contract.graphSettingsChecksum}
              ),
              pending_generation_id = ${input.generationId},
              pending_content_schema_version =
                ${input.contract.contentSchemaVersion},
              pending_graph_schema_version =
                ${input.contract.graphSchemaVersion},
              pending_content_settings_checksum =
                ${input.contract.contentSettingsChecksum},
              pending_graph_settings_checksum =
                ${input.contract.graphSettingsChecksum},
              last_maintenance_request_id = ${input.maintenanceRequestId},
              maintenance_required = true,
              updated_at = ${input.reservedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
          RETURNING *
        `;
        return {
          outcome: "reserved" as const,
          state: mapState(rows[0]!)
        };
      });
    },

    async createWork(items) {
      if (items.length === 0) return 0;
      const rows = await sql<Array<{ id: string }>>`
        INSERT INTO focowiki.search_projection_work (
          id, knowledge_base_id, epoch, generation_id,
          maintenance_request_id, index_kind, work_kind, batch_ordinal,
          payload_checksum, document_count, compressed_bytes,
          task_correlation, checkpoint_json, max_attempts
        )
        SELECT
          item.id, item.knowledge_base_id, item.epoch, item.generation_id,
          item.maintenance_request_id, item.index_kind, item.work_kind,
          item.batch_ordinal, item.payload_checksum, item.document_count,
          item.compressed_bytes, item.task_correlation,
          item.checkpoint_json, item.max_attempts
        FROM jsonb_to_recordset(${sql.json(items.map(toWorkJson) as never)}) AS item(
          id text,
          knowledge_base_id text,
          epoch bigint,
          generation_id text,
          maintenance_request_id text,
          index_kind text,
          work_kind text,
          batch_ordinal integer,
          payload_checksum text,
          document_count integer,
          compressed_bytes bigint,
          task_correlation text,
          checkpoint_json jsonb,
          max_attempts integer
        )
        ON CONFLICT (
          knowledge_base_id, generation_id, epoch, index_kind, work_kind,
          batch_ordinal, payload_checksum
        ) DO NOTHING
        RETURNING id
      `;
      return rows.length;
    },

    async getEpochProgress(input) {
      const rows = await sql<Array<{
        total: number;
        queued: number;
        submitted: number;
        retry: number;
        succeeded: number;
        failed: number;
        canceled: number;
        superseded: number;
        activation_ready: boolean;
      }>>`
        SELECT
          count(*) FILTER (WHERE work_kind <> 'cleanup')::int AS total,
          count(*) FILTER (
            WHERE work_kind <> 'cleanup' AND state = 'queued'
          )::int AS queued,
          count(*) FILTER (
            WHERE work_kind <> 'cleanup' AND state = 'submitted'
          )::int AS submitted,
          count(*) FILTER (
            WHERE work_kind <> 'cleanup' AND state = 'retry'
          )::int AS retry,
          count(*) FILTER (
            WHERE work_kind <> 'cleanup' AND state = 'succeeded'
          )::int AS succeeded,
          count(*) FILTER (
            WHERE work_kind <> 'cleanup' AND state = 'failed'
          )::int AS failed,
          count(*) FILTER (
            WHERE work_kind <> 'cleanup' AND state = 'canceled'
          )::int AS canceled,
          count(*) FILTER (
            WHERE work_kind <> 'cleanup' AND state = 'superseded'
          )::int AS superseded,
          coalesce(
            bool_or(work_kind = 'activate' AND state = 'succeeded'),
            false
          ) AS activation_ready
        FROM focowiki.search_projection_work work
        JOIN focowiki.knowledge_base_search_states search_state
          ON search_state.knowledge_base_id = work.knowledge_base_id
         AND search_state.pending_epoch = work.epoch
         AND search_state.pending_generation_id = work.generation_id
        WHERE work.knowledge_base_id = ${input.knowledgeBaseId}
          AND work.epoch = ${input.epoch}
      `;
      const row = rows[0]!;
      return {
        total: Number(row.total),
        queued: Number(row.queued),
        submitted: Number(row.submitted),
        retry: Number(row.retry),
        succeeded: Number(row.succeeded),
        failed: Number(row.failed),
        canceled: Number(row.canceled),
        superseded: Number(row.superseded),
        activationReady: row.activation_ready
      };
    },

    async claimWork(input) {
      return sql.begin(async (transaction) => {
        await transaction`
          SELECT pg_advisory_xact_lock(
            hashtextextended('focowiki:search-index-claim', 0)
          )
        `;
        const rows = await transaction<SearchWorkRow[]>`
        WITH capacity AS MATERIALIZED (
          SELECT count(*)::int AS in_flight_count
          FROM focowiki.search_projection_work
          WHERE state = 'submitted'
             OR (
               state IN ('queued', 'retry')
               AND lease_expires_at > ${input.now}
             )
        ), ranked_candidates AS MATERIALIZED (
          SELECT work.id,
                 work.state,
                 row_number() OVER (
                   PARTITION BY (work.state = 'submitted')
                   ORDER BY work.run_after, work.created_at, work.id
                 )::int AS category_ordinal,
                 capacity.in_flight_count
          FROM focowiki.search_projection_work work
          CROSS JOIN capacity
          JOIN focowiki.knowledge_base_search_states state
            ON state.knowledge_base_id = work.knowledge_base_id
           AND (
             (
               state.pending_epoch = work.epoch
               AND state.pending_generation_id = work.generation_id
             )
             OR (
               work.work_kind IN ('activate', 'cleanup')
               AND state.active_epoch >= work.epoch
               AND state.active_generation_id = work.generation_id
             )
           )
          JOIN focowiki.knowledge_bases knowledge_base
            ON knowledge_base.id = work.knowledge_base_id
           AND knowledge_base.deleted_at IS NULL
          WHERE work.state IN ('queued', 'submitted', 'retry')
            AND work.run_after <= ${input.now}
            AND (
              work.state = 'submitted'
              OR (
                ${input.allowNewSubmissions}
                AND capacity.in_flight_count < ${input.maxInFlightTasks}
              )
            )
            AND (
              work.work_kind = 'prepare_index'
              OR (
                work.work_kind IN ('documents', 'delete_documents')
                AND NOT EXISTS (
                  SELECT 1
                  FROM focowiki.search_projection_work prerequisite
                  WHERE prerequisite.knowledge_base_id = work.knowledge_base_id
                    AND prerequisite.epoch = work.epoch
                    AND prerequisite.generation_id = work.generation_id
                    AND prerequisite.index_kind = work.index_kind
                    AND prerequisite.work_kind = 'prepare_index'
                    AND prerequisite.state <> 'succeeded'
                )
              )
              OR (
                work.work_kind = 'validate'
                AND NOT EXISTS (
                  SELECT 1
                  FROM focowiki.search_projection_work prerequisite
                  WHERE prerequisite.knowledge_base_id = work.knowledge_base_id
                    AND prerequisite.epoch = work.epoch
                    AND prerequisite.generation_id = work.generation_id
                    AND prerequisite.work_kind IN (
                      'prepare_index', 'documents', 'delete_documents'
                    )
                    AND prerequisite.state <> 'succeeded'
                )
              )
              OR (
                work.work_kind = 'activate'
                AND NOT EXISTS (
                  SELECT 1
                  FROM focowiki.search_projection_work prerequisite
                  WHERE prerequisite.knowledge_base_id = work.knowledge_base_id
                    AND prerequisite.epoch = work.epoch
                    AND prerequisite.generation_id = work.generation_id
                    AND prerequisite.work_kind = 'validate'
                    AND prerequisite.state <> 'succeeded'
                )
              )
              OR (
                work.work_kind = 'cleanup'
                AND (
                  (
                    state.active_epoch >= work.epoch
                    AND NOT EXISTS (
                      SELECT 1
                      FROM focowiki.search_projection_work prerequisite
                      WHERE prerequisite.knowledge_base_id = work.knowledge_base_id
                        AND prerequisite.epoch = work.epoch
                        AND prerequisite.generation_id = work.generation_id
                        AND prerequisite.work_kind = 'activate'
                        AND prerequisite.state <> 'succeeded'
                    )
                  )
                  OR EXISTS (
                    SELECT 1
                    FROM focowiki.search_projection_work failed
                    WHERE failed.knowledge_base_id = work.knowledge_base_id
                      AND failed.epoch = work.epoch
                      AND failed.generation_id = work.generation_id
                      AND failed.work_kind <> 'cleanup'
                      AND failed.state IN ('failed', 'canceled', 'superseded')
                  )
                )
              )
            )
            AND (
              work.lease_expires_at IS NULL
              OR work.lease_expires_at <= ${input.now}
              OR work.lease_owner = ${input.workerId}
            )
        ), candidates AS MATERIALIZED (
          SELECT id
          FROM ranked_candidates
          WHERE state = 'submitted'
             OR category_ordinal <= GREATEST(
               0,
               ${input.maxInFlightTasks} - in_flight_count
             )
          ORDER BY
            CASE WHEN state = 'submitted' THEN 0 ELSE 1 END,
            category_ordinal,
            id
          LIMIT ${Math.min(
            boundedLimit(input.limit),
            boundedLimit(input.maxInFlightTasks)
          )}
        )
        UPDATE focowiki.search_projection_work work
        SET lease_owner = ${input.workerId},
            lease_token = ${input.leaseTokenPrefix} || '-' || md5(work.id),
            lease_expires_at = ${input.leaseExpiresAt},
            heartbeat_at = ${input.now},
            updated_at = ${input.now}
        FROM candidates
        WHERE work.id = candidates.id
        RETURNING work.*
      `;
        return rows.map(mapWork);
      });
    },

    async markSubmitted(input) {
      const rows = await sql<Array<{ id: string }>>`
        UPDATE focowiki.search_projection_work
        SET state = 'submitted',
            task_uid = ${input.taskUid},
            submitted_at = ${input.submittedAt},
            heartbeat_at = ${input.submittedAt},
            lease_expires_at = ${input.leaseExpiresAt},
            safe_error_code = NULL,
            safe_error_message = NULL,
            updated_at = ${input.submittedAt}
        WHERE id = ${input.work.id}
          AND lease_owner = ${input.work.leaseOwner}
          AND lease_token = ${input.work.leaseToken}
          AND state IN ('queued', 'retry')
        RETURNING id
      `;
      return rows.length === 1;
    },

    async markSucceeded(input) {
      const rows = await sql<Array<{ id: string }>>`
        UPDATE focowiki.search_projection_work
        SET state = 'succeeded',
            completed_at = ${input.completedAt},
            heartbeat_at = ${input.completedAt},
            lease_owner = NULL,
            lease_token = NULL,
            lease_expires_at = NULL,
            safe_error_code = NULL,
            safe_error_message = NULL,
            updated_at = ${input.completedAt}
        WHERE id = ${input.work.id}
          AND lease_owner = ${input.work.leaseOwner}
          AND lease_token = ${input.work.leaseToken}
          AND (
            (
              state = 'submitted'
              AND task_uid = ${input.work.taskUid}
            )
            OR (
              state IN ('queued', 'retry')
              AND ${input.work.taskUid}::bigint IS NULL
            )
          )
        RETURNING id
      `;
      return rows.length === 1;
    },

    async retryOrFail(input) {
      return sql.begin(async (transaction) => {
        const rows = await transaction<Array<{ state: "retry" | "failed" }>>`
          UPDATE focowiki.search_projection_work
          SET state = CASE
                WHEN attempt_count + 1 >= max_attempts THEN 'failed'
                ELSE 'retry'
              END,
              attempt_count = attempt_count + 1,
              run_after = CASE
                WHEN attempt_count + 1 >= max_attempts
                  THEN run_after
                ELSE ${input.retryAt}
              END,
              task_uid = NULL,
              submitted_at = NULL,
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              safe_error_code = ${input.code.slice(0, 120)},
              safe_error_message = ${input.message.slice(0, 500)},
              completed_at = CASE
                WHEN attempt_count + 1 >= max_attempts
                  THEN ${input.failedAt}::timestamptz
                ELSE NULL
              END,
              updated_at = ${input.failedAt}
          WHERE id = ${input.work.id}
            AND lease_owner = ${input.work.leaseOwner}
            AND lease_token = ${input.work.leaseToken}
            AND state IN ('queued', 'submitted', 'retry')
          RETURNING state
        `;
        const outcome = rows[0]?.state ?? "lost";
        if (outcome === "failed") {
          await transaction`
            UPDATE focowiki.search_projection_work
            SET state = 'canceled',
                task_uid = NULL,
                submitted_at = NULL,
                lease_owner = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                completed_at = ${input.failedAt},
                safe_error_code = 'SEARCH_INDEX_EPOCH_FAILED',
                safe_error_message =
                  'Search indexing stopped after a related work item failed.',
                updated_at = ${input.failedAt}
            WHERE knowledge_base_id = ${input.work.knowledgeBaseId}
              AND epoch = ${input.work.epoch}
              AND id <> ${input.work.id}
              AND work_kind <> 'cleanup'
              AND state IN ('queued', 'submitted', 'retry')
          `;
        }
        return outcome;
      });
    },

    async restartFailedEpoch(input) {
      return sql.begin(async (transaction) => {
        await transaction`
          SELECT pg_advisory_xact_lock(
            hashtextextended(
              'focowiki:search-epoch:' || ${input.knowledgeBaseId},
              0
            )
          )
        `;
        const states = await selectSearchState(
          transaction,
          input.knowledgeBaseId,
          true
        );
        const state = states[0] ? mapState(states[0]) : null;
        if (
          !state
          || state.pendingEpoch !== input.epoch
          || state.pendingGenerationId !== input.generationId
        ) {
          return false;
        }
        if (!await isFailedEpochReadyForRestart(transaction, {
          knowledgeBaseId: input.knowledgeBaseId,
          generationId: input.generationId,
          epoch: input.epoch
        })) {
          return false;
        }

        await transaction`
          UPDATE focowiki.search_projection_work
          SET state = 'queued',
              maintenance_request_id = ${input.maintenanceRequestId},
              task_uid = NULL,
              submitted_at = NULL,
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              attempt_count = 0,
              max_attempts = ${input.maxAttempts},
              run_after = ${input.restartedAt},
              completed_at = NULL,
              safe_error_code = NULL,
              safe_error_message = NULL,
              updated_at = ${input.restartedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND epoch = ${input.epoch}
            AND generation_id = ${input.generationId}
            AND (
              ${input.resetAll}
              OR work_kind = 'cleanup'
              OR state IN ('failed', 'canceled', 'superseded')
            )
        `;
        await transaction`
          UPDATE focowiki.knowledge_base_search_states
          SET pending_activation_state = 'indexing',
              pending_content_schema_version =
                ${input.contract.contentSchemaVersion},
              pending_graph_schema_version =
                ${input.contract.graphSchemaVersion},
              pending_content_settings_checksum =
                ${input.contract.contentSettingsChecksum},
              pending_graph_settings_checksum =
                ${input.contract.graphSettingsChecksum},
              last_maintenance_request_id = ${input.maintenanceRequestId},
              maintenance_required = true,
              updated_at = ${input.restartedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND pending_epoch = ${input.epoch}
            AND pending_generation_id = ${input.generationId}
        `;
        return true;
      });
    },

    async rebaseFailedEpoch(input) {
      return sql.begin(async (transaction) => {
        await transaction`
          SELECT pg_advisory_xact_lock(
            hashtextextended(
              'focowiki:search-epoch:' || ${input.knowledgeBaseId},
              0
            )
          )
        `;
        const states = await selectSearchState(
          transaction,
          input.knowledgeBaseId,
          true
        );
        const current = states[0] ? mapState(states[0]) : null;
        if (
          !current
          || current.pendingEpoch !== input.epoch
          || current.pendingGenerationId === input.generationId
          || current.pendingGenerationId === null
        ) {
          return null;
        }
        if (!await isFailedEpochReadyForRestart(transaction, {
          knowledgeBaseId: input.knowledgeBaseId,
          generationId: current.pendingGenerationId,
          epoch: input.epoch
        })) {
          return null;
        }

        await transaction`
          UPDATE focowiki.search_projection_work
          SET state = 'superseded',
              task_uid = NULL,
              submitted_at = NULL,
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              completed_at = ${input.rebasedAt},
              updated_at = ${input.rebasedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND epoch = ${input.epoch}
            AND generation_id = ${current.pendingGenerationId}
        `;
        const rows = await transaction<SearchStateRow[]>`
          UPDATE focowiki.knowledge_base_search_states
          SET pending_activation_state = 'indexing',
              pending_full_rebuild = true,
              pending_generation_id = ${input.generationId},
              pending_content_schema_version =
                ${input.contract.contentSchemaVersion},
              pending_graph_schema_version =
                ${input.contract.graphSchemaVersion},
              pending_content_settings_checksum =
                ${input.contract.contentSettingsChecksum},
              pending_graph_settings_checksum =
                ${input.contract.graphSettingsChecksum},
              last_maintenance_request_id = ${input.maintenanceRequestId},
              maintenance_required = true,
              updated_at = ${input.rebasedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND pending_epoch = ${input.epoch}
            AND pending_generation_id = ${current.pendingGenerationId}
          RETURNING *
        `;
        return rows[0] ? mapState(rows[0]) : null;
      });
    },

    async retryFailedCleanup(input) {
      const rows = await sql<Array<{ id: string }>>`
        UPDATE focowiki.search_projection_work
        SET state = 'queued',
            maintenance_request_id = ${input.maintenanceRequestId},
            task_uid = NULL,
            submitted_at = NULL,
            lease_owner = NULL,
            lease_token = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            attempt_count = 0,
            max_attempts = ${input.maxAttempts},
            run_after = ${input.retriedAt},
            completed_at = NULL,
            safe_error_code = NULL,
            safe_error_message = NULL,
            updated_at = ${input.retriedAt}
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND epoch = ${input.epoch}
          AND generation_id = ${input.generationId}
          AND work_kind = 'cleanup'
          AND state IN ('failed', 'canceled', 'superseded')
          AND maintenance_request_id IS DISTINCT FROM
            ${input.maintenanceRequestId}
          AND EXISTS (
            SELECT 1
            FROM focowiki.search_projection_work terminal
            WHERE terminal.knowledge_base_id = ${input.knowledgeBaseId}
              AND terminal.epoch = ${input.epoch}
              AND terminal.generation_id = ${input.generationId}
              AND terminal.work_kind <> 'cleanup'
              AND terminal.state IN ('failed', 'canceled', 'superseded')
          )
        RETURNING id
      `;
      return rows.length;
    },

    async beginActivation(input) {
      return sql.begin(async (transaction) => {
        await transaction`
          SELECT pg_advisory_xact_lock(
            hashtextextended('focowiki:search-epoch:' || ${input.knowledgeBaseId}, 0)
          )
        `;
        const incomplete = await transaction<Array<{ count: number }>>`
          SELECT count(*)::int AS count
          FROM focowiki.search_projection_work
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND epoch = ${input.epoch}
            AND generation_id = ${input.generationId}
            AND work_kind NOT IN ('activate', 'cleanup')
            AND state <> 'succeeded'
        `;
        if (Number(incomplete[0]?.count ?? 0) > 0) return false;
        const rows = await transaction<Array<{ knowledge_base_id: string }>>`
          UPDATE focowiki.knowledge_base_search_states
          SET pending_activation_state = 'swapping',
              updated_at = ${input.startedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND pending_epoch = ${input.epoch}
            AND pending_generation_id = ${input.generationId}
            AND pending_activation_state IN ('indexing', 'swapping')
          RETURNING knowledge_base_id
        `;
        return rows.length === 1;
      });
    },

    async activateEpoch(input) {
      return sql.begin(async (transaction) => {
        await transaction`
          SELECT pg_advisory_xact_lock(
            hashtextextended('focowiki:search-epoch:' || ${input.knowledgeBaseId}, 0)
          )
        `;
        const incomplete = await transaction<Array<{ count: number }>>`
          SELECT count(*)::int AS count
          FROM focowiki.search_projection_work
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND epoch = ${input.epoch}
            AND generation_id = ${input.generationId}
            AND work_kind NOT IN ('activate', 'cleanup')
            AND state <> 'succeeded'
        `;
        if (Number(incomplete[0]?.count ?? 0) > 0) return false;
        const rows = await transaction<Array<{ knowledge_base_id: string }>>`
          UPDATE focowiki.knowledge_base_search_states
          SET route_state = 'meilisearch',
              active_epoch = ${input.epoch},
              pending_epoch = NULL,
              pending_activation_state = 'indexing',
              pending_full_rebuild = false,
              active_generation_id = ${input.generationId},
              pending_generation_id = NULL,
              content_schema_version = ${input.contentSchemaVersion},
              graph_schema_version = ${input.graphSchemaVersion},
              content_settings_checksum = ${input.contentSettingsChecksum},
              graph_settings_checksum = ${input.graphSettingsChecksum},
              pending_content_schema_version = NULL,
              pending_graph_schema_version = NULL,
              pending_content_settings_checksum = NULL,
              pending_graph_settings_checksum = NULL,
              maintenance_required = false,
              activated_at = ${input.activatedAt},
              updated_at = ${input.activatedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND pending_epoch = ${input.epoch}
            AND pending_generation_id = ${input.generationId}
            AND pending_activation_state = 'swapping'
          RETURNING knowledge_base_id
        `;
        return rows.length === 1;
      });
    },

    async cancelForKnowledgeBase(input) {
      const rows = await sql<Array<{ id: string }>>`
        UPDATE focowiki.search_projection_work
        SET state = 'canceled',
            lease_owner = NULL,
            lease_token = NULL,
            lease_expires_at = NULL,
            completed_at = ${input.canceledAt},
            updated_at = ${input.canceledAt}
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND state IN ('queued', 'submitted', 'retry')
        RETURNING id
      `;
      return rows.length;
    }
  };
}

type ReadSql = DatabaseClient | TransactionSql;

function selectSearchState(
  sql: ReadSql,
  knowledgeBaseId: string,
  forUpdate = false
): Promise<SearchStateRow[]> {
  return forUpdate
    ? sql<SearchStateRow[]>`
        SELECT *
        FROM focowiki.knowledge_base_search_states
        WHERE knowledge_base_id = ${knowledgeBaseId}
        FOR UPDATE
      `
    : sql<SearchStateRow[]>`
        SELECT *
        FROM focowiki.knowledge_base_search_states
        WHERE knowledge_base_id = ${knowledgeBaseId}
      `;
}

async function isFailedEpochReadyForRestart(
  sql: TransactionSql,
  input: {
    knowledgeBaseId: string;
    generationId: string;
    epoch: number;
  }
): Promise<boolean> {
  const rows = await sql<Array<{
    terminal_count: number;
    cleanup_count: number;
    incomplete_cleanup_count: number;
    executed_non_prepare_count: number;
  }>>`
    SELECT
      count(*) FILTER (
        WHERE work_kind <> 'cleanup'
          AND state IN ('failed', 'canceled', 'superseded')
      )::int AS terminal_count,
      count(*) FILTER (
        WHERE work_kind = 'cleanup'
      )::int AS cleanup_count,
      count(*) FILTER (
        WHERE work_kind = 'cleanup'
          AND state <> 'succeeded'
      )::int AS incomplete_cleanup_count,
      count(*) FILTER (
        WHERE work_kind NOT IN ('prepare_index', 'cleanup')
          AND (
            attempt_count > 0
            OR task_uid IS NOT NULL
            OR submitted_at IS NOT NULL
            OR heartbeat_at IS NOT NULL
            OR state = 'succeeded'
          )
      )::int AS executed_non_prepare_count
    FROM focowiki.search_projection_work
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND epoch = ${input.epoch}
      AND generation_id = ${input.generationId}
  `;
  const readiness = rows[0];
  if (!readiness || readiness.terminal_count === 0) return false;
  const safelyPreparationOnly =
    readiness.cleanup_count === 0
    && readiness.executed_non_prepare_count === 0;
  const cleanupCompleted =
    readiness.cleanup_count > 0
    && readiness.incomplete_cleanup_count === 0;
  return safelyPreparationOnly || cleanupCompleted;
}

function mapState(row: SearchStateRow): KnowledgeBaseSearchState {
  return {
    knowledgeBaseId: row.knowledge_base_id,
    routeState: row.route_state,
    activeEpoch: Number(row.active_epoch),
    pendingEpoch: row.pending_epoch === null ? null : Number(row.pending_epoch),
    pendingActivationState: row.pending_activation_state,
    pendingFullRebuild: row.pending_full_rebuild,
    activeGenerationId: row.active_generation_id,
    pendingGenerationId: row.pending_generation_id,
    contentSchemaVersion: row.content_schema_version,
    graphSchemaVersion: row.graph_schema_version,
    contentSettingsChecksum: row.content_settings_checksum,
    graphSettingsChecksum: row.graph_settings_checksum,
    pendingContentSchemaVersion: row.pending_content_schema_version,
    pendingGraphSchemaVersion: row.pending_graph_schema_version,
    pendingContentSettingsChecksum: row.pending_content_settings_checksum,
    pendingGraphSettingsChecksum: row.pending_graph_settings_checksum,
    maintenanceRequired: row.maintenance_required,
    updatedAt: row.updated_at.toISOString()
  };
}

function mapWork(row: SearchWorkRow): SearchProjectionWork {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    epoch: Number(row.epoch),
    generationId: row.generation_id,
    maintenanceRequestId: row.maintenance_request_id,
    indexKind: row.index_kind,
    workKind: row.work_kind,
    batchOrdinal: row.batch_ordinal,
    payloadChecksum: row.payload_checksum,
    documentCount: row.document_count,
    compressedBytes: Number(row.compressed_bytes),
    state: row.state,
    taskUid: row.task_uid === null ? null : Number(row.task_uid),
    taskCorrelation: row.task_correlation,
    checkpoint: row.checkpoint_json,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    runAfter: row.run_after.toISOString(),
    safeErrorCode: row.safe_error_code,
    safeErrorMessage: row.safe_error_message
  };
}

function toWorkJson(item: SearchProjectionWorkDraft): Record<string, unknown> {
  return {
    id: item.id,
    knowledge_base_id: item.knowledgeBaseId,
    epoch: item.epoch,
    generation_id: item.generationId,
    maintenance_request_id: item.maintenanceRequestId,
    index_kind: item.indexKind,
    work_kind: item.workKind,
    batch_ordinal: item.batchOrdinal,
    payload_checksum: item.payloadChecksum,
    document_count: item.documentCount,
    compressed_bytes: item.compressedBytes,
    task_correlation: item.taskCorrelation,
    checkpoint_json: item.checkpoint ?? {},
    max_attempts: item.maxAttempts
  };
}

function boundedLimit(value: number): number {
  return Math.min(100, Math.max(1, Math.trunc(value)));
}
