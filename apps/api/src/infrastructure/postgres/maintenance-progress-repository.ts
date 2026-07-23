import type {
  MaintenanceCompactionProgress,
  MaintenanceMigrationProgress,
  MaintenanceProjectionRepairProgress,
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
  updated_at: Date;
  completed_at: Date | null;
  last_error_code: string | null;
  last_error_message: string | null;
};

export function createPostgresMaintenanceProgressRepository(
  sql: DatabaseClient
): MaintenanceProgressRepository {
  return {
    async getSummary(input) {
      const [migrationRows, repairRows, activeRows, completedRows] = await Promise.all([
        sql<MigrationRow[]>`
          SELECT state, phase, attempt_count, max_attempts, started_at,
                 updated_at, completed_at, last_error_code, last_error_message
          FROM focowiki.knowledge_base_optimization_migrations
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
        `,
        sql<ProjectionRepairRow[]>`
          SELECT repair_version, state,
                 CASE
                   WHEN state IN ('completed', 'superseded') THEN state
                   WHEN NOT checkpoint_json @> '{"treeComplete": true}'::jsonb THEN 'tree'
                   WHEN NOT checkpoint_json @> '{"navigationComplete": true}'::jsonb THEN 'navigation'
                   WHEN NOT checkpoint_json @> '{"graphComplete": true}'::jsonb THEN 'graph'
                   ELSE 'finalizing'
                 END AS phase,
                 attempt_count, updated_at, completed_at,
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
        projectionRepair: mapProjectionRepair(repairRows[0]),
        compaction: {
          active: mapCompaction(activeRows[0]),
          latestCompleted: mapCompaction(completedRows[0])
        }
      };
    }
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
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    safeErrorCode: row.last_error_code,
    safeErrorMessage: row.last_error_message
  };
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
