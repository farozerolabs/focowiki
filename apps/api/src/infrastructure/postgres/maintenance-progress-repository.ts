import type {
  MaintenanceCompactionProgress,
  MaintenanceLexicalRebuildProgress,
  MaintenanceMigrationProgress,
  MaintenanceProjectionRepairProgress,
  MaintenanceSearchProjectionProgress,
  MaintenanceProgressRepository
} from "../../application/ports/maintenance-progress-repository.js";
import type { DatabaseClient } from "../../db/client.js";

type MigrationRow = {
  state: string;
  phase: string;
  attempt_count: number;
  max_attempts: number;
  started_at: Date | null;
  updated_at: Date;
  completed_at: Date | null;
  last_error_code: string | null;
  last_error_message: string | null;
};

type CompactionRow = {
  state: string;
  attempt_count: number;
  max_attempts: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  last_error_code: string | null;
};

type ProjectionRepairRow = {
  repair_version: number;
  state: string;
  phase: string;
  attempt_count: number;
  required_projection_kinds: string[];
  completed_projection_kinds: string[];
  expected_subtask_count: number;
  completed_subtask_count: number;
  expected_record_count: number;
  completed_record_count: number;
  expected_directory_count: number;
  completed_directory_count: number;
  object_write_count: number;
  object_reuse_count: number;
  retry_count: number;
  recent_records_per_second: number | null;
  rolling_batch_latency_ms: number | null;
  last_progress_at: Date | null;
  last_heartbeat_at: Date | null;
  estimated_completion_at: Date | null;
  updated_at: Date;
  completed_at: Date | null;
  last_error_code: string | null;
  last_error_message: string | null;
};

type LexicalRebuildRow = {
  state: string;
  phase: string;
  target_search_schema_version: string;
  target_tokenizer_contract_version: string;
  target_segmentation_version: string;
  target_content_profile_version: string;
  target_graph_lexical_projection_version: string;
  processed_source_count: number;
  pending_source_count: number;
  running_source_count: number;
  retry_source_count: number;
  failed_source_count: number;
  total_source_count: number;
  active_worker_count: number;
  source_read_retry_count: number;
  database_retry_count: number;
  recent_files_per_second: number | null;
  rolling_source_read_latency_ms: number | null;
  rolling_database_batch_latency_ms: number | null;
  last_progress_at: Date | null;
  last_worker_heartbeat_at: Date | null;
  estimated_completion_at: Date | null;
  attempt_count: number;
  max_attempts: number;
  updated_at: Date;
  completed_at: Date | null;
  last_error_code: string | null;
  last_error_message: string | null;
};

type SearchProjectionRow = {
  route_state: "postgres_compatibility" | "meilisearch";
  maintenance_required: boolean;
  active_epoch: number | string;
  pending_epoch: number | string | null;
  pending_generation_id: string | null;
  queued_count: number | string;
  submitted_count: number | string;
  retry_count: number | string;
  succeeded_count: number | string;
  failed_count: number | string;
  canceled_count: number | string;
  total_count: number | string;
  progress_updated_at: Date;
  safe_error_code: string | null;
  safe_error_message: string | null;
};

export function createPostgresMaintenanceProgressRepository(
  sql: DatabaseClient
): MaintenanceProgressRepository {
  return {
    async getSummary(input) {
      const [
        migrationRows,
        lexicalRows,
        searchRows,
        repairRows,
        activeRows,
        completedRows
      ] = await Promise.all([
        sql<MigrationRow[]>`
          SELECT state, phase, attempt_count, max_attempts, started_at,
                 updated_at, completed_at, last_error_code, last_error_message
          FROM focowiki.knowledge_base_optimization_migrations
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
        `,
        sql<LexicalRebuildRow[]>`
          SELECT state, phase, target_search_schema_version,
                 target_tokenizer_contract_version, target_segmentation_version,
                 target_content_profile_version,
                 target_graph_lexical_projection_version,
                 processed_source_count, pending_source_count,
                 running_source_count, retry_source_count, failed_source_count,
                 total_source_count, source_read_retry_count,
                 database_retry_count, recent_files_per_second,
                 rolling_source_read_latency_ms,
                 rolling_database_batch_latency_ms, last_progress_at,
                 last_worker_heartbeat_at, estimated_completion_at,
                 (
                   SELECT count(*)::int
                   FROM focowiki.role_heartbeats heartbeat
                   WHERE heartbeat.role = 'lexical_rebuild'
                     AND heartbeat.last_seen_at >= now() - interval '2 minutes'
                 ) AS active_worker_count,
                 attempt_count, max_attempts, updated_at, completed_at,
                 last_error_code, last_error_message
          FROM focowiki.knowledge_base_lexical_rebuilds
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
        `,
        sql<SearchProjectionRow[]>`
          SELECT
            state.route_state,
            state.maintenance_required,
            state.active_epoch,
            state.pending_epoch,
            state.pending_generation_id,
            count(work.id) FILTER (WHERE work.state = 'queued') AS queued_count,
            count(work.id) FILTER (WHERE work.state = 'submitted') AS submitted_count,
            count(work.id) FILTER (WHERE work.state = 'retry') AS retry_count,
            count(work.id) FILTER (WHERE work.state = 'succeeded') AS succeeded_count,
            count(work.id) FILTER (WHERE work.state = 'failed') AS failed_count,
            count(work.id) FILTER (WHERE work.state = 'canceled') AS canceled_count,
            count(work.id) AS total_count,
            greatest(
              state.updated_at,
              coalesce(max(work.updated_at), state.updated_at)
            ) AS progress_updated_at,
            max(work.safe_error_code) FILTER (
              WHERE work.state IN ('failed', 'canceled')
            ) AS safe_error_code,
            max(work.safe_error_message) FILTER (
              WHERE work.state IN ('failed', 'canceled')
            ) AS safe_error_message
          FROM focowiki.knowledge_base_search_states state
          LEFT JOIN focowiki.search_projection_work work
            ON work.knowledge_base_id = state.knowledge_base_id
           AND work.epoch = state.pending_epoch
           AND work.work_kind <> 'cleanup'
          WHERE state.knowledge_base_id = ${input.knowledgeBaseId}
          GROUP BY state.knowledge_base_id
        `,
        sql<ProjectionRepairRow[]>`
          SELECT repair_version, state, current_phase AS phase, attempt_count,
                 required_projection_kinds, completed_projection_kinds,
                 expected_subtask_count, completed_subtask_count,
                 expected_record_count, completed_record_count,
                 expected_directory_count, completed_directory_count,
                 object_write_count, object_reuse_count, retry_count,
                 recent_records_per_second, rolling_batch_latency_ms,
                 last_progress_at, last_heartbeat_at, estimated_completion_at,
                 updated_at, completed_at,
                 last_error_code, last_error_message
          FROM focowiki.knowledge_base_projection_repairs
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
          ORDER BY repair_version DESC
          LIMIT 1
        `,
        sql<CompactionRow[]>`
          SELECT state, attempt_count, max_attempts, created_at, updated_at,
                 completed_at, last_error_code
          FROM focowiki.projection_compaction_jobs
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND state IN ('pending', 'running', 'failed')
          ORDER BY updated_at DESC, id
          LIMIT 1
        `,
        sql<CompactionRow[]>`
          SELECT state, attempt_count, max_attempts, created_at, updated_at,
                 completed_at, last_error_code
          FROM focowiki.projection_compaction_jobs
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND state IN ('completed', 'superseded')
          ORDER BY updated_at DESC, id
          LIMIT 1
        `
      ]);

      return {
        migration: mapMigration(migrationRows[0]),
        lexicalRebuild: mapLexicalRebuild(lexicalRows[0]),
        searchProjection: mapSearchProjection(searchRows[0]),
        projectionRepair: mapProjectionRepair(repairRows[0]),
        compaction: {
          active: mapCompaction(activeRows[0]),
          latestCompleted: mapCompaction(completedRows[0])
        }
      };
    }
  };
}

function mapSearchProjection(
  row: SearchProjectionRow | undefined
): MaintenanceSearchProjectionProgress | null {
  if (!row) return null;
  return {
    routeState: row.route_state,
    maintenanceRequired: row.maintenance_required,
    activeEpoch: Number(row.active_epoch),
    pendingEpoch: row.pending_epoch === null ? null : Number(row.pending_epoch),
    generationId: row.pending_generation_id,
    queuedCount: Number(row.queued_count),
    submittedCount: Number(row.submitted_count),
    retryCount: Number(row.retry_count),
    succeededCount: Number(row.succeeded_count),
    failedCount: Number(row.failed_count),
    canceledCount: Number(row.canceled_count),
    totalCount: Number(row.total_count),
    updatedAt: row.progress_updated_at.toISOString(),
    safeErrorCode: row.safe_error_code,
    safeErrorMessage: row.safe_error_message
  };
}

function mapLexicalRebuild(
  row: LexicalRebuildRow | undefined
): MaintenanceLexicalRebuildProgress | null {
  if (!row) return null;
  return {
    state: row.state,
    phase: row.phase,
    searchSchemaVersion: row.target_search_schema_version,
    tokenizerContractVersion: row.target_tokenizer_contract_version,
    segmentationVersion: row.target_segmentation_version,
    contentProfileVersion: row.target_content_profile_version,
    graphLexicalProjectionVersion: row.target_graph_lexical_projection_version,
    processedSourceCount: Number(row.processed_source_count),
    pendingSourceCount: Number(row.pending_source_count),
    runningSourceCount: Number(row.running_source_count),
    retrySourceCount: Number(row.retry_source_count),
    failedSourceCount: Number(row.failed_source_count),
    totalSourceCount: Number(row.total_source_count),
    activeWorkerCount: Number(row.active_worker_count),
    sourceReadRetryCount: Number(row.source_read_retry_count),
    databaseRetryCount: Number(row.database_retry_count),
    filesPerSecond: nullableNumber(row.recent_files_per_second),
    sourceReadLatencyMs: nullableNumber(row.rolling_source_read_latency_ms),
    databaseBatchLatencyMs: nullableNumber(row.rolling_database_batch_latency_ms),
    lastProgressAt: row.last_progress_at?.toISOString() ?? null,
    lastWorkerHeartbeatAt: row.last_worker_heartbeat_at?.toISOString() ?? null,
    estimatedCompletionAt: row.estimated_completion_at?.toISOString() ?? null,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    safeErrorCode: row.last_error_code,
    safeErrorMessage: row.last_error_message
  };
}

function mapProjectionRepair(
  row: ProjectionRepairRow | undefined
): MaintenanceProjectionRepairProgress | null {
  if (!row) return null;
  return {
    repairVersion: row.repair_version,
    state: row.state,
    phase: row.phase,
    attemptCount: row.attempt_count,
    requiredProjectionKinds: row.required_projection_kinds,
    completedProjectionKinds: row.completed_projection_kinds,
    completedSubtaskCount: Number(row.completed_subtask_count),
    totalSubtaskCount: Number(row.expected_subtask_count),
    completedRecordCount: Number(row.completed_record_count),
    totalRecordCount: Number(row.expected_record_count),
    completedDirectoryCount: Number(row.completed_directory_count),
    totalDirectoryCount: Number(row.expected_directory_count),
    objectWriteCount: Number(row.object_write_count),
    objectReuseCount: Number(row.object_reuse_count),
    retryCount: Number(row.retry_count),
    recordsPerSecond: nullableNumber(row.recent_records_per_second),
    rollingBatchLatencyMs: nullableNumber(row.rolling_batch_latency_ms),
    lastProgressAt: row.last_progress_at?.toISOString() ?? null,
    lastHeartbeatAt: row.last_heartbeat_at?.toISOString() ?? null,
    estimatedCompletionAt: row.estimated_completion_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    safeErrorCode: row.last_error_code,
    safeErrorMessage: row.last_error_message
  };
}

function nullableNumber(value: number | null): number | null {
  return value === null ? null : Number(value);
}

function mapMigration(row: MigrationRow | undefined): MaintenanceMigrationProgress | null {
  if (!row) return null;
  return {
    state: row.state,
    phase: row.phase,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    startedAt: row.started_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    safeErrorCode: row.last_error_code,
    safeErrorMessage: row.last_error_message
  };
}

function mapCompaction(row: CompactionRow | undefined): MaintenanceCompactionProgress | null {
  if (!row) return null;
  return {
    state: row.state,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    queuedAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    safeErrorCode: row.last_error_code
  };
}
