import type {
  KnowledgeBaseIndexMaintenanceClaim,
  KnowledgeBaseIndexMaintenanceRepository,
  KnowledgeBaseIndexMaintenanceRequest,
  KnowledgeBaseIndexMaintenanceState,
  KnowledgeBaseIndexMaintenanceSummary,
  KnowledgeBaseIndexMaintenanceTrigger
} from "../../application/ports/knowledge-base-index-maintenance-repository.js";
import type { DatabaseClient } from "../../db/client.js";
import {
  REQUIRED_PROJECTION_REPAIR_VERSIONS
} from "../../maintenance/projection-repair-plan.js";

type RequestRow = {
  id: string;
  knowledge_base_id: string;
  trigger_kind: KnowledgeBaseIndexMaintenanceTrigger;
  state: KnowledgeBaseIndexMaintenanceState;
  base_generation_id: string | null;
  source_watermark: number | null;
  settings_revision: number;
  planned_scopes: string[];
  completed_scopes: string[];
  current_stage: string | null;
  completed_count: number;
  expected_count: number;
  retry_count: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_token: string | null;
  last_progress_at: Date | null;
  last_error_code: string | null;
  last_error_message: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type SummaryRow = RequestRow & {
  maintenance_required: boolean;
  last_completed_at: Date | null;
};

const ACTIVE_STATES = ["queued", "planning", "running", "validating"] as const;

export function createPostgresKnowledgeBaseIndexMaintenanceRepository(
  sql: DatabaseClient
): KnowledgeBaseIndexMaintenanceRepository {
  return {
    async createOrGet(input) {
      return sql.begin(async (transaction) => {
        const knowledgeBases = await transaction<Array<{
          deleted_at: Date | null;
        }>>`
          SELECT deleted_at
          FROM focowiki.knowledge_bases
          WHERE id = ${input.knowledgeBaseId}
          LIMIT 1
        `;
        const knowledgeBase = knowledgeBases[0];
        if (!knowledgeBase) return { outcome: "not_found" as const };
        if (knowledgeBase.deleted_at) return { outcome: "deleted" as const };

        if (input.idempotencyKey) {
          const idempotent = await transaction<RequestRow[]>`
            SELECT request.*
            FROM focowiki.knowledge_base_index_maintenance_requests request
            WHERE request.knowledge_base_id = ${input.knowledgeBaseId}
              AND request.idempotency_key = ${input.idempotencyKey}
            LIMIT 1
          `;
          if (idempotent[0]) {
            return {
              outcome: isActive(idempotent[0].state) ? "already_active" as const : "accepted" as const,
              request: mapRequest(idempotent[0])
            };
          }
        }

        const inserted = await transaction<RequestRow[]>`
          INSERT INTO focowiki.knowledge_base_index_maintenance_requests (
            id, knowledge_base_id, trigger_kind, state, idempotency_key, actor,
            settings_revision, settings_snapshot_json, max_attempts,
            next_attempt_at, created_at, updated_at
          )
          VALUES (
            ${input.requestId}, ${input.knowledgeBaseId}, ${input.trigger}, 'queued',
            ${input.idempotencyKey}, ${input.actor}, ${input.settingsRevision},
            ${transaction.json(input.settingsSnapshot)},
            ${input.maxAttempts}, ${input.now}, ${input.now}, ${input.now}
          )
          ON CONFLICT DO NOTHING
          RETURNING *
        `;
        if (inserted[0]) {
          return { outcome: "accepted" as const, request: mapRequest(inserted[0]) };
        }

        const active = await transaction<RequestRow[]>`
          SELECT request.*
          FROM focowiki.knowledge_base_index_maintenance_requests request
          WHERE request.knowledge_base_id = ${input.knowledgeBaseId}
            AND request.state = ANY(${ACTIVE_STATES})
          ORDER BY request.created_at DESC, request.id DESC
          LIMIT 1
        `;
        if (!active[0]) {
          throw new Error("Knowledge-base maintenance request conflict could not be resolved");
        }
        return {
          outcome: "already_active" as const,
          request: mapRequest(active[0])
        };
      });
    },

    async discoverAutomaticDue(input) {
      const rows = await sql<Array<{ id: string }>>`
        WITH due AS MATERIALIZED (
          SELECT knowledge_base.id
          FROM focowiki.knowledge_bases knowledge_base
          WHERE knowledge_base.deleted_at IS NULL
            AND knowledge_base.active_generation_id IS NOT NULL
            AND knowledge_base.index_maintenance_last_activity_at <= ${input.dueBefore}
            AND NOT EXISTS (
              SELECT 1
              FROM focowiki.knowledge_base_index_maintenance_requests active
              WHERE active.knowledge_base_id = knowledge_base.id
                AND active.state = ANY(${ACTIVE_STATES})
            )
          ORDER BY knowledge_base.index_maintenance_last_activity_at,
                   knowledge_base.id
          LIMIT ${boundedLimit(input.limit)}
        )
        INSERT INTO focowiki.knowledge_base_index_maintenance_requests (
          id, knowledge_base_id, trigger_kind, state, settings_revision,
          settings_snapshot_json, max_attempts, next_attempt_at, created_at, updated_at
        )
        SELECT ${input.requestIdPrefix} || '-' || md5(due.id || chr(31) || ${input.now}),
               due.id, 'automatic', 'queued', ${input.settingsRevision},
               ${sql.json(input.settingsSnapshot)}, ${input.maxAttempts},
               ${input.now}, ${input.now}, ${input.now}
        FROM due
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      return rows.length;
    },

    async cancelQueuedAutomatic(input) {
      const rows = await sql<Array<{ id: string }>>`
        UPDATE focowiki.knowledge_base_index_maintenance_requests
        SET state = 'canceled', current_stage = 'canceled',
            completed_at = ${input.canceledAt}, updated_at = ${input.canceledAt}
        WHERE trigger_kind = 'automatic'
          AND state = 'queued'
          AND started_at IS NULL
        RETURNING id
      `;
      return rows.length;
    },

    async claimBatch(input) {
      return sql.begin(async (transaction) => {
        const executing = await transaction<Array<{ count: number }>>`
          SELECT count(*)::int AS count
          FROM focowiki.knowledge_base_index_maintenance_requests
          WHERE state IN ('planning', 'running', 'validating')
            AND lease_owner IS DISTINCT FROM ${input.workerId}
            AND lease_expires_at > ${input.now}
        `;
        const available = Math.max(0, boundedLimit(input.limit) - Number(executing[0]?.count ?? 0));
        if (available === 0) return [];

        const rows = await transaction<RequestRow[]>`
          WITH candidate AS MATERIALIZED (
            SELECT request.id
            FROM focowiki.knowledge_base_index_maintenance_requests request
            JOIN focowiki.knowledge_bases knowledge_base
              ON knowledge_base.id = request.knowledge_base_id
             AND knowledge_base.deleted_at IS NULL
            WHERE request.state = ANY(${ACTIVE_STATES})
              AND request.next_attempt_at <= ${input.now}
              AND (
                request.lease_owner = ${input.workerId}
                OR request.lease_expires_at IS NULL
                OR request.lease_expires_at <= ${input.now}
              )
            ORDER BY
              CASE WHEN request.lease_owner = ${input.workerId} THEN 0 ELSE 1 END,
              request.next_attempt_at,
              request.created_at,
              request.id
            LIMIT ${available}
            FOR UPDATE OF request SKIP LOCKED
          )
          UPDATE focowiki.knowledge_base_index_maintenance_requests request
          SET state = CASE WHEN request.state = 'queued' THEN 'planning' ELSE request.state END,
              current_stage = coalesce(request.current_stage, 'planning'),
              lease_owner = ${input.workerId},
              lease_token = ${input.leaseTokenPrefix} || '-' || md5(candidate.id),
              lease_expires_at = ${input.leaseExpiresAt},
              heartbeat_at = ${input.now},
              started_at = coalesce(request.started_at, ${input.now}),
              updated_at = ${input.now}
          FROM candidate
          WHERE request.id = candidate.id
          RETURNING request.*
        `;
        return rows.map(mapClaim);
      });
    },

    async start(input) {
      const rows = await sql<Array<{ id: string }>>`
        UPDATE focowiki.knowledge_base_index_maintenance_requests request
        SET state = 'running', current_stage = 'planning',
            base_generation_id = knowledge_base.active_generation_id,
            source_watermark = knowledge_base.resource_revision,
            planned_scopes = ${boundedScopes(input.plannedScopes)},
            last_progress_at = ${input.startedAt},
            heartbeat_at = ${input.startedAt},
            updated_at = ${input.startedAt}
        FROM focowiki.knowledge_bases knowledge_base
        WHERE request.id = ${input.request.id}
          AND request.knowledge_base_id = knowledge_base.id
          AND knowledge_base.deleted_at IS NULL
          AND request.lease_owner = ${input.request.leaseOwner}
          AND request.lease_token = ${input.request.leaseToken}
          AND request.state IN ('planning', 'running')
        RETURNING request.id
      `;
      return rows.length === 1;
    },

    async heartbeat(input) {
      const rows = await sql<Array<{ id: string }>>`
        UPDATE focowiki.knowledge_base_index_maintenance_requests
        SET current_stage = ${input.stage},
            completed_count = ${Math.max(0, input.completedCount)},
            expected_count = ${Math.max(input.completedCount, input.expectedCount)},
            heartbeat_at = ${input.heartbeatAt},
            lease_expires_at = ${input.leaseExpiresAt},
            last_progress_at = ${input.heartbeatAt},
            updated_at = ${input.heartbeatAt}
        WHERE id = ${input.request.id}
          AND lease_owner = ${input.request.leaseOwner}
          AND lease_token = ${input.request.leaseToken}
          AND state IN ('planning', 'running', 'validating')
        RETURNING id
      `;
      return rows.length === 1;
    },

    async renewLease(input) {
      const rows = await sql<Array<{ id: string }>>`
        UPDATE focowiki.knowledge_base_index_maintenance_requests
        SET heartbeat_at = ${input.heartbeatAt},
            lease_expires_at = ${input.leaseExpiresAt},
            updated_at = ${input.heartbeatAt}
        WHERE id = ${input.request.id}
          AND lease_owner = ${input.request.leaseOwner}
          AND lease_token = ${input.request.leaseToken}
          AND state IN ('planning', 'running', 'validating')
        RETURNING id
      `;
      return rows.length === 1;
    },

    async complete(input) {
      const rows = await sql<Array<{ id: string }>>`
        UPDATE focowiki.knowledge_base_index_maintenance_requests
        SET state = 'completed', current_stage = 'completed',
            completed_scopes = ${boundedScopes(input.completedScopes)},
            completed_count = greatest(completed_count, expected_count),
            lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
            heartbeat_at = ${input.completedAt},
            last_progress_at = ${input.completedAt},
            completed_at = ${input.completedAt}, updated_at = ${input.completedAt}
        WHERE id = ${input.request.id}
          AND lease_owner = ${input.request.leaseOwner}
          AND lease_token = ${input.request.leaseToken}
          AND state IN ('planning', 'running', 'validating')
        RETURNING id
      `;
      return rows.length === 1;
    },

    async retryOrFail(input) {
      const rows = await sql<Array<{ state: "queued" | "failed" }>>`
        UPDATE focowiki.knowledge_base_index_maintenance_requests
        SET retry_count = retry_count + 1,
            state = CASE WHEN retry_count + 1 >= max_attempts THEN 'failed' ELSE 'queued' END,
            current_stage = CASE
              WHEN retry_count + 1 >= max_attempts THEN 'failed'
              ELSE 'retrying'
            END,
            next_attempt_at = ${input.retryAt},
            last_error_code = ${input.errorCode},
            last_error_message = ${input.errorMessage.slice(0, 500)},
            lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
            completed_at = CASE
              WHEN retry_count + 1 >= max_attempts
                THEN ${input.failedAt}::timestamptz
              ELSE NULL::timestamptz
            END,
            updated_at = ${input.failedAt}
        WHERE id = ${input.request.id}
          AND lease_owner = ${input.request.leaseOwner}
          AND lease_token = ${input.request.leaseToken}
          AND state IN ('planning', 'running', 'validating')
        RETURNING state
      `;
      if (!rows[0]) return "lost";
      return rows[0].state === "failed" ? "failed" : "retry";
    },

    async cancelForKnowledgeBase(input) {
      const rows = await sql<Array<{ id: string }>>`
        UPDATE focowiki.knowledge_base_index_maintenance_requests
        SET state = 'canceled', current_stage = 'canceled',
            lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
            completed_at = ${input.canceledAt}, updated_at = ${input.canceledAt}
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND state = ANY(${ACTIVE_STATES})
        RETURNING id
      `;
      return rows.length;
    },

    async getSummary(input) {
      const rows = await sql<SummaryRow[]>`
        SELECT request.*,
               (
                 knowledge_base.active_generation_id IS NOT NULL
                 AND (
                   coalesce(search_state.maintenance_required, true)
                   OR active_generation.search_schema_version IS NULL
                   OR active_generation.tokenizer_contract_version IS NULL
                   OR active_generation.search_segmentation_version IS NULL
                   OR NOT EXISTS (
                     SELECT 1
                     FROM focowiki.knowledge_base_projection_versions version
                     WHERE version.knowledge_base_id = knowledge_base.id
                       AND version.projection_kind = 'tree'
                       AND version.format_version =
                             ${REQUIRED_PROJECTION_REPAIR_VERSIONS.tree}
                       AND version.input_version =
                             ${REQUIRED_PROJECTION_REPAIR_VERSIONS.tree}
                   )
                   OR NOT EXISTS (
                     SELECT 1
                     FROM focowiki.knowledge_base_projection_versions version
                     WHERE version.knowledge_base_id = knowledge_base.id
                       AND version.projection_kind = 'directory'
                       AND version.format_version =
                             ${REQUIRED_PROJECTION_REPAIR_VERSIONS.directory}
                       AND version.input_version =
                             ${REQUIRED_PROJECTION_REPAIR_VERSIONS.directory}
                   )
                   OR NOT EXISTS (
                     SELECT 1
                     FROM focowiki.knowledge_base_projection_versions version
                     WHERE version.knowledge_base_id = knowledge_base.id
                       AND version.projection_kind = 'graph'
                       AND version.format_version =
                             ${REQUIRED_PROJECTION_REPAIR_VERSIONS.graph}
                       AND version.input_version =
                             ${REQUIRED_PROJECTION_REPAIR_VERSIONS.graph}
                   )
                 )
               ) AS maintenance_required,
               (
                 SELECT max(history.completed_at)
                 FROM focowiki.knowledge_base_index_maintenance_requests history
                 WHERE history.knowledge_base_id = knowledge_base.id
                   AND history.state = 'completed'
               ) AS last_completed_at
        FROM focowiki.knowledge_bases knowledge_base
        LEFT JOIN focowiki.publication_generations active_generation
          ON active_generation.id = knowledge_base.active_generation_id
        LEFT JOIN focowiki.knowledge_base_search_states search_state
          ON search_state.knowledge_base_id = knowledge_base.id
        LEFT JOIN LATERAL (
          SELECT latest.*
          FROM focowiki.knowledge_base_index_maintenance_requests latest
          WHERE latest.knowledge_base_id = knowledge_base.id
          ORDER BY
            CASE WHEN latest.state = ANY(${ACTIVE_STATES}) THEN 0 ELSE 1 END,
            latest.created_at DESC,
            latest.id DESC
          LIMIT 1
        ) request ON true
        WHERE knowledge_base.id = ${input.knowledgeBaseId}
          AND knowledge_base.deleted_at IS NULL
        LIMIT 1
      `;
      return mapSummary(rows[0]);
    },

    async listActiveKnowledgeBaseIds(input) {
      const rows = await sql<Array<{ knowledge_base_id: string }>>`
        SELECT knowledge_base_id
        FROM focowiki.knowledge_base_index_maintenance_requests
        WHERE state = ANY(${ACTIVE_STATES})
        ORDER BY created_at, id
        LIMIT ${boundedLimit(input.limit)}
      `;
      return rows.map((row) => row.knowledge_base_id);
    }
  };
}

function mapRequest(row: RequestRow): KnowledgeBaseIndexMaintenanceRequest {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    trigger: row.trigger_kind,
    state: row.state,
    baseGenerationId: row.base_generation_id,
    sourceWatermark: row.source_watermark,
    settingsRevision: Number(row.settings_revision),
    plannedScopes: row.planned_scopes,
    completedScopes: row.completed_scopes,
    stage: row.current_stage,
    completedCount: Number(row.completed_count),
    expectedCount: Number(row.expected_count),
    retryCount: row.retry_count,
    maxAttempts: row.max_attempts,
    lastProgressAt: row.last_progress_at?.toISOString() ?? null,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapClaim(row: RequestRow): KnowledgeBaseIndexMaintenanceClaim {
  if (!row.lease_owner || !row.lease_token) {
    throw new Error("Knowledge-base maintenance claim has no lease");
  }
  return {
    ...mapRequest(row),
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token
  };
}

function mapSummary(row: SummaryRow | undefined): KnowledgeBaseIndexMaintenanceSummary {
  if (!row?.id) {
    return {
      requestId: null,
      state: "idle",
      trigger: null,
      stage: null,
      active: false,
      completedCount: 0,
      expectedCount: 0,
      retryCount: 0,
      lastProgressAt: null,
      lastCompletedAt: row?.last_completed_at?.toISOString() ?? null,
      maintenanceRequired: row?.maintenance_required ?? false,
      safeErrorCode: null,
      safeErrorMessage: null
    };
  }
  return {
    requestId: row.id,
    state: row.state,
    trigger: row.trigger_kind,
    stage: row.current_stage,
    active: isActive(row.state),
    completedCount: Number(row.completed_count),
    expectedCount: Number(row.expected_count),
    retryCount: row.retry_count,
    lastProgressAt: row.last_progress_at?.toISOString() ?? null,
    lastCompletedAt: row.last_completed_at?.toISOString() ?? null,
    maintenanceRequired: row.maintenance_required,
    safeErrorCode: row.last_error_code,
    safeErrorMessage: row.last_error_message
  };
}

function isActive(state: KnowledgeBaseIndexMaintenanceState): boolean {
  return ACTIVE_STATES.includes(state as (typeof ACTIVE_STATES)[number]);
}

function boundedLimit(limit: number): number {
  return Math.max(1, Math.min(Math.trunc(limit), 1_000));
}

function boundedScopes(scopes: string[]): string[] {
  return [...new Set(scopes)].slice(0, 16);
}
