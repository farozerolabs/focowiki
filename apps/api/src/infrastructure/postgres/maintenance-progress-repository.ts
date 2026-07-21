import type {
  MaintenanceCompactionProgress,
  MaintenanceMigrationProgress,
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

export function createPostgresMaintenanceProgressRepository(
  sql: DatabaseClient
): MaintenanceProgressRepository {
  return {
    async getSummary(input) {
      const [migrationRows, activeRows, completedRows] = await Promise.all([
        sql<MigrationRow[]>`
          SELECT state, phase, attempt_count, max_attempts, started_at,
                 updated_at, completed_at, last_error_code, last_error_message
          FROM focowiki.knowledge_base_optimization_migrations
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
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
        compaction: {
          active: mapCompaction(activeRows[0]),
          latestCompleted: mapCompaction(completedRows[0])
        }
      };
    }
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
