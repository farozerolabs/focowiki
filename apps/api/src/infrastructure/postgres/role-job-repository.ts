import type { RoleJobRepository } from "../../application/ports/role-job-repository.js";
import type { SerializableJson } from "../../application/ports/source-dispatch-repository.js";
import type { RoleJobKind, RoleJobRecord, RoleJobStatus } from "../../domain/role-job.js";
import type { WorkerRole } from "../../domain/generation.js";
import type { DatabaseClient } from "../../db/client.js";

type RoleJobRow = {
  id: string;
  role: WorkerRole;
  kind: RoleJobKind;
  knowledge_base_id: string;
  source_file_id: string | null;
  source_revision_id: string | null;
  generation_id: string | null;
  payload_json: SerializableJson;
  settings_snapshot_json: SerializableJson;
  status: RoleJobStatus;
  run_after: Date;
  attempt_count: number;
  max_attempts: number;
  locked_by: string | null;
  locked_at: Date | null;
  heartbeat_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export function createPostgresRoleJobRepository(
  sql: DatabaseClient
): RoleJobRepository {
  return {
    async getQueueSummary(input) {
      const rows = await sql<Array<{
        queued_count: number;
        running_count: number;
        completed_count: number;
        failed_count: number;
        dead_letter_count: number;
        oldest_queued_at: Date | null;
      }>>`
        SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued_count,
               count(*) FILTER (WHERE status = 'running')::int AS running_count,
               count(*) FILTER (WHERE status = 'completed')::int AS completed_count,
               count(*) FILTER (WHERE status = 'failed')::int AS failed_count,
               count(*) FILTER (WHERE status = 'dead_letter')::int AS dead_letter_count,
               min(created_at) FILTER (WHERE status = 'queued') AS oldest_queued_at
        FROM focowiki.role_jobs
        WHERE role = ${input.role}
          AND knowledge_base_id = ${input.knowledgeBaseId}
      `;
      const row = rows[0]!;
      const oldestQueuedAt = row.oldest_queued_at?.toISOString() ?? null;
      return {
        queuedCount: row.queued_count,
        runningCount: row.running_count,
        completedCount: row.completed_count,
        failedCount: row.failed_count,
        deadLetterCount: row.dead_letter_count,
        oldestQueuedAt,
        oldestQueuedAgeSeconds: oldestQueuedAt
          ? Math.max(0, Math.floor((Date.parse(input.now) - Date.parse(oldestQueuedAt)) / 1_000))
          : null
      };
    },

    async enqueue(input) {
      const rows = await sql<RoleJobRow[]>`
        INSERT INTO focowiki.role_jobs (
          id, role, kind, knowledge_base_id, source_file_id, source_revision_id,
          generation_id, payload_json, settings_snapshot_json, run_after,
          max_attempts, created_at, updated_at
        ) VALUES (
          ${input.id}, ${input.role}, ${input.kind}, ${input.knowledgeBaseId},
          ${input.sourceFileId}, ${input.sourceRevisionId}, ${input.generationId},
          ${sql.json(input.payload)}, ${sql.json(input.settingsSnapshot)},
          ${input.runAfter}, ${input.maxAttempts}, ${input.createdAt}, ${input.createdAt}
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING *
      `;
      if (rows[0]) {
        return mapRoleJob(rows[0]);
      }
      const existing = await sql<RoleJobRow[]>`
        SELECT * FROM focowiki.role_jobs WHERE id = ${input.id} LIMIT 1
      `;
      if (!existing[0]) {
        throw new Error("Role job enqueue did not persist a job");
      }
      return mapRoleJob(existing[0]);
    },

    async cancelSourceJobsForDeletionIntent(input) {
      const rows = await sql<Array<{ id: string }>>`
        UPDATE focowiki.role_jobs job
        SET status = 'cancelled', completed_at = ${input.cancelledAt},
            last_error_code = ${input.code},
            last_error_message = ${boundedMessage(input.message)},
            updated_at = ${input.cancelledAt}
        WHERE job.knowledge_base_id = ${input.knowledgeBaseId}
          AND job.role = 'source'
          AND job.status = 'queued'
          AND EXISTS (
            SELECT 1
            FROM focowiki.source_files source
            WHERE source.knowledge_base_id = job.knowledge_base_id
              AND source.id = job.source_file_id
              AND source.deletion_intent_id = ${input.deletionIntentId}
          )
        RETURNING job.id
      `;
      return rows.length;
    },

    async cancelKnowledgeBaseJobs(input) {
      const rows = await sql<Array<{ id: string }>>`
        UPDATE focowiki.role_jobs job
        SET status = 'cancelled', completed_at = ${input.cancelledAt},
            last_error_code = ${input.code},
            last_error_message = ${boundedMessage(input.message)},
            updated_at = ${input.cancelledAt}
        WHERE job.knowledge_base_id = ${input.knowledgeBaseId}
          AND job.status = 'queued'
          AND NOT (job.id = ANY(${input.excludeJobIds}))
        RETURNING job.id
      `;
      return rows.length;
    },

    async claim(input) {
      if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
        return [];
      }
      const rows = input.role === "publication"
        ? await claimPublicationJobs(sql, input)
        : await claimRoleJobs(sql, input);
      return rows.map(mapRoleJob);
    },

    async heartbeat(input) {
      await sql.begin(async (transaction) => {
        await transaction`
          INSERT INTO focowiki.role_heartbeats (
            worker_id, role, last_seen_at, active_job_count, metadata_json,
            created_at, updated_at
          ) VALUES (
            ${input.workerId}, ${input.role}, ${input.now}, ${input.jobIds.length},
            ${transaction.json({})}, ${input.now}, ${input.now}
          )
          ON CONFLICT (worker_id) DO UPDATE
          SET role = EXCLUDED.role,
              last_seen_at = EXCLUDED.last_seen_at,
              active_job_count = EXCLUDED.active_job_count,
              updated_at = EXCLUDED.updated_at
        `;
        if (input.jobIds.length > 0) {
          await transaction`
            UPDATE focowiki.role_jobs
            SET heartbeat_at = ${input.now}, updated_at = ${input.now}
            WHERE locked_by = ${input.workerId}
              AND status = 'running'
              AND id = ANY(${input.jobIds})
          `;
        }
      });
    },

    async complete(input) {
      await sql`
        UPDATE focowiki.role_jobs job
        SET status = CASE
            WHEN job.kind = 'generation_assembly' AND EXISTS (
              SELECT 1
              FROM focowiki.publication_change_facts fact
              WHERE fact.knowledge_base_id = job.knowledge_base_id
                AND fact.generation_id IS NULL
                AND fact.assembly_state = 'pending'
            ) THEN 'queued'
              ELSE 'completed'
            END,
            run_after = CASE
            WHEN job.kind = 'generation_assembly' AND EXISTS (
              SELECT 1
              FROM focowiki.publication_change_facts fact
              WHERE fact.knowledge_base_id = job.knowledge_base_id
                AND fact.generation_id IS NULL
                AND fact.assembly_state = 'pending'
            ) THEN ${input.completedAt}::timestamptz
              ELSE job.run_after
            END,
            attempt_count = CASE
              WHEN job.kind = 'generation_assembly' THEN 0
              ELSE job.attempt_count
            END,
            completed_at = CASE
            WHEN job.kind = 'generation_assembly' AND EXISTS (
              SELECT 1
              FROM focowiki.publication_change_facts fact
              WHERE fact.knowledge_base_id = job.knowledge_base_id
                AND fact.generation_id IS NULL
                AND fact.assembly_state = 'pending'
            ) THEN NULL
              ELSE ${input.completedAt}::timestamptz
            END,
            locked_by = NULL, locked_at = NULL, heartbeat_at = NULL,
            updated_at = ${input.completedAt}
        WHERE job.id = ${input.jobId}
          AND job.locked_by = ${input.workerId}
          AND job.status = 'running'
      `;
    },

    async retry(input) {
      await sql`
        UPDATE focowiki.role_jobs
        SET status = 'queued', run_after = ${input.runAfter},
            early_claim_on_upstream_drain = false,
            locked_by = NULL, locked_at = NULL, heartbeat_at = NULL,
            last_error_code = ${input.code}, last_error_message = ${boundedMessage(input.message)},
            updated_at = ${input.failedAt}
        WHERE id = ${input.jobId}
          AND locked_by = ${input.workerId}
          AND status = 'running'
      `;
    },

    async reschedule(input) {
      await sql`
        UPDATE focowiki.role_jobs
        SET status = 'queued', run_after = ${input.runAfter},
            early_claim_on_upstream_drain = false,
            locked_by = NULL, locked_at = NULL, heartbeat_at = NULL,
            attempt_count = greatest(0, attempt_count - 1),
            last_error_code = NULL, last_error_message = NULL,
            updated_at = ${input.rescheduledAt}
        WHERE id = ${input.jobId}
          AND locked_by = ${input.workerId}
          AND status = 'running'
      `;
    },

    async fail(input) {
      await sql`
        UPDATE focowiki.role_jobs
        SET status = 'dead_letter', failed_at = ${input.failedAt},
            locked_by = NULL, locked_at = NULL, heartbeat_at = NULL,
            last_error_code = ${input.code}, last_error_message = ${boundedMessage(input.message)},
            updated_at = ${input.failedAt}
        WHERE id = ${input.jobId}
          AND locked_by = ${input.workerId}
          AND status = 'running'
      `;
    },

    async release(input) {
      if (input.jobIds.length === 0) {
        return;
      }
      await sql`
        UPDATE focowiki.role_jobs
        SET status = 'queued', locked_by = NULL, locked_at = NULL, heartbeat_at = NULL,
            attempt_count = greatest(0, attempt_count - 1), updated_at = ${input.releasedAt}
        WHERE locked_by = ${input.workerId}
          AND status = 'running'
          AND id = ANY(${input.jobIds})
      `;
    },

    async removeHeartbeat(input) {
      await sql`
        DELETE FROM focowiki.role_heartbeats
        WHERE worker_id = ${input.workerId}
      `;
    }
  };
}

async function claimRoleJobs(
  sql: DatabaseClient,
  input: Parameters<RoleJobRepository["claim"]>[0]
): Promise<RoleJobRow[]> {
  return sql<RoleJobRow[]>`
    WITH candidates AS MATERIALIZED (
      SELECT job.id
      FROM focowiki.role_jobs job
      WHERE job.role = ${input.role}
        AND job.run_after <= ${input.now}
        AND (
          job.status = 'queued'
          OR (job.status = 'running' AND coalesce(job.heartbeat_at, job.locked_at) < ${input.staleBefore})
        )
      ORDER BY job.run_after ASC, job.created_at ASC, job.id ASC
      LIMIT ${input.limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE focowiki.role_jobs job
    SET status = 'running', locked_by = ${input.workerId}, locked_at = ${input.now},
        heartbeat_at = ${input.now}, attempt_count = job.attempt_count + 1,
        completed_at = NULL, failed_at = NULL, updated_at = ${input.now}
    FROM candidates
    WHERE job.id = candidates.id
    RETURNING job.*
  `;
}

async function claimPublicationJobs(
  sql: DatabaseClient,
  input: Parameters<RoleJobRepository["claim"]>[0]
): Promise<RoleJobRow[]> {
  return sql.begin(async (transaction) => transaction<RoleJobRow[]>`
    WITH eligible AS MATERIALIZED (
      SELECT job.id
      FROM focowiki.role_jobs job
      WHERE job.role = 'publication'
        AND (
          job.status = 'queued'
          OR (job.status = 'running' AND coalesce(job.heartbeat_at, job.locked_at) < ${input.staleBefore})
        )
        AND (
          job.run_after <= ${input.now}
          OR (
            job.kind = 'generation_publication'
            AND job.status = 'queued'
            AND job.early_claim_on_upstream_drain
            AND NOT EXISTS (
              SELECT 1
              FROM focowiki.upload_sessions upload
              WHERE upload.knowledge_base_id = job.knowledge_base_id
                AND upload.state IN (
                  'draft', 'manifest_building', 'manifest_sealed', 'uploading', 'finalizing'
                )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM focowiki.source_dispatch_markers marker
              WHERE marker.knowledge_base_id = job.knowledge_base_id
                AND marker.status IN ('pending', 'claimed')
            )
            AND NOT EXISTS (
              SELECT 1
              FROM focowiki.role_jobs upstream
              WHERE upstream.knowledge_base_id = job.knowledge_base_id
                AND upstream.status IN ('queued', 'running')
                AND (
                  upstream.role = 'source'
                  OR upstream.kind = 'generation_assembly'
                )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM focowiki.publication_change_facts fact
              WHERE fact.knowledge_base_id = job.knowledge_base_id
                AND fact.assembly_state IN ('pending', 'claimed')
            )
          )
        )
    ), ranked AS MATERIALIZED (
      SELECT job.id,
             row_number() OVER (
               PARTITION BY job.knowledge_base_id
               ORDER BY CASE WHEN job.status = 'running' THEN 0 ELSE 1 END,
                        job.run_after, job.created_at, job.id
             ) AS knowledge_base_rank
      FROM focowiki.role_jobs job
      JOIN eligible ON eligible.id = job.id
      WHERE job.role = 'publication'
    ), candidates AS MATERIALIZED (
      SELECT job.id
      FROM focowiki.role_jobs job
      JOIN ranked
        ON ranked.id = job.id
       AND ranked.knowledge_base_rank = 1
      WHERE job.role = 'publication'
        AND NOT EXISTS (
          SELECT 1
          FROM focowiki.role_jobs owner
          WHERE owner.role = 'publication'
            AND owner.knowledge_base_id = job.knowledge_base_id
            AND owner.status = 'running'
            AND owner.id <> job.id
        )
        AND pg_try_advisory_xact_lock(
          hashtextextended('focowiki:publication:' || job.knowledge_base_id, 0)
        )
      ORDER BY
        CASE WHEN job.status = 'running' THEN 0 ELSE 1 END,
        job.run_after ASC, job.created_at ASC, job.id ASC
      LIMIT ${input.limit}
      FOR UPDATE OF job SKIP LOCKED
    )
    UPDATE focowiki.role_jobs job
    SET status = 'running', locked_by = ${input.workerId}, locked_at = ${input.now},
        heartbeat_at = ${input.now}, attempt_count = job.attempt_count + 1,
        run_after = least(job.run_after, ${input.now}::timestamptz),
        completed_at = NULL, failed_at = NULL, updated_at = ${input.now}
    FROM candidates
    WHERE job.id = candidates.id
    RETURNING job.*
  `);
}

function mapRoleJob(row: RoleJobRow): RoleJobRecord {
  return {
    id: row.id,
    role: row.role,
    kind: row.kind,
    knowledgeBaseId: row.knowledge_base_id,
    sourceFileId: row.source_file_id,
    sourceRevisionId: row.source_revision_id,
    generationId: row.generation_id,
    payload: row.payload_json,
    settingsSnapshot: row.settings_snapshot_json,
    status: row.status,
    runAfter: row.run_after.toISOString(),
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    lockedBy: row.locked_by,
    lockedAt: row.locked_at?.toISOString() ?? null,
    heartbeatAt: row.heartbeat_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function boundedMessage(message: string): string {
  return message.slice(0, 2_000);
}
