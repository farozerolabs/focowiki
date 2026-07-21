import type {
  PublicationSubtask,
  PublicationSubtaskRepository
} from "../../application/ports/publication-subtask-repository.js";
import type { SerializableJson } from "../../application/ports/source-dispatch-repository.js";
import type { DatabaseClient } from "../../db/client.js";
import type { TransactionSql } from "postgres";

type SubtaskRow = {
  id: string;
  knowledge_base_id: string;
  generation_id: string;
  task_kind: PublicationSubtask["taskKind"];
  projection_kind: string;
  physical_partition: string;
  settings_snapshot_json: SerializableJson;
  attempt_count: number;
  max_attempts: number;
  processed_count: number | string;
  total_count: number | string;
  lease_owner: string | null;
  lease_token: string | null;
};

export function createPostgresPublicationSubtaskRepository(
  sql: DatabaseClient
): PublicationSubtaskRepository {
  return {
    async ensureGenerationTasks(input) {
      assertPositiveInteger(input.maxAttempts, "maxAttempts");
      return sql.begin(async (transaction) => {
        await transaction`
          INSERT INTO focowiki.publication_subtasks (
            id, knowledge_base_id, generation_id, task_kind,
            projection_kind, physical_partition, settings_snapshot_json,
            state, max_attempts, processed_count, total_count,
            completed_at, created_at, updated_at
          ) VALUES (
            ${workflowTaskId(input.generationId, "coordinator")},
            ${input.knowledgeBaseId}, ${input.generationId}, 'coordinator',
            '', 'workflow', ${transaction.json(input.settingsSnapshot)},
            'completed', ${input.maxAttempts}, 1, 1,
            ${input.createdAt}, ${input.createdAt}, ${input.createdAt}
          )
          ON CONFLICT (generation_id, task_kind, projection_kind, physical_partition)
          DO NOTHING
        `;
        await transaction`
          WITH partitioned AS MATERIALIZED (
            SELECT impact.projection_kind,
                   impact.physical_partition,
                   count(*)::bigint AS total_count
            FROM focowiki.publication_impacts impact
            WHERE impact.knowledge_base_id = ${input.knowledgeBaseId}
              AND impact.generation_id = ${input.generationId}
              AND impact.status <> 'cancelled'
            GROUP BY impact.projection_kind, physical_partition
          )
          INSERT INTO focowiki.publication_subtasks (
            id, knowledge_base_id, generation_id, task_kind,
            projection_kind, physical_partition, settings_snapshot_json,
            max_attempts, total_count, created_at, updated_at
          )
          SELECT 'publication-subtask-' || md5(
                   ${input.generationId} || chr(31) || partitioned.projection_kind
                   || chr(31) || partitioned.physical_partition
                 ),
                 ${input.knowledgeBaseId}, ${input.generationId},
                 CASE WHEN partitioned.projection_kind = 'directory'
                   THEN 'directory' ELSE 'projection_partition' END,
                 partitioned.projection_kind,
                 partitioned.physical_partition,
                 ${transaction.json(input.settingsSnapshot)},
                 ${input.maxAttempts}, partitioned.total_count,
                 ${input.createdAt}, ${input.createdAt}
          FROM partitioned
          ON CONFLICT (generation_id, task_kind, projection_kind, physical_partition)
          DO UPDATE SET
            total_count = EXCLUDED.total_count,
            settings_snapshot_json = EXCLUDED.settings_snapshot_json,
            max_attempts = EXCLUDED.max_attempts,
            updated_at = EXCLUDED.updated_at
          WHERE focowiki.publication_subtasks.state IN ('pending', 'retry')
        `;
        await transaction`
          INSERT INTO focowiki.publication_subtasks (
            id, knowledge_base_id, generation_id, task_kind,
            projection_kind, physical_partition, settings_snapshot_json,
            max_attempts, total_count, created_at, updated_at
          )
          SELECT phase.id, ${input.knowledgeBaseId}, ${input.generationId}, phase.task_kind,
                 '', 'workflow', ${transaction.json(input.settingsSnapshot)},
                 ${input.maxAttempts}::integer, 1, ${input.createdAt}, ${input.createdAt}
          FROM (VALUES
            (${workflowTaskId(input.generationId, "object")}::text, 'object'::text),
            (${workflowTaskId(input.generationId, "validation")}::text, 'validation'::text),
            (${workflowTaskId(input.generationId, "activation")}::text, 'activation'::text)
          ) phase(id, task_kind)
          ON CONFLICT (generation_id, task_kind, projection_kind, physical_partition)
          DO UPDATE SET
            settings_snapshot_json = EXCLUDED.settings_snapshot_json,
            max_attempts = EXCLUDED.max_attempts,
            updated_at = EXCLUDED.updated_at
          WHERE focowiki.publication_subtasks.state IN ('pending', 'retry')
        `;
        const rows = await transaction<Array<{ task_count: number | string }>>`
          SELECT count(*)::bigint AS task_count
          FROM focowiki.publication_subtasks
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND generation_id = ${input.generationId}
            AND state NOT IN ('completed', 'cancelled')
        `;
        const taskCount = Number(rows[0]?.task_count ?? 0);
        await transaction`
          UPDATE focowiki.publication_progress
          SET remaining_subtask_count = ${taskCount},
              running_subtask_count = 0,
              failed_subtask_count = 0,
              updated_at = ${input.createdAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND generation_id = ${input.generationId}
            AND remaining_subtask_count = 0
        `;
        return { taskCount };
      });
    },

    async claim(input) {
      assertPositiveInteger(input.limit, "limit");
      return sql.begin(async (transaction) => {
        await transaction`
          WITH stale AS MATERIALIZED (
            SELECT id
            FROM focowiki.publication_subtasks
            WHERE state = 'running'
              AND lease_expires_at < ${input.now}
            ORDER BY lease_expires_at, id
            LIMIT ${input.limit}
            FOR UPDATE SKIP LOCKED
          ), released AS (
            UPDATE focowiki.publication_subtasks task
            SET state = 'retry', lease_owner = NULL, lease_token = NULL,
                lease_expires_at = NULL, updated_at = ${input.now}
            FROM stale
            WHERE task.id = stale.id
            RETURNING task.generation_id
          )
          UPDATE focowiki.publication_progress progress
          SET running_subtask_count = greatest(
                0,
                progress.running_subtask_count - released_counts.released_count
              ),
              updated_at = ${input.now}
          FROM (
            SELECT generation_id, count(*)::bigint AS released_count
            FROM released
            GROUP BY generation_id
          ) released_counts
          WHERE progress.generation_id = released_counts.generation_id
        `;
        const rows = await transaction<SubtaskRow[]>`
          WITH ranked AS MATERIALIZED (
            SELECT task.id,
                   row_number() OVER (
                     PARTITION BY task.knowledge_base_id, task.generation_id,
                                  task.projection_kind, task.physical_partition
                     ORDER BY task.run_after, task.created_at, task.id
                   ) AS owner_rank
            FROM focowiki.publication_subtasks task
            JOIN focowiki.publication_generations generation
              ON generation.id = task.generation_id
             AND generation.knowledge_base_id = task.knowledge_base_id
            WHERE task.state IN ('pending', 'retry')
              AND task.run_after <= ${input.now}
              AND (
                generation.state IN ('building', 'validating')
                OR (task.task_kind = 'activation' AND generation.state = 'active')
              )
              AND (
                (
                  task.task_kind IN ('projection_partition', 'directory')
                  AND EXISTS (
                    SELECT 1 FROM focowiki.publication_subtasks coordinator
                    WHERE coordinator.generation_id = task.generation_id
                      AND coordinator.task_kind = 'coordinator'
                      AND coordinator.state = 'completed'
                  )
                )
                OR (
                  task.task_kind = 'object'
                  AND NOT EXISTS (
                    SELECT 1 FROM focowiki.publication_subtasks dependency
                    WHERE dependency.generation_id = task.generation_id
                      AND dependency.task_kind IN ('projection_partition', 'directory')
                      AND dependency.state NOT IN ('completed', 'cancelled')
                  )
                )
                OR (
                  task.task_kind = 'validation'
                  AND EXISTS (
                    SELECT 1 FROM focowiki.publication_subtasks dependency
                    WHERE dependency.generation_id = task.generation_id
                      AND dependency.task_kind = 'object'
                      AND dependency.state = 'completed'
                  )
                )
                OR (
                  task.task_kind = 'activation'
                  AND EXISTS (
                    SELECT 1 FROM focowiki.publication_subtasks dependency
                    WHERE dependency.generation_id = task.generation_id
                      AND dependency.task_kind = 'validation'
                      AND dependency.state = 'completed'
                  )
                )
              )
          ), candidates AS MATERIALIZED (
            SELECT task.id
            FROM focowiki.publication_subtasks task
            JOIN ranked ON ranked.id = task.id AND ranked.owner_rank = 1
            ORDER BY CASE task.task_kind
                       WHEN 'projection_partition' THEN 0
                       WHEN 'directory' THEN 0
                       WHEN 'object' THEN 1
                       WHEN 'validation' THEN 2
                       WHEN 'activation' THEN 3
                       ELSE 4
                     END,
                     task.run_after, task.created_at, task.id
            LIMIT ${input.limit}
            FOR UPDATE OF task SKIP LOCKED
          ), claimed AS (
            UPDATE focowiki.publication_subtasks task
            SET state = 'running', lease_owner = ${input.workerId},
                lease_token = md5(${input.workerId} || chr(31) || task.id || chr(31) || ${input.now}),
                lease_expires_at = ${input.now}::timestamptz
                  + greatest(1, extract(epoch FROM (${input.now}::timestamptz - ${input.staleBefore}::timestamptz))) * interval '1 second',
                attempt_count = task.attempt_count + 1,
                last_error_code = NULL, last_error_message = NULL,
                updated_at = ${input.now}
            FROM candidates
            WHERE task.id = candidates.id
            RETURNING task.*
          ), progress AS (
            UPDATE focowiki.publication_progress publication_progress
            SET running_subtask_count = publication_progress.running_subtask_count
                  + claimed_counts.claimed_count,
                heartbeat_at = ${input.now}, updated_at = ${input.now}
            FROM (
              SELECT generation_id, count(*)::bigint AS claimed_count
              FROM claimed GROUP BY generation_id
            ) claimed_counts
            WHERE publication_progress.generation_id = claimed_counts.generation_id
          )
          SELECT * FROM claimed
          ORDER BY created_at, id
        `;
        return rows.map(mapSubtask);
      });
    },

    async heartbeat(input) {
      if (input.taskIds.length === 0) return 0;
      const leaseTokens = input.taskIds.map((taskId) => input.leaseTokenByTaskId[taskId] ?? "");
      const rows = await sql<Array<{ id: string }>>`
        WITH owned AS MATERIALIZED (
          SELECT task_id, lease_token
          FROM unnest(${input.taskIds}::text[], ${leaseTokens}::text[])
            AS item(task_id, lease_token)
        )
        UPDATE focowiki.publication_subtasks task
        SET lease_expires_at = ${input.leaseExpiresAt}, updated_at = ${input.heartbeatAt}
        FROM owned
        WHERE task.id = owned.task_id
          AND task.state = 'running'
          AND task.lease_owner = ${input.workerId}
          AND task.lease_token = owned.lease_token
        RETURNING task.id
      `;
      return rows.length;
    },

    async complete(input) {
      return finishTask(sql, {
        ...input,
        state: "completed",
        code: null,
        message: null,
        preserveAttempt: false,
        runAfter: input.completedAt
      });
    },

    async reschedule(input) {
      return finishTask(sql, {
        ...input,
        state: "retry",
        code: null,
        message: null,
        completedAt: input.rescheduledAt
      });
    },

    async fail(input) {
      return sql.begin(async (transaction) => {
        const rows = await transaction<Array<{ attempt_count: number; max_attempts: number }>>`
          SELECT attempt_count, max_attempts
          FROM focowiki.publication_subtasks
          WHERE id = ${input.taskId}
            AND state = 'running'
            AND lease_owner = ${input.workerId}
          FOR UPDATE
        `;
        const row = rows[0];
        if (!row) throw new Error("Publication subtask claim is no longer owned");
        const terminal = input.terminal || row.attempt_count >= row.max_attempts;
        await finishTask(transaction, {
          ...input,
          state: terminal ? "failed" : "retry",
          code: input.code,
          message: input.message,
          preserveAttempt: false,
          runAfter: input.failedAt,
          completedAt: input.failedAt
        });
        return { terminal };
      });
    },

    async getGenerationStatus(input) {
      const rows = await sql<Array<{
        remaining: number | string;
        running: number | string;
        failed: number | string;
      }>>`
        SELECT remaining_subtask_count AS remaining,
               running_subtask_count AS running,
               failed_subtask_count AS failed
        FROM focowiki.publication_progress
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND generation_id = ${input.generationId}
        LIMIT 1
      `;
      const remaining = Number(rows[0]?.remaining ?? 0);
      const running = Number(rows[0]?.running ?? 0);
      const failed = Number(rows[0]?.failed ?? 0);
      return {
        pending: Math.max(0, remaining - running - failed),
        running,
        failed,
        remaining
      };
    }
  };
}

async function finishTask(
  sql: DatabaseClient | TransactionSql,
  input: {
    taskId: string;
    workerId: string;
    processedCount: number;
    state: "completed" | "retry" | "failed";
    code: string | null;
    message: string | null;
    preserveAttempt: boolean;
    runAfter: string;
    completedAt: string;
  }
): Promise<boolean> {
  assertNonNegativeInteger(input.processedCount, "processedCount");
  const rows = await sql<Array<{ id: string }>>`
    WITH updated AS MATERIALIZED (
      UPDATE focowiki.publication_subtasks task
      SET state = ${input.state}, processed_count = least(
            task.total_count,
            greatest(task.processed_count, ${input.processedCount})
          ),
          run_after = ${input.runAfter},
          attempt_count = CASE WHEN ${input.preserveAttempt}
            THEN greatest(0, task.attempt_count - 1)
            ELSE task.attempt_count END,
          lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
          last_error_code = ${input.code},
          last_error_message = ${input.message?.slice(0, 1_000) ?? null},
          completed_at = CASE WHEN ${input.state} = 'completed'
            THEN ${input.completedAt}::timestamptz ELSE NULL END,
          updated_at = ${input.completedAt}
      WHERE task.id = ${input.taskId}
        AND task.state = 'running'
        AND task.lease_owner = ${input.workerId}
      RETURNING task.id, task.generation_id
    ), progress AS (
      UPDATE focowiki.publication_progress publication_progress
      SET running_subtask_count = greatest(0, publication_progress.running_subtask_count - 1),
          remaining_subtask_count = CASE WHEN ${input.state} = 'completed'
            THEN greatest(0, publication_progress.remaining_subtask_count - 1)
            ELSE publication_progress.remaining_subtask_count END,
          failed_subtask_count = CASE WHEN ${input.state} = 'failed'
            THEN publication_progress.failed_subtask_count + 1
            ELSE publication_progress.failed_subtask_count END,
          heartbeat_at = ${input.completedAt}, updated_at = ${input.completedAt}
      FROM updated
      WHERE publication_progress.generation_id = updated.generation_id
    )
    SELECT id FROM updated
  `;
  return rows.length === 1;
}

function mapSubtask(row: SubtaskRow): PublicationSubtask {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    generationId: row.generation_id,
    taskKind: row.task_kind,
    projectionKind: row.projection_kind,
    physicalPartition: row.physical_partition,
    settingsSnapshot: row.settings_snapshot_json,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    processedCount: Number(row.processed_count),
    totalCount: Number(row.total_count),
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token
  };
}

function workflowTaskId(
  generationId: string,
  taskKind: Extract<PublicationSubtask["taskKind"], "coordinator" | "object" | "validation" | "activation">
): string {
  return `publication-subtask-${generationId}-${taskKind}`;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}
