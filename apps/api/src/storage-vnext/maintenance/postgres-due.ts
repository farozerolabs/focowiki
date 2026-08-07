import type { DatabaseClient } from "../../db/client.js";
import type { StorageVnextAutomaticMaintenanceDuePort } from
  "./automatic-scheduler.js";

type DueRow = {
  public_id: string;
  revision: number | string;
};

export function createPostgresStorageVnextAutomaticMaintenanceDue(
  sql: DatabaseClient
): StorageVnextAutomaticMaintenanceDuePort {
  return {
    async list(input) {
      assertTimestamp(input.dueBefore);
      const limit = assertLimit(input.limit);
      const rows = await sql<DueRow[]>`
        WITH due AS MATERIALIZED (
          SELECT knowledge_base.public_id, knowledge_base.revision,
                 greatest(
                   knowledge_base.updated_at,
                   snapshot.publicly_visible_at
                 ) AS last_activity_at
          FROM focowiki.knowledge_bases knowledge_base
          JOIN focowiki.active_snapshots snapshot
            ON snapshot.knowledge_base_id = knowledge_base.public_id
          JOIN focowiki.release_roots root
            ON root.knowledge_base_id = snapshot.knowledge_base_id
           AND root.public_id = snapshot.release_root_public_id
          WHERE knowledge_base.deleted_at IS NULL
            AND (
              root.navigation_profile_version < 1
              OR greatest(
                knowledge_base.updated_at,
                snapshot.publicly_visible_at
              ) <= ${input.dueBefore}
            )
            AND NOT EXISTS (
              SELECT 1
              FROM focowiki.operation_work_items work
              WHERE work.knowledge_base_id = knowledge_base.public_id
                AND work.state IN ('queued', 'running', 'retry')
            )
          ORDER BY last_activity_at, knowledge_base.public_id COLLATE "C"
          LIMIT ${limit}
        )
        SELECT public_id, revision
        FROM due
        ORDER BY last_activity_at, public_id COLLATE "C"
      `;
      return rows.map((row) => ({
        knowledgeBaseId: row.public_id,
        revision: safeRevision(row.revision)
      }));
    },

    async cancelQueuedAutomatic(input) {
      assertTimestamp(input.canceledAt);
      assertTimestamp(input.expiresAt);
      const limit = assertLimit(input.limit);
      return sql.begin(async (transaction) => {
        const canceled = await transaction<Array<{
          operation_public_id: string;
          knowledge_base_id: string;
        }>>`
          WITH candidates AS MATERIALIZED (
            SELECT work.operation_public_id
            FROM focowiki.operation_work_items work
            WHERE work.work_kind = 'maintenance'
              AND work.state IN ('queued', 'retry')
              AND work.checkpoint ->> 'trigger' = 'automatic'
            ORDER BY work.updated_at, work.operation_public_id
            FOR UPDATE OF work SKIP LOCKED
            LIMIT ${limit}
          )
          DELETE FROM focowiki.operation_work_items work
          USING candidates
          WHERE work.operation_public_id = candidates.operation_public_id
          RETURNING work.operation_public_id, work.knowledge_base_id
        `;
        if (canceled.length === 0) return 0;
        const operationPublicIds = canceled.map((item) => item.operation_public_id);
        await transaction`
          UPDATE focowiki.operations operation
          SET state = 'superseded', completed_at = ${input.canceledAt},
              updated_at = ${input.canceledAt}
          WHERE operation.public_id = ANY(${operationPublicIds}::text[])
            AND operation.operation_kind = 'maintenance'
        `;
        await transaction`
          INSERT INTO focowiki.operation_results (
            public_id, knowledge_base_id, operation_kind, terminal_state,
            result_code, safe_message, result_summary,
            completed_at, expires_at
          )
          SELECT operation.public_id, operation.knowledge_base_id,
                 operation.operation_kind, 'superseded',
                 'MAINTENANCE_AUTOMATIC_DISABLED', NULL,
                 ${transaction.json({ trigger: "automatic" })},
                 ${input.canceledAt}, ${input.expiresAt}
          FROM focowiki.operations operation
          WHERE operation.public_id = ANY(${operationPublicIds}::text[])
          ON CONFLICT (public_id) DO NOTHING
        `;
        return canceled.length;
      });
    }
  };
}

function assertTimestamp(value: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw dueError("invalid_timestamp");
  }
}

function assertLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw dueError("invalid_limit");
  }
  return value;
}

function safeRevision(value: number | string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw dueError("invalid_revision");
  }
  return revision;
}

function dueError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext automatic maintenance due error: ${code}`),
    { code }
  );
}
