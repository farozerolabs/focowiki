import type {
  ProjectionRepairWorkItem,
  ProjectionRepairWorkRepository
} from "../../application/ports/projection-repair-work-repository.js";
import {
  readProjectionRepairSettingsSnapshot
} from "../../application/ports/projection-repair-work-repository.js";
import type { SerializableJson } from "../../application/ports/source-dispatch-repository.js";
import type { DatabaseClient } from "../../db/client.js";
import {
  REQUIRED_PROJECTION_REPAIR_VERSIONS
} from "../../maintenance/projection-repair-plan.js";
import type { TransactionSql } from "postgres";

type TaskRow = {
  id: string;
  knowledge_base_id: string;
  repair_version: number;
  target_generation_id: string;
  base_generation_id: string;
  task_kind: ProjectionRepairWorkItem["kind"];
  partition_key: string;
  phase_order: number;
  source_watermark: number;
  settings_revision: number;
  settings_snapshot_json: SerializableJson;
  expected_record_count: number;
  processed_record_count: number;
  attempt_count: number;
  max_attempts: number;
  lease_owner: string;
  lease_token: string;
  checkpoint_json: SerializableJson;
};

export function createPostgresProjectionRepairWorkRepository(
  sql: DatabaseClient
): ProjectionRepairWorkRepository {
  return {
    async bootstrap(input) {
      return sql.begin(async (transaction) => {
        const older = await transaction<Array<{ target_generation_id: string | null }>>`
          UPDATE focowiki.knowledge_base_projection_repairs
          SET state = 'superseded', current_phase = 'superseded',
              lease_token = NULL, lease_expires_at = NULL,
              updated_at = ${input.now}
          WHERE repair_version < ${input.repairVersion}
            AND state IN ('pending', 'running', 'retry')
          RETURNING target_generation_id
        `;
        const olderTargets = older.flatMap((row) =>
          row.target_generation_id ? [row.target_generation_id] : []
        );
        if (olderTargets.length > 0) {
          await transaction`
            UPDATE focowiki.publication_generations
            SET state = 'superseded', updated_at = ${input.now}
            WHERE id = ANY(${olderTargets})
              AND state IN ('open', 'frozen', 'building', 'validating')
          `;
        }
        const rows = await transaction<Array<{ knowledge_base_id: string }>>`
          INSERT INTO focowiki.knowledge_base_projection_repairs (
            knowledge_base_id, repair_version, planner_version,
            base_generation_id, base_resource_revision,
            source_watermark, activation_watermark,
            state, current_phase, settings_revision, settings_snapshot_json,
            next_attempt_at, started_at, last_progress_at, created_at, updated_at
          )
          SELECT knowledge_base.id, ${input.repairVersion}, ${input.plannerVersion},
                 knowledge_base.active_generation_id, knowledge_base.resource_revision,
                 knowledge_base.resource_revision, knowledge_base.resource_revision,
                 'pending', 'planning', ${input.settingsRevision},
                 ${transaction.json(input.settings)}, ${input.now}, ${input.now},
                 ${input.now}, ${input.now}, ${input.now}
          FROM focowiki.knowledge_bases knowledge_base
          JOIN focowiki.publication_generations active_generation
            ON active_generation.id = knowledge_base.active_generation_id
           AND active_generation.knowledge_base_id = knowledge_base.id
           AND active_generation.state = 'active'
          WHERE knowledge_base.deleted_at IS NULL
            AND (
              NOT EXISTS (
                SELECT 1
                FROM focowiki.knowledge_base_projection_versions version
                WHERE version.knowledge_base_id = knowledge_base.id
                  AND version.projection_kind = 'tree'
                  AND version.format_version = ${REQUIRED_PROJECTION_REPAIR_VERSIONS.tree}
                  AND version.input_version = ${REQUIRED_PROJECTION_REPAIR_VERSIONS.tree}
              )
              OR NOT EXISTS (
                SELECT 1
                FROM focowiki.knowledge_base_projection_versions version
                WHERE version.knowledge_base_id = knowledge_base.id
                  AND version.projection_kind = 'directory'
                  AND version.format_version = ${REQUIRED_PROJECTION_REPAIR_VERSIONS.directory}
                  AND version.input_version = ${REQUIRED_PROJECTION_REPAIR_VERSIONS.directory}
              )
              OR NOT EXISTS (
                SELECT 1
                FROM focowiki.knowledge_base_projection_versions version
                WHERE version.knowledge_base_id = knowledge_base.id
                  AND version.projection_kind = 'graph'
                  AND version.format_version = ${REQUIRED_PROJECTION_REPAIR_VERSIONS.graph}
                  AND version.input_version = ${REQUIRED_PROJECTION_REPAIR_VERSIONS.graph}
              )
            )
          ON CONFLICT (knowledge_base_id, repair_version) DO NOTHING
          RETURNING knowledge_base_id
        `;
        return rows.length;
      });
    },

    async planNext(input) {
      return sql.begin(async (transaction) => {
        const candidates = await transaction<Array<{
          knowledge_base_id: string;
          base_generation_id: string;
          resource_revision: number;
          tree_stale: boolean;
          directory_stale: boolean;
          graph_stale: boolean;
        }>>`
          SELECT repair.knowledge_base_id,
                 knowledge_base.active_generation_id AS base_generation_id,
                 knowledge_base.resource_revision,
                 NOT EXISTS (
                   SELECT 1 FROM focowiki.knowledge_base_projection_versions version
                   WHERE version.knowledge_base_id = repair.knowledge_base_id
                     AND version.projection_kind = 'tree'
                     AND version.format_version = ${REQUIRED_PROJECTION_REPAIR_VERSIONS.tree}
                     AND version.input_version = ${REQUIRED_PROJECTION_REPAIR_VERSIONS.tree}
                 ) AS tree_stale,
                 NOT EXISTS (
                   SELECT 1 FROM focowiki.knowledge_base_projection_versions version
                   WHERE version.knowledge_base_id = repair.knowledge_base_id
                     AND version.projection_kind = 'directory'
                     AND version.format_version = ${REQUIRED_PROJECTION_REPAIR_VERSIONS.directory}
                     AND version.input_version = ${REQUIRED_PROJECTION_REPAIR_VERSIONS.directory}
                 ) AS directory_stale,
                 NOT EXISTS (
                   SELECT 1 FROM focowiki.knowledge_base_projection_versions version
                   WHERE version.knowledge_base_id = repair.knowledge_base_id
                     AND version.projection_kind = 'graph'
                     AND version.format_version = ${REQUIRED_PROJECTION_REPAIR_VERSIONS.graph}
                     AND version.input_version = ${REQUIRED_PROJECTION_REPAIR_VERSIONS.graph}
                 ) AS graph_stale
          FROM focowiki.knowledge_base_projection_repairs repair
          JOIN focowiki.knowledge_bases knowledge_base
            ON knowledge_base.id = repair.knowledge_base_id
           AND knowledge_base.deleted_at IS NULL
           AND knowledge_base.active_generation_id IS NOT NULL
          WHERE repair.repair_version = ${input.repairVersion}
            AND repair.state = 'pending'
            AND repair.target_generation_id IS NULL
            AND repair.next_attempt_at <= ${input.now}
          ORDER BY repair.next_attempt_at, repair.knowledge_base_id
          LIMIT 1
          FOR UPDATE OF repair SKIP LOCKED
        `;
        const candidate = candidates[0];
        if (!candidate) return null;
        if (!candidate.tree_stale && !candidate.directory_stale && !candidate.graph_stale) {
          await transaction`
            UPDATE focowiki.knowledge_base_projection_repairs
            SET state = 'completed', current_phase = 'completed',
                completed_at = ${input.now}, last_progress_at = ${input.now},
                updated_at = ${input.now}
            WHERE knowledge_base_id = ${candidate.knowledge_base_id}
              AND repair_version = ${input.repairVersion}
          `;
          return { knowledgeBaseId: candidate.knowledge_base_id, taskCount: 0 };
        }

        await transaction`
          INSERT INTO focowiki.publication_generations (
            id, knowledge_base_id, predecessor_generation_id, state,
            format_version, generation_kind, frozen_at, created_at, updated_at
          ) VALUES (
            ${input.targetGenerationId}, ${candidate.knowledge_base_id},
            ${candidate.base_generation_id}, 'building', 2,
            'projection_repair', ${input.now}, ${input.now}, ${input.now}
          )
        `;
        await transaction`
          INSERT INTO focowiki.generation_graph_summaries (
            knowledge_base_id, generation_id, node_count, edge_count,
            graph_index_available, updated_at
          )
          SELECT summary.knowledge_base_id, ${input.targetGenerationId},
                 summary.node_count, summary.edge_count,
                 summary.graph_index_available, ${input.now}
          FROM focowiki.generation_graph_summaries summary
          WHERE summary.knowledge_base_id = ${candidate.knowledge_base_id}
            AND summary.generation_id = ${candidate.base_generation_id}
          ON CONFLICT (generation_id) DO UPDATE
          SET node_count = EXCLUDED.node_count,
              edge_count = EXCLUDED.edge_count,
              graph_index_available = EXCLUDED.graph_index_available,
              updated_at = EXCLUDED.updated_at
        `;
        const requiredProjectionKinds = [
          ...(candidate.tree_stale ? ["tree"] : []),
          ...(candidate.directory_stale ? ["directory"] : []),
          ...(candidate.graph_stale ? ["graph"] : [])
        ];
        const initialPhase = requiredProjectionKinds[0] ?? "finalizing";
        await transaction`
          UPDATE focowiki.knowledge_base_projection_repairs
          SET planner_version = ${input.plannerVersion},
              base_generation_id = ${candidate.base_generation_id},
              target_generation_id = ${input.targetGenerationId},
              base_resource_revision = ${candidate.resource_revision},
              source_watermark = ${candidate.resource_revision},
              activation_watermark = ${candidate.resource_revision},
              state = 'running', current_phase = ${initialPhase},
              settings_revision = ${input.settingsRevision},
              settings_snapshot_json = ${transaction.json(input.settings)},
              required_projection_kinds = ${requiredProjectionKinds}::text[],
              completed_projection_kinds = '{}'::text[],
              expected_subtask_count = 0, completed_subtask_count = 0,
              expected_record_count = 0, completed_record_count = 0,
              expected_directory_count = 0, completed_directory_count = 0,
              expected_object_count = 0, object_write_count = 0,
              object_reuse_count = 0, retry_count = 0,
              recent_records_per_second = NULL,
              rolling_batch_latency_ms = NULL,
              estimated_completion_at = NULL,
              attempt_count = attempt_count + 1,
              started_at = coalesce(started_at, ${input.now}),
              last_progress_at = ${input.now}, last_heartbeat_at = ${input.now},
              updated_at = ${input.now}
          WHERE knowledge_base_id = ${candidate.knowledge_base_id}
            AND repair_version = ${input.repairVersion}
        `;

        if (candidate.tree_stale) {
          await transaction`
            INSERT INTO focowiki.projection_repair_subtasks (
              id, knowledge_base_id, repair_version, target_generation_id,
              base_generation_id, task_kind, partition_key, phase_order,
              source_watermark, settings_revision, settings_snapshot_json,
              expected_record_count, max_attempts, run_after, created_at, updated_at
            )
            SELECT 'projection-repair-task-' || md5(
                     ${input.targetGenerationId} || chr(31)
                     || 'tree_partition' || chr(31) || record.shard_key
                   ),
                   ${candidate.knowledge_base_id}, ${input.repairVersion},
                   ${input.targetGenerationId}, ${candidate.base_generation_id},
                   'tree_partition', record.shard_key, 10,
                   ${candidate.resource_revision}, ${input.settingsRevision},
                   ${transaction.json(input.settings)}, count(*)::bigint,
                   ${input.maxAttempts}, ${input.now}, ${input.now}, ${input.now}
            FROM focowiki.active_projection_records record
            WHERE record.knowledge_base_id = ${candidate.knowledge_base_id}
              AND record.projection_kind = 'tree'
            GROUP BY record.shard_key
            ON CONFLICT (target_generation_id, task_kind, partition_key) DO NOTHING
          `;
        }
        if (candidate.directory_stale) {
          await transaction`
            INSERT INTO focowiki.projection_repair_subtasks (
              id, knowledge_base_id, repair_version, target_generation_id,
              base_generation_id, task_kind, partition_key, phase_order,
              source_watermark, settings_revision, settings_snapshot_json,
              expected_record_count, max_attempts, run_after, created_at, updated_at
            )
            SELECT 'projection-repair-task-' || md5(
                     ${input.targetGenerationId} || chr(31)
                     || 'directory' || chr(31) || directory.logical_path
                   ),
                   ${candidate.knowledge_base_id}, ${input.repairVersion},
                   ${input.targetGenerationId}, ${candidate.base_generation_id},
                   'directory', directory.logical_path, 20,
                   ${candidate.resource_revision}, ${input.settingsRevision},
                   ${transaction.json(input.settings)},
                   count(child.record_id)::bigint,
                   ${input.maxAttempts}, ${input.now}, ${input.now}, ${input.now}
            FROM focowiki.active_projection_records directory
            LEFT JOIN focowiki.active_projection_records child
              ON child.knowledge_base_id = directory.knowledge_base_id
             AND child.projection_kind = 'tree'
             AND child.parent_path = directory.logical_path
             AND child.payload_json->>'kind' IN ('directory', 'file')
            WHERE directory.knowledge_base_id = ${candidate.knowledge_base_id}
              AND directory.projection_kind = 'tree'
              AND directory.payload_json->>'kind' = 'directory'
              AND directory.logical_path IS NOT NULL
            GROUP BY directory.logical_path
            ON CONFLICT (target_generation_id, task_kind, partition_key) DO NOTHING
          `;
        }
        if (candidate.graph_stale) {
          await transaction`
            INSERT INTO focowiki.projection_repair_subtasks (
              id, knowledge_base_id, repair_version, target_generation_id,
              base_generation_id, task_kind, partition_key, phase_order,
              source_watermark, settings_revision, settings_snapshot_json,
              expected_record_count, max_attempts, run_after, created_at, updated_at
            )
            SELECT 'projection-repair-task-' || md5(
                     ${input.targetGenerationId} || chr(31) || 'graph_partition'
                     || chr(31) || record.projection_kind || chr(31) || record.shard_key
                   ),
                   ${candidate.knowledge_base_id}, ${input.repairVersion},
                   ${input.targetGenerationId}, ${candidate.base_generation_id},
                   'graph_partition',
                   record.projection_kind || chr(31) || record.shard_key, 30,
                   ${candidate.resource_revision}, ${input.settingsRevision},
                   ${transaction.json(input.settings)}, count(*)::bigint,
                   ${input.maxAttempts}, ${input.now}, ${input.now}, ${input.now}
            FROM focowiki.active_projection_records record
            WHERE record.knowledge_base_id = ${candidate.knowledge_base_id}
              AND record.projection_kind IN ('graph_node', 'graph_edge')
            GROUP BY record.projection_kind, record.shard_key
            ON CONFLICT (target_generation_id, task_kind, partition_key) DO NOTHING
          `;
          await transaction`
            INSERT INTO focowiki.projection_repair_subtasks (
              id, knowledge_base_id, repair_version, target_generation_id,
              base_generation_id, task_kind, partition_key, phase_order,
              source_watermark, settings_revision, settings_snapshot_json,
              expected_record_count, max_attempts, run_after, created_at, updated_at
            )
            SELECT 'projection-repair-task-' || md5(
                     ${input.targetGenerationId} || chr(31) || 'graph_finalize'
                   ),
                   ${candidate.knowledge_base_id}, ${input.repairVersion},
                   ${input.targetGenerationId}, ${candidate.base_generation_id},
                   'graph_finalize', 'graph', 40,
                   ${candidate.resource_revision}, ${input.settingsRevision},
                   ${transaction.json(input.settings)}, count(*)::bigint,
                   ${input.maxAttempts}, ${input.now}, ${input.now}, ${input.now}
            FROM focowiki.active_projection_records record
            WHERE record.knowledge_base_id = ${candidate.knowledge_base_id}
              AND record.projection_kind IN ('graph_node', 'graph_edge')
            ON CONFLICT (target_generation_id, task_kind, partition_key) DO NOTHING
          `;
        }
        await transaction`
          INSERT INTO focowiki.projection_repair_subtasks (
            id, knowledge_base_id, repair_version, target_generation_id,
            base_generation_id, task_kind, partition_key, phase_order,
            source_watermark, settings_revision, settings_snapshot_json,
            expected_record_count, max_attempts, run_after, created_at, updated_at
          ) VALUES (
            ${`projection-repair-task-${input.targetGenerationId}-finalize`},
            ${candidate.knowledge_base_id}, ${input.repairVersion},
            ${input.targetGenerationId}, ${candidate.base_generation_id},
            'finalize', 'root', 100, ${candidate.resource_revision},
            ${input.settingsRevision}, ${transaction.json(input.settings)},
            1, ${input.maxAttempts}, ${input.now}, ${input.now}, ${input.now}
          )
          ON CONFLICT (target_generation_id, task_kind, partition_key) DO NOTHING
        `;
        const totals = await transaction<Array<{
          task_count: number;
          record_count: number;
          directory_count: number;
        }>>`
          SELECT count(*)::int AS task_count,
                 coalesce(sum(expected_record_count) FILTER (
                   WHERE task_kind IN (
                     'tree_partition', 'directory', 'graph_partition'
                   )
                 ), 0)::bigint AS record_count,
                 count(*) FILTER (WHERE task_kind = 'directory')::int AS directory_count
          FROM focowiki.projection_repair_subtasks
          WHERE target_generation_id = ${input.targetGenerationId}
        `;
        const total = totals[0]!;
        await transaction`
          UPDATE focowiki.knowledge_base_projection_repairs
          SET expected_subtask_count = ${total.task_count},
              expected_record_count = ${total.record_count},
              expected_directory_count = ${total.directory_count},
              expected_object_count = ${total.task_count},
              updated_at = ${input.now}
          WHERE knowledge_base_id = ${candidate.knowledge_base_id}
            AND repair_version = ${input.repairVersion}
            AND target_generation_id = ${input.targetGenerationId}
        `;
        return {
          knowledgeBaseId: candidate.knowledge_base_id,
          taskCount: Number(total.task_count)
        };
      });
    },

    async claimBatch(input) {
      const limit = boundedLimit(input.limit, 1, 16, "Projection repair claim limit");
      const rows = await sql<TaskRow[]>`
        WITH candidates AS MATERIALIZED (
          SELECT task.id,
                 ${input.leaseTokenPrefix} || ':' || task.id AS next_lease_token
          FROM focowiki.projection_repair_subtasks task
          JOIN focowiki.knowledge_base_projection_repairs repair
            ON repair.knowledge_base_id = task.knowledge_base_id
           AND repair.repair_version = task.repair_version
           AND repair.target_generation_id = task.target_generation_id
           AND repair.state = 'running'
          WHERE task.repair_version = ${input.repairVersion}
            AND task.attempt_count < task.max_attempts
            AND (
              (task.state IN ('pending', 'retry') AND task.run_after <= ${input.now})
              OR (
                task.state = 'running'
                AND task.lease_expires_at <= ${input.now}
              )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM focowiki.projection_repair_subtasks dependency
              WHERE dependency.target_generation_id = task.target_generation_id
                AND dependency.phase_order < task.phase_order
                AND dependency.state <> 'completed'
            )
          ORDER BY task.phase_order, task.knowledge_base_id, task.partition_key, task.id
          LIMIT ${limit}
          FOR UPDATE OF task SKIP LOCKED
        )
        UPDATE focowiki.projection_repair_subtasks task
        SET state = 'running', attempt_count = task.attempt_count + 1,
            lease_owner = ${input.workerId},
            lease_token = candidates.next_lease_token,
            lease_expires_at = ${input.leaseExpiresAt},
            heartbeat_at = ${input.now},
            started_at = coalesce(task.started_at, ${input.now}),
            last_error_code = NULL, last_error_message = NULL,
            updated_at = ${input.now}
        FROM candidates
        WHERE task.id = candidates.id
        RETURNING task.id, task.knowledge_base_id, task.repair_version,
                  task.target_generation_id, task.base_generation_id,
                  task.task_kind, task.partition_key, task.phase_order,
                  task.source_watermark, task.settings_revision,
                  task.settings_snapshot_json, task.expected_record_count,
                  task.processed_record_count, task.attempt_count, task.max_attempts,
                  task.lease_owner, task.lease_token, task.checkpoint_json
      `;
      return rows.map(mapTask);
    },

    async heartbeat(input) {
      const rows = await sql<Array<{ knowledge_base_id: string }>>`
        WITH owned AS MATERIALIZED (
          UPDATE focowiki.projection_repair_subtasks
          SET lease_expires_at = ${input.leaseExpiresAt},
              heartbeat_at = ${input.heartbeatAt},
              updated_at = ${input.heartbeatAt}
          WHERE id = ${input.task.id}
            AND state = 'running'
            AND lease_owner = ${input.task.leaseOwner}
            AND lease_token = ${input.task.leaseToken}
          RETURNING knowledge_base_id, repair_version
        )
        UPDATE focowiki.knowledge_base_projection_repairs repair
        SET last_heartbeat_at = ${input.heartbeatAt},
            updated_at = ${input.heartbeatAt}
        FROM owned
        WHERE repair.knowledge_base_id = owned.knowledge_base_id
          AND repair.repair_version = owned.repair_version
          AND repair.state = 'running'
        RETURNING repair.knowledge_base_id
      `;
      return rows.length === 1;
    },

    async checkpointTask(input) {
      const batchDurationMs = boundedDuration(input.batchDurationMs);
      return sql.begin(async (transaction) => {
        const rows = await transaction<Array<{
          knowledge_base_id: string;
          repair_version: number;
          previous_count: number;
        }>>`
          WITH owned AS MATERIALIZED (
            SELECT id, knowledge_base_id, repair_version, processed_record_count
            FROM focowiki.projection_repair_subtasks
            WHERE id = ${input.task.id}
              AND state = 'running'
              AND lease_owner = ${input.task.leaseOwner}
              AND lease_token = ${input.task.leaseToken}
            FOR UPDATE
          )
          UPDATE focowiki.projection_repair_subtasks task
          SET checkpoint_json = ${transaction.json(input.checkpoint)},
              processed_record_count = ${input.processedRecordCount},
              heartbeat_at = ${input.checkpointedAt},
              updated_at = ${input.checkpointedAt}
          FROM owned
          WHERE task.id = owned.id
          RETURNING task.knowledge_base_id, task.repair_version,
                    owned.processed_record_count AS previous_count
        `;
        const row = rows[0];
        if (!row) return false;
        const delta = input.processedRecordCount - Number(row.previous_count);
        if (delta < 0) {
          throw new Error("Projection repair checkpoint progress cannot move backwards");
        }
        await transaction`
          WITH current AS MATERIALIZED (
            SELECT knowledge_base_id, repair_version, expected_record_count,
                   completed_record_count, recent_records_per_second,
                   rolling_batch_latency_ms
            FROM focowiki.knowledge_base_projection_repairs
            WHERE knowledge_base_id = ${row.knowledge_base_id}
              AND repair_version = ${row.repair_version}
              AND state = 'running'
            FOR UPDATE
          ),
          metrics AS (
            SELECT current.*,
                   CASE
                     WHEN ${delta} <= 0 THEN current.recent_records_per_second
                     WHEN current.recent_records_per_second IS NULL
                       THEN ${delta * 1_000 / batchDurationMs}
                     ELSE current.recent_records_per_second * 0.8
                       + ${delta * 1_000 / batchDurationMs} * 0.2
                   END AS next_rate,
                   CASE
                     WHEN current.rolling_batch_latency_ms IS NULL
                       THEN ${batchDurationMs}
                     ELSE current.rolling_batch_latency_ms * 0.8
                       + ${batchDurationMs} * 0.2
                   END AS next_latency
            FROM current
          )
          UPDATE focowiki.knowledge_base_projection_repairs repair
          SET completed_record_count = metrics.completed_record_count + ${delta},
              recent_records_per_second = metrics.next_rate,
              rolling_batch_latency_ms = metrics.next_latency,
              estimated_completion_at = CASE
                WHEN metrics.next_rate IS NULL OR metrics.next_rate <= 0
                  OR metrics.expected_record_count <= metrics.completed_record_count + ${delta}
                  THEN NULL
                ELSE ${input.checkpointedAt}::timestamptz
                  + (
                      metrics.expected_record_count
                      - metrics.completed_record_count
                      - ${delta}
                    ) / metrics.next_rate * interval '1 second'
              END,
              last_progress_at = ${input.checkpointedAt},
              last_heartbeat_at = ${input.checkpointedAt},
              updated_at = ${input.checkpointedAt}
          FROM metrics
          WHERE repair.knowledge_base_id = metrics.knowledge_base_id
            AND repair.repair_version = metrics.repair_version
        `;
        return true;
      });
    },

    async completeTask(input) {
      const durationMs = boundedDuration(input.durationMs);
      return sql.begin(async (transaction) => {
        const rows = await transaction<Array<{
          knowledge_base_id: string;
          repair_version: number;
          task_kind: string;
          previous_count: number;
        }>>`
          WITH owned AS MATERIALIZED (
            SELECT id, processed_record_count
            FROM focowiki.projection_repair_subtasks
            WHERE id = ${input.task.id}
              AND state = 'running'
              AND lease_owner = ${input.task.leaseOwner}
              AND lease_token = ${input.task.leaseToken}
            FOR UPDATE
          )
          UPDATE focowiki.projection_repair_subtasks task
          SET state = 'completed',
              processed_record_count = ${input.processedRecordCount},
              object_write_count = ${input.objectWriteCount},
              object_reuse_count = ${input.objectReuseCount},
              lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
              heartbeat_at = ${input.completedAt}, completed_at = ${input.completedAt},
              updated_at = ${input.completedAt}
          FROM owned
          WHERE task.id = owned.id
          RETURNING task.knowledge_base_id, task.repair_version, task.task_kind,
                    owned.processed_record_count AS previous_count
        `;
        const row = rows[0];
        if (!row) return false;
        const progressDelta = input.processedRecordCount - Number(row.previous_count);
        if (progressDelta < 0) {
          throw new Error("Projection repair completion progress cannot move backwards");
        }
        await transaction`
          WITH current AS MATERIALIZED (
            SELECT knowledge_base_id, repair_version, expected_record_count,
                   completed_record_count, recent_records_per_second,
                   rolling_batch_latency_ms
            FROM focowiki.knowledge_base_projection_repairs
            WHERE knowledge_base_id = ${row.knowledge_base_id}
              AND repair_version = ${row.repair_version}
              AND state = 'running'
            FOR UPDATE
          ),
          metrics AS (
            SELECT current.*,
                   CASE
                     WHEN ${progressDelta} <= 0 THEN current.recent_records_per_second
                     WHEN current.recent_records_per_second IS NULL
                       THEN ${progressDelta * 1_000 / durationMs}
                     ELSE current.recent_records_per_second * 0.8
                       + ${progressDelta * 1_000 / durationMs} * 0.2
                   END AS next_rate,
                   CASE
                     WHEN current.rolling_batch_latency_ms IS NULL
                       THEN ${durationMs}
                     ELSE current.rolling_batch_latency_ms * 0.8
                       + ${durationMs} * 0.2
                   END AS next_latency
            FROM current
          )
          UPDATE focowiki.knowledge_base_projection_repairs repair
          SET completed_subtask_count = repair.completed_subtask_count + 1,
              completed_record_count =
                repair.completed_record_count + ${progressDelta},
              completed_directory_count = repair.completed_directory_count
                + CASE
                    WHEN ${row.task_kind} IN ('directory', 'directory_rebase')
                      THEN 1
                    ELSE 0
                  END,
              object_write_count = repair.object_write_count + ${input.objectWriteCount},
              object_reuse_count = repair.object_reuse_count + ${input.objectReuseCount},
              completed_projection_kinds = (
                SELECT coalesce(array_agg(kind ORDER BY kind), '{}'::text[])
                FROM unnest(repair.required_projection_kinds) kind
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM focowiki.projection_repair_subtasks remaining
                  WHERE remaining.knowledge_base_id = repair.knowledge_base_id
                    AND remaining.repair_version = repair.repair_version
                    AND remaining.state <> 'completed'
                    AND CASE
                      WHEN remaining.task_kind IN ('tree_partition', 'tree_rebase')
                        THEN 'tree'
                      WHEN remaining.task_kind IN ('directory', 'directory_rebase')
                        THEN 'directory'
                      WHEN remaining.task_kind IN (
                        'graph_partition', 'graph_finalize',
                        'graph_rebase', 'graph_rebase_finalize'
                      )
                        THEN 'graph'
                      ELSE NULL
                    END = kind
                )
              ),
              current_phase = coalesce((
                SELECT CASE next_task.task_kind
                  WHEN 'tree_partition' THEN 'tree'
                  WHEN 'directory' THEN 'directory'
                  WHEN 'graph_partition' THEN 'graph'
                  WHEN 'graph_finalize' THEN 'graph'
                  WHEN 'tree_rebase' THEN 'catch_up'
                  WHEN 'directory_rebase' THEN 'catch_up'
                  WHEN 'graph_rebase' THEN 'catch_up'
                  WHEN 'graph_rebase_finalize' THEN 'catch_up'
                  ELSE 'finalizing'
                END
                FROM focowiki.projection_repair_subtasks next_task
                WHERE next_task.knowledge_base_id = repair.knowledge_base_id
                  AND next_task.repair_version = repair.repair_version
                  AND next_task.state <> 'completed'
                ORDER BY next_task.phase_order, next_task.partition_key
                LIMIT 1
              ), 'finalizing'),
              recent_records_per_second = metrics.next_rate,
              rolling_batch_latency_ms = metrics.next_latency,
              estimated_completion_at = CASE
                WHEN metrics.next_rate IS NULL OR metrics.next_rate <= 0
                  OR metrics.expected_record_count
                    <= metrics.completed_record_count + ${progressDelta}
                  THEN NULL
                ELSE ${input.completedAt}::timestamptz
                  + (
                      metrics.expected_record_count
                      - metrics.completed_record_count
                      - ${progressDelta}
                    ) / metrics.next_rate * interval '1 second'
              END,
              last_progress_at = ${input.completedAt},
              last_heartbeat_at = ${input.completedAt},
              updated_at = ${input.completedAt}
          FROM metrics
          WHERE repair.knowledge_base_id = ${row.knowledge_base_id}
            AND repair.repair_version = ${row.repair_version}
            AND repair.state = 'running'
        `;
        return true;
      });
    },

    async retryTask(input) {
      return sql.begin(async (transaction) => {
        const rows = await transaction<Array<{
          state: "retry" | "failed";
          knowledge_base_id: string;
          repair_version: number;
        }>>`
          UPDATE focowiki.projection_repair_subtasks
          SET state = CASE
                WHEN NOT ${input.retryable}
                  OR attempt_count >= max_attempts THEN 'failed'
                ELSE 'retry'
              END,
              run_after = ${input.retryAt},
              lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
              last_error_code = ${input.errorCode},
              last_error_message = ${input.errorMessage},
              updated_at = ${input.failedAt}
          WHERE id = ${input.task.id}
            AND state = 'running'
            AND lease_owner = ${input.task.leaseOwner}
            AND lease_token = ${input.task.leaseToken}
          RETURNING state, knowledge_base_id, repair_version
        `;
        const row = rows[0];
        if (!row) return "lost";
        await transaction`
          UPDATE focowiki.knowledge_base_projection_repairs
          SET retry_count = retry_count + 1,
              state = CASE WHEN ${row.state} = 'failed' THEN 'failed' ELSE state END,
              current_phase = CASE WHEN ${row.state} = 'failed' THEN 'failed' ELSE current_phase END,
              last_error_code = ${input.errorCode},
              last_error_message = ${input.errorMessage},
              last_progress_at = ${input.failedAt},
              updated_at = ${input.failedAt}
          WHERE knowledge_base_id = ${row.knowledge_base_id}
            AND repair_version = ${row.repair_version}
        `;
        if (row.state === "failed") {
          await transaction`
            UPDATE focowiki.projection_repair_subtasks
            SET state = 'cancelled',
                lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                updated_at = ${input.failedAt}
            WHERE knowledge_base_id = ${row.knowledge_base_id}
              AND repair_version = ${row.repair_version}
              AND state IN ('pending', 'retry', 'running')
          `;
          await transaction`
            UPDATE focowiki.publication_generations generation
            SET state = 'failed', failed_at = ${input.failedAt},
                safe_error_code = ${input.errorCode},
                safe_error_message = ${input.errorMessage},
                updated_at = ${input.failedAt}
            FROM focowiki.knowledge_base_projection_repairs repair
            WHERE repair.knowledge_base_id = ${row.knowledge_base_id}
              AND repair.repair_version = ${row.repair_version}
              AND generation.id = repair.target_generation_id
              AND generation.state IN ('open', 'frozen', 'building', 'validating')
          `;
        }
        return row.state;
      });
    },

    async completeRepair(input) {
      return sql.begin(async (transaction) => {
        const rows = await transaction<Array<{ knowledge_base_id: string }>>`
          UPDATE focowiki.knowledge_base_projection_repairs repair
          SET state = 'completed', current_phase = 'completed',
              activation_watermark = knowledge_base.resource_revision,
              completed_at = ${input.completedAt},
              last_progress_at = ${input.completedAt},
              last_error_code = NULL, last_error_message = NULL,
              updated_at = ${input.completedAt}
          FROM focowiki.knowledge_bases knowledge_base
          WHERE repair.knowledge_base_id = ${input.task.knowledgeBaseId}
            AND repair.repair_version = ${input.task.repairVersion}
            AND repair.target_generation_id = ${input.task.targetGenerationId}
            AND repair.state = 'running'
            AND knowledge_base.id = repair.knowledge_base_id
            AND knowledge_base.active_generation_id = ${input.activeGenerationId}
            AND NOT EXISTS (
              SELECT 1 FROM focowiki.projection_repair_subtasks task
              WHERE task.knowledge_base_id = repair.knowledge_base_id
                AND task.repair_version = repair.repair_version
                AND task.state <> 'completed'
            )
          RETURNING repair.knowledge_base_id
        `;
        if (rows.length !== 1) return false;
        await recoverDirectoryValidationFailures(transaction, {
          knowledgeBaseId: input.task.knowledgeBaseId,
          predecessorGenerationId: input.task.baseGenerationId,
          recoveredAt: input.completedAt
        });
        await transaction`
          INSERT INTO focowiki.knowledge_base_projection_versions (
            knowledge_base_id, projection_kind, format_version,
            input_version, active_generation_id, updated_at
          ) VALUES
            (
              ${input.task.knowledgeBaseId}, 'tree',
              ${REQUIRED_PROJECTION_REPAIR_VERSIONS.tree},
              ${REQUIRED_PROJECTION_REPAIR_VERSIONS.tree},
              ${input.activeGenerationId}, ${input.completedAt}
            ),
            (
              ${input.task.knowledgeBaseId}, 'directory',
              ${REQUIRED_PROJECTION_REPAIR_VERSIONS.directory},
              ${REQUIRED_PROJECTION_REPAIR_VERSIONS.directory},
              ${input.activeGenerationId}, ${input.completedAt}
            ),
            (
              ${input.task.knowledgeBaseId}, 'graph',
              ${REQUIRED_PROJECTION_REPAIR_VERSIONS.graph},
              ${REQUIRED_PROJECTION_REPAIR_VERSIONS.graph},
              ${input.activeGenerationId}, ${input.completedAt}
            )
          ON CONFLICT (knowledge_base_id, projection_kind) DO UPDATE
          SET format_version = EXCLUDED.format_version,
              input_version = EXCLUDED.input_version,
              active_generation_id = EXCLUDED.active_generation_id,
              updated_at = EXCLUDED.updated_at
        `;
        return true;
      });
    },

    async scheduleCatchUp(input) {
      return sql.begin(async (transaction) => {
        const rows = await transaction<Array<{
          knowledge_base_id: string;
          repair_version: number;
          target_generation_id: string;
          task_base_generation_id: string;
          task_source_watermark: number;
          active_generation_id: string;
          resource_revision: number;
          required_projection_kinds: string[];
          settings_revision: number;
          settings_snapshot_json: SerializableJson;
          max_attempts: number;
        }>>`
          SELECT task.knowledge_base_id, task.repair_version,
                 task.target_generation_id,
                 task.base_generation_id AS task_base_generation_id,
                 task.source_watermark AS task_source_watermark,
                 knowledge_base.active_generation_id,
                 knowledge_base.resource_revision,
                 repair.required_projection_kinds,
                 repair.settings_revision,
                 repair.settings_snapshot_json,
                 task.max_attempts
          FROM focowiki.projection_repair_subtasks task
          JOIN focowiki.knowledge_base_projection_repairs repair
            ON repair.knowledge_base_id = task.knowledge_base_id
           AND repair.repair_version = task.repair_version
           AND repair.target_generation_id = task.target_generation_id
           AND repair.state = 'running'
          JOIN focowiki.knowledge_bases knowledge_base
            ON knowledge_base.id = repair.knowledge_base_id
           AND knowledge_base.deleted_at IS NULL
           AND knowledge_base.active_generation_id IS NOT NULL
          WHERE task.id = ${input.task.id}
            AND task.task_kind = 'finalize'
            AND task.state = 'running'
            AND task.lease_owner = ${input.task.leaseOwner}
            AND task.lease_token = ${input.task.leaseToken}
          FOR UPDATE OF task, repair, knowledge_base
        `;
        const row = rows[0];
        if (!row) return "lost";
        if (row.active_generation_id === row.target_generation_id) {
          return "ready";
        }
        if (
          row.active_generation_id === row.task_base_generation_id
          && Number(row.resource_revision) === Number(row.task_source_watermark)
        ) {
          return "ready";
        }

        if (row.active_generation_id === row.task_base_generation_id) {
          await deferFinalizeForCatchUp(transaction, {
            taskId: input.task.id,
            scheduledAt: input.scheduledAt,
            baseGenerationId: row.task_base_generation_id,
            sourceWatermark: Number(row.task_source_watermark)
          });
          await transaction`
            UPDATE focowiki.knowledge_base_projection_repairs
            SET current_phase = 'catch_up',
                activation_watermark = ${row.task_source_watermark},
                last_progress_at = ${input.scheduledAt},
                last_heartbeat_at = ${input.scheduledAt},
                estimated_completion_at = NULL,
                updated_at = ${input.scheduledAt}
            WHERE knowledge_base_id = ${row.knowledge_base_id}
              AND repair_version = ${row.repair_version}
              AND state = 'running'
          `;
          return "scheduled";
        }

        const lineage = await transaction<Array<{
          generation_id: string;
          resource_watermark: number | null;
        }>>`
          WITH RECURSIVE lineage AS (
            SELECT generation.id, generation.predecessor_generation_id, 0 AS depth
            FROM focowiki.publication_generations generation
            WHERE generation.id = ${row.active_generation_id}
              AND generation.knowledge_base_id = ${row.knowledge_base_id}
            UNION ALL
            SELECT predecessor.id, predecessor.predecessor_generation_id,
                   lineage.depth + 1
            FROM focowiki.publication_generations predecessor
            JOIN lineage ON predecessor.id = lineage.predecessor_generation_id
            WHERE lineage.id <> ${row.task_base_generation_id}
              AND lineage.depth < 10_000
          )
          SELECT lineage.id AS generation_id,
                 max(fact.resource_revision)::bigint AS resource_watermark
          FROM lineage
          LEFT JOIN focowiki.publication_change_facts fact
            ON fact.knowledge_base_id = ${row.knowledge_base_id}
           AND fact.generation_id = lineage.id
          WHERE lineage.id <> ${row.task_base_generation_id}
          GROUP BY lineage.id, lineage.depth
          ORDER BY lineage.depth DESC
        `;
        const generationIds = lineage.map((generation) => generation.generation_id);
        const activeWatermark = Math.max(
          Number(row.task_source_watermark),
          ...lineage.map((generation) => Number(generation.resource_watermark ?? 0))
        );
        const impacts = generationIds.length === 0
          ? []
          : await transaction<Array<{
              projection_kind: string;
              projection_key: string;
            }>>`
              SELECT DISTINCT impact.projection_kind, impact.projection_key
              FROM focowiki.publication_impacts impact
              WHERE impact.knowledge_base_id = ${row.knowledge_base_id}
                AND impact.generation_id = ANY(${generationIds})
                AND impact.projection_kind IN (
                  'tree', 'directory', 'graph_node', 'graph_edge'
                )
              ORDER BY impact.projection_kind, impact.projection_key
            `;
        const required = new Set(row.required_projection_kinds);
        let treePartitions = required.has("tree")
          ? uniqueSorted(impacts
              .filter((impact) => impact.projection_kind === "tree")
              .map((impact) => impact.projection_key))
          : [];
        let directories = required.has("directory")
          ? uniqueSorted(impacts
              .filter((impact) => impact.projection_kind === "directory")
              .map((impact) => normalizeDirectoryPath(impact.projection_key)))
          : [];
        let graphPartitions = required.has("graph")
          ? uniqueSorted(impacts
              .filter((impact) =>
                impact.projection_kind === "graph_node"
                || impact.projection_kind === "graph_edge"
              )
              .map((impact) =>
                `${impact.projection_kind}\u001f${impact.projection_key}`
              ))
          : [];
        if (required.has("tree") && treePartitions.length === 0) {
          const fallback = await transaction<Array<{ shard_key: string }>>`
            SELECT DISTINCT changed.shard_key
            FROM (
              SELECT active.shard_key
              FROM focowiki.active_projection_records active
              WHERE active.knowledge_base_id = ${row.knowledge_base_id}
                AND active.projection_kind = 'tree'
                AND active.last_changed_generation_id = ANY(${generationIds})
              UNION
              SELECT candidate.shard_key
              FROM focowiki.generation_projection_records candidate
              LEFT JOIN focowiki.active_projection_records active
                ON active.knowledge_base_id = candidate.knowledge_base_id
               AND active.projection_kind = candidate.projection_kind
               AND active.record_id = candidate.record_id
              WHERE candidate.generation_id = ${row.target_generation_id}
                AND candidate.knowledge_base_id = ${row.knowledge_base_id}
                AND candidate.projection_kind = 'tree'
                AND (
                  active.record_id IS NULL
                  OR active.shard_key <> candidate.shard_key
                )
            ) changed
            ORDER BY changed.shard_key
          `;
          treePartitions = fallback.map((partition) => partition.shard_key);
        }
        if (
          required.has("directory")
          && directories.length === 0
          && treePartitions.length > 0
        ) {
          const fallback = await transaction<Array<{ directory_path: string }>>`
            SELECT DISTINCT path.directory_path
            FROM (
              SELECT active.parent_path AS directory_path
              FROM focowiki.active_projection_records active
              WHERE active.knowledge_base_id = ${row.knowledge_base_id}
                AND active.projection_kind = 'tree'
                AND active.shard_key = ANY(${treePartitions})
                AND active.parent_path IS NOT NULL
              UNION
              SELECT active.logical_path
              FROM focowiki.active_projection_records active
              WHERE active.knowledge_base_id = ${row.knowledge_base_id}
                AND active.projection_kind = 'tree'
                AND active.shard_key = ANY(${treePartitions})
                AND active.payload_json->>'kind' = 'directory'
                AND active.logical_path IS NOT NULL
              UNION
              SELECT candidate.parent_path
              FROM focowiki.generation_projection_records candidate
              WHERE candidate.generation_id = ${row.target_generation_id}
                AND candidate.knowledge_base_id = ${row.knowledge_base_id}
                AND candidate.projection_kind = 'tree'
                AND candidate.shard_key = ANY(${treePartitions})
                AND candidate.parent_path IS NOT NULL
              UNION
              SELECT candidate.logical_path
              FROM focowiki.generation_projection_records candidate
              WHERE candidate.generation_id = ${row.target_generation_id}
                AND candidate.knowledge_base_id = ${row.knowledge_base_id}
                AND candidate.projection_kind = 'tree'
                AND candidate.shard_key = ANY(${treePartitions})
                AND candidate.payload_json->>'kind' = 'directory'
                AND candidate.logical_path IS NOT NULL
            ) path
            WHERE path.directory_path IS NOT NULL
            ORDER BY path.directory_path
          `;
          directories = fallback.map((directory) => directory.directory_path);
        }
        if (required.has("graph") && graphPartitions.length === 0) {
          const fallback = await transaction<Array<{
            projection_kind: string;
            shard_key: string;
          }>>`
            SELECT DISTINCT changed.projection_kind, changed.shard_key
            FROM (
              SELECT active.projection_kind, active.shard_key
              FROM focowiki.active_projection_records active
              WHERE active.knowledge_base_id = ${row.knowledge_base_id}
                AND active.projection_kind IN ('graph_node', 'graph_edge')
                AND active.last_changed_generation_id = ANY(${generationIds})
              UNION
              SELECT candidate.projection_kind, candidate.shard_key
              FROM focowiki.generation_projection_records candidate
              LEFT JOIN focowiki.active_projection_records active
                ON active.knowledge_base_id = candidate.knowledge_base_id
               AND active.projection_kind = candidate.projection_kind
               AND active.record_id = candidate.record_id
              WHERE candidate.generation_id = ${row.target_generation_id}
                AND candidate.knowledge_base_id = ${row.knowledge_base_id}
                AND candidate.projection_kind IN ('graph_node', 'graph_edge')
                AND (
                  active.record_id IS NULL
                  OR active.shard_key <> candidate.shard_key
                )
            ) changed
            ORDER BY changed.projection_kind, changed.shard_key
          `;
          graphPartitions = fallback.map((partition) =>
            `${partition.projection_kind}\u001f${partition.shard_key}`
          );
        }
        const inserted: Array<{
          task_kind: ProjectionRepairWorkItem["kind"];
          expected_record_count: number;
        }> = [];
        const encodedPrefix = `${row.active_generation_id}\u001e`;

        if (treePartitions.length > 0) {
          inserted.push(...await transaction<Array<{
            task_kind: ProjectionRepairWorkItem["kind"];
            expected_record_count: number;
          }>>`
            WITH partitions AS (
              SELECT unnest(${treePartitions}::text[]) AS partition_key
            )
            INSERT INTO focowiki.projection_repair_subtasks (
              id, knowledge_base_id, repair_version, target_generation_id,
              base_generation_id, task_kind, partition_key, phase_order,
              source_watermark, settings_revision, settings_snapshot_json,
              expected_record_count, max_attempts, run_after, created_at, updated_at
            )
            SELECT 'projection-repair-task-' || md5(
                     ${row.target_generation_id} || chr(31) || 'tree_rebase'
                     || chr(31) || ${row.active_generation_id}
                     || chr(31) || partition.partition_key
                   ),
                   ${row.knowledge_base_id}, ${row.repair_version},
                   ${row.target_generation_id}, ${row.active_generation_id},
                   'tree_rebase',
                   ${encodedPrefix} || partition.partition_key, 60,
                   ${activeWatermark}, ${row.settings_revision},
                   ${transaction.json(row.settings_snapshot_json)},
                   (
                     SELECT count(*)::bigint
                     FROM (
                       SELECT active.record_id
                       FROM focowiki.active_projection_records active
                       WHERE active.knowledge_base_id = ${row.knowledge_base_id}
                         AND active.projection_kind = 'tree'
                         AND active.shard_key = partition.partition_key
                       UNION
                       SELECT candidate.record_id
                       FROM focowiki.generation_projection_records candidate
                       WHERE candidate.generation_id = ${row.target_generation_id}
                         AND candidate.knowledge_base_id = ${row.knowledge_base_id}
                         AND candidate.projection_kind = 'tree'
                         AND candidate.shard_key = partition.partition_key
                     ) identity
                   ),
                   ${row.max_attempts}, ${input.scheduledAt},
                   ${input.scheduledAt}, ${input.scheduledAt}
            FROM partitions partition
            ON CONFLICT (target_generation_id, task_kind, partition_key) DO NOTHING
            RETURNING task_kind, expected_record_count
          `);
        }
        if (directories.length > 0) {
          inserted.push(...await transaction<Array<{
            task_kind: ProjectionRepairWorkItem["kind"];
            expected_record_count: number;
          }>>`
            WITH directories AS (
              SELECT unnest(${directories}::text[]) AS directory_path
            )
            INSERT INTO focowiki.projection_repair_subtasks (
              id, knowledge_base_id, repair_version, target_generation_id,
              base_generation_id, task_kind, partition_key, phase_order,
              source_watermark, settings_revision, settings_snapshot_json,
              expected_record_count, max_attempts, run_after, created_at, updated_at
            )
            SELECT 'projection-repair-task-' || md5(
                     ${row.target_generation_id} || chr(31) || 'directory_rebase'
                     || chr(31) || ${row.active_generation_id}
                     || chr(31) || directory.directory_path
                   ),
                   ${row.knowledge_base_id}, ${row.repair_version},
                   ${row.target_generation_id}, ${row.active_generation_id},
                   'directory_rebase',
                   ${encodedPrefix} || directory.directory_path, 70,
                   ${activeWatermark}, ${row.settings_revision},
                   ${transaction.json(row.settings_snapshot_json)},
                   (
                     SELECT count(*)::bigint
                     FROM focowiki.active_projection_records child
                     WHERE child.knowledge_base_id = ${row.knowledge_base_id}
                       AND child.projection_kind = 'tree'
                       AND child.parent_path = directory.directory_path
                       AND child.payload_json->>'kind' IN ('directory', 'file')
                   ),
                   ${row.max_attempts}, ${input.scheduledAt},
                   ${input.scheduledAt}, ${input.scheduledAt}
            FROM directories directory
            ON CONFLICT (target_generation_id, task_kind, partition_key) DO NOTHING
            RETURNING task_kind, expected_record_count
          `);
        }
        if (graphPartitions.length > 0) {
          inserted.push(...await transaction<Array<{
            task_kind: ProjectionRepairWorkItem["kind"];
            expected_record_count: number;
          }>>`
            WITH partitions AS (
              SELECT split_part(value, chr(31), 1) AS projection_kind,
                     split_part(value, chr(31), 2) AS shard_key,
                     value AS partition_key
              FROM unnest(${graphPartitions}::text[]) value
            )
            INSERT INTO focowiki.projection_repair_subtasks (
              id, knowledge_base_id, repair_version, target_generation_id,
              base_generation_id, task_kind, partition_key, phase_order,
              source_watermark, settings_revision, settings_snapshot_json,
              expected_record_count, max_attempts, run_after, created_at, updated_at
            )
            SELECT 'projection-repair-task-' || md5(
                     ${row.target_generation_id} || chr(31) || 'graph_rebase'
                     || chr(31) || ${row.active_generation_id}
                     || chr(31) || partition.partition_key
                   ),
                   ${row.knowledge_base_id}, ${row.repair_version},
                   ${row.target_generation_id}, ${row.active_generation_id},
                   'graph_rebase',
                   ${encodedPrefix} || partition.partition_key, 80,
                   ${activeWatermark}, ${row.settings_revision},
                   ${transaction.json(row.settings_snapshot_json)},
                   (
                     SELECT count(*)::bigint
                     FROM (
                       SELECT active.record_id
                       FROM focowiki.active_projection_records active
                       WHERE active.knowledge_base_id = ${row.knowledge_base_id}
                         AND active.projection_kind = partition.projection_kind
                         AND active.shard_key = partition.shard_key
                       UNION
                       SELECT candidate.record_id
                       FROM focowiki.generation_projection_records candidate
                       WHERE candidate.generation_id = ${row.target_generation_id}
                         AND candidate.knowledge_base_id = ${row.knowledge_base_id}
                         AND candidate.projection_kind = partition.projection_kind
                         AND candidate.shard_key = partition.shard_key
                     ) identity
                   ),
                   ${row.max_attempts}, ${input.scheduledAt},
                   ${input.scheduledAt}, ${input.scheduledAt}
            FROM partitions partition
            ON CONFLICT (target_generation_id, task_kind, partition_key) DO NOTHING
            RETURNING task_kind, expected_record_count
          `);
          inserted.push(...await transaction<Array<{
            task_kind: ProjectionRepairWorkItem["kind"];
            expected_record_count: number;
          }>>`
            INSERT INTO focowiki.projection_repair_subtasks (
              id, knowledge_base_id, repair_version, target_generation_id,
              base_generation_id, task_kind, partition_key, phase_order,
              source_watermark, settings_revision, settings_snapshot_json,
              expected_record_count, max_attempts, run_after, created_at, updated_at
            )
            SELECT 'projection-repair-task-' || md5(
                     ${row.target_generation_id} || chr(31)
                     || 'graph_rebase_finalize' || chr(31)
                     || ${row.active_generation_id}
                   ),
                   ${row.knowledge_base_id}, ${row.repair_version},
                   ${row.target_generation_id}, ${row.active_generation_id},
                   'graph_rebase_finalize',
                   ${encodedPrefix} || 'graph', 90,
                   ${activeWatermark}, ${row.settings_revision},
                   ${transaction.json(row.settings_snapshot_json)},
                   count(*)::bigint, ${row.max_attempts},
                   ${input.scheduledAt}, ${input.scheduledAt}, ${input.scheduledAt}
            FROM focowiki.active_projection_records record
            WHERE record.knowledge_base_id = ${row.knowledge_base_id}
              AND record.projection_kind IN ('graph_node', 'graph_edge')
            ON CONFLICT (target_generation_id, task_kind, partition_key) DO NOTHING
            RETURNING task_kind, expected_record_count
          `);
        }

        await deferFinalizeForCatchUp(transaction, {
          taskId: input.task.id,
          scheduledAt: input.scheduledAt,
          baseGenerationId: row.active_generation_id,
          sourceWatermark: activeWatermark
        });
        await transaction`
          UPDATE focowiki.publication_generations
          SET predecessor_generation_id = ${row.active_generation_id},
              state = 'building', validated_at = NULL,
              updated_at = ${input.scheduledAt}
          WHERE id = ${row.target_generation_id}
            AND knowledge_base_id = ${row.knowledge_base_id}
            AND state IN ('building', 'validating')
        `;
        const insertedRecordCount = inserted.reduce(
          (total, task) => total + Number(task.expected_record_count),
          0
        );
        const insertedDirectoryCount = inserted.filter(
          (task) => task.task_kind === "directory_rebase"
        ).length;
        const changedKinds = uniqueSorted(inserted.flatMap((task) => {
          if (task.task_kind === "tree_rebase") return ["tree"];
          if (task.task_kind === "directory_rebase") return ["directory"];
          if (
            task.task_kind === "graph_rebase"
            || task.task_kind === "graph_rebase_finalize"
          ) return ["graph"];
          return [];
        }));
        await transaction`
          UPDATE focowiki.knowledge_base_projection_repairs repair
          SET base_generation_id = ${row.active_generation_id},
              base_resource_revision = ${activeWatermark},
              source_watermark = ${activeWatermark},
              activation_watermark = ${activeWatermark},
              current_phase = 'catch_up',
              expected_subtask_count = expected_subtask_count + ${inserted.length},
              expected_record_count = expected_record_count + ${insertedRecordCount},
              expected_directory_count =
                expected_directory_count + ${insertedDirectoryCount},
              expected_object_count = expected_object_count + ${inserted.length},
              completed_projection_kinds = ARRAY(
                SELECT kind
                FROM unnest(repair.completed_projection_kinds) kind
                WHERE NOT (kind = ANY(${changedKinds}::text[]))
                ORDER BY kind
              ),
              last_progress_at = ${input.scheduledAt},
              last_heartbeat_at = ${input.scheduledAt},
              estimated_completion_at = NULL,
              last_error_code = NULL, last_error_message = NULL,
              updated_at = ${input.scheduledAt}
          WHERE knowledge_base_id = ${row.knowledge_base_id}
            AND repair_version = ${row.repair_version}
            AND target_generation_id = ${row.target_generation_id}
            AND state = 'running'
        `;
        return "scheduled";
      });
    }
  };
}

async function recoverDirectoryValidationFailures(
  transaction: TransactionSql,
  input: {
    knowledgeBaseId: string;
    predecessorGenerationId: string;
    recoveredAt: string;
  }
): Promise<void> {
  const recoverable = await transaction<Array<{ generation_id: string }>>`
    SELECT generation.id AS generation_id
    FROM focowiki.publication_generations generation
    WHERE generation.knowledge_base_id = ${input.knowledgeBaseId}
      AND generation.predecessor_generation_id = ${input.predecessorGenerationId}
      AND generation.generation_kind = 'normal'
      AND generation.state = 'failed'
      AND (
        generation.safe_error_message LIKE '%DIRECTORY_NAVIGATION_COUNT_MISMATCH:%'
        OR generation.safe_error_message LIKE '%DIRECTORY_STATISTICS_MISMATCH:%'
      )
      AND EXISTS (
        SELECT 1
        FROM focowiki.publication_change_facts fact
        WHERE fact.knowledge_base_id = generation.knowledge_base_id
          AND fact.generation_id = generation.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM focowiki.publication_change_facts fact
        WHERE fact.knowledge_base_id = generation.knowledge_base_id
          AND fact.generation_id = generation.id
          AND NOT (
            (
              fact.planning_payload_json ? 'preplannedImpacts'
              AND jsonb_typeof(fact.planning_payload_json -> 'preplannedImpacts') = 'array'
            )
            OR (
              fact.planning_payload_json ? 'impactPlanner'
              AND jsonb_typeof(fact.planning_payload_json -> 'impactPlanner') = 'object'
            )
          )
      )
    FOR UPDATE
  `;
  const generationIds = recoverable.map((row) => row.generation_id);
  if (generationIds.length === 0) return;

  await transaction`
    UPDATE focowiki.publication_subtasks
    SET state = 'cancelled', lease_owner = NULL, lease_token = NULL,
        lease_expires_at = NULL, completed_at = ${input.recoveredAt},
        last_error_code = 'PROJECTION_REPAIR_RECOVERY',
        last_error_message = 'Publication will be rebuilt from the repaired projection.',
        updated_at = ${input.recoveredAt}
    WHERE generation_id = ANY(${generationIds})
      AND state IN ('pending', 'running', 'retry')
  `;
  await transaction`
    DELETE FROM focowiki.publication_impact_causes cause
    USING focowiki.publication_impacts impact
    WHERE cause.impact_id = impact.id
      AND impact.generation_id = ANY(${generationIds})
  `;
  await transaction`
    DELETE FROM focowiki.publication_impacts
    WHERE generation_id = ANY(${generationIds})
  `;
  await transaction`
    UPDATE focowiki.publication_change_facts
    SET generation_id = NULL, assembly_state = 'pending',
        assembly_claimed_by = NULL, assembly_claimed_at = NULL,
        assembled_at = NULL
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND generation_id = ANY(${generationIds})
  `;
  await transaction`
    UPDATE focowiki.publication_generations
    SET state = 'superseded', failed_at = NULL,
        safe_error_code = NULL, safe_error_message = NULL,
        updated_at = ${input.recoveredAt}
    WHERE id = ANY(${generationIds})
      AND state = 'failed'
  `;
}

function mapTask(row: TaskRow): ProjectionRepairWorkItem {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    repairVersion: row.repair_version,
    targetGenerationId: row.target_generation_id,
    baseGenerationId: row.base_generation_id,
    kind: row.task_kind,
    partitionKey: row.partition_key,
    phaseOrder: row.phase_order,
    sourceWatermark: Number(row.source_watermark),
    settingsRevision: row.settings_revision,
    settings: readProjectionRepairSettingsSnapshot(row.settings_snapshot_json),
    expectedRecordCount: Number(row.expected_record_count),
    processedRecordCount: Number(row.processed_record_count),
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    checkpoint: row.checkpoint_json
  };
}

function boundedLimit(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function boundedDuration(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    throw new Error("Projection repair duration must be at least one millisecond");
  }
  return Math.round(value);
}

async function deferFinalizeForCatchUp(
  transaction: TransactionSql<Record<string, never>>,
  input: {
    taskId: string;
    scheduledAt: string;
    baseGenerationId: string;
    sourceWatermark: number;
  }
): Promise<void> {
  await transaction`
    UPDATE focowiki.projection_repair_subtasks
    SET state = 'pending',
        base_generation_id = ${input.baseGenerationId},
        source_watermark = ${input.sourceWatermark},
        processed_record_count = 0,
        checkpoint_json = '{}'::jsonb,
        attempt_count = greatest(attempt_count - 1, 0),
        run_after = ${input.scheduledAt}::timestamptz + interval '1 second',
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
        heartbeat_at = ${input.scheduledAt},
        last_error_code = NULL, last_error_message = NULL,
        updated_at = ${input.scheduledAt}
    WHERE id = ${input.taskId}
      AND state = 'running'
  `;
}

function normalizeDirectoryPath(projectionKey: string): string {
  const normalized = projectionKey.split("/").filter(Boolean).join("/");
  return normalized ? `pages/${normalized}` : "pages";
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}
