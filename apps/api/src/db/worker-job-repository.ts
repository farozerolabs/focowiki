import { randomUUID } from "node:crypto";
import {
  createPublicationJobPayload,
  mergePublicationJobReason,
  parsePublicationJobPayload,
  type PublicationJobReason
} from "../domain/publication-job.js";
import {
  createSourceFileJobPayload,
  type SourceFileJobReason
} from "../domain/source-file-job.js";
import type { DatabaseClient } from "./client.js";

export type WorkerJobKind =
  | "upload_session_finalization"
  | "source_file_processing"
  | "resource_operation"
  | "publication"
  | "hard_delete";
export type WorkerJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "dead_letter"
  | "cancelled";

export type WorkerJobRecord = {
  id: string;
  kind: WorkerJobKind;
  status: WorkerJobStatus;
  knowledgeBaseId: string;
  sourceFileId: string | null;
  payload: Record<string, unknown>;
  runAfter: string;
  attemptCount: number;
  maxAttempts: number;
  lockedBy: string | null;
  lockedAt: string | null;
  heartbeatAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkerJobDraft = {
  kind: WorkerJobKind;
  knowledgeBaseId: string;
  sourceFileId?: string | null;
  payload: Record<string, unknown>;
  runAfter: string;
  maxAttempts: number;
};

export type WorkerHeartbeatRecord = {
  workerId: string;
  lastSeenAt: string;
  activeJobCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type WorkerQueueSummary = {
  queuedCount: number;
  runningCount: number;
  completedCount: number;
  failedCount: number;
  deadLetterCount: number;
  cancelledCount?: number;
  oldestQueuedAt: string | null;
  oldestQueuedAgeSeconds: number | null;
};

export type WorkerJobRepository = {
  enqueueWorkerJob: (input: WorkerJobDraft) => Promise<WorkerJobRecord>;
  enqueueSourceFileJob: (input: {
    knowledgeBaseId: string;
    sourceFileId: string;
    reason: SourceFileJobReason;
    runAfter: string;
    maxAttempts: number;
  }) => Promise<WorkerJobRecord>;
  enqueueUploadSessionFinalizationJob?: (input: {
    knowledgeBaseId: string;
    sessionId: string;
    runAfter: string;
    maxAttempts: number;
  }) => Promise<WorkerJobRecord>;
  enqueuePublicationJob: (input: {
    knowledgeBaseId: string;
    reason: PublicationJobReason;
    targetCatalogGeneration: number;
    runAfter: string;
    maxAttempts: number;
    forceSuccessor?: boolean | undefined;
  }) => Promise<WorkerJobRecord>;
  enqueueResourceOperationJob?: (input: {
    knowledgeBaseId: string;
    operationId: string;
    runAfter: string;
    maxAttempts: number;
  }) => Promise<WorkerJobRecord>;
  enqueueHardDeleteJob?: (input: {
    knowledgeBaseId: string;
    targetKind: "source_file" | "source_directory" | "knowledge_base";
    sourceFileId?: string | null;
    sourceDirectoryId?: string | null;
    deletionIntentId?: string | null;
    reason: string;
    runAfter: string;
    maxAttempts: number;
  }) => Promise<WorkerJobRecord>;
  claimWorkerJobs: (input: {
    workerId: string;
    kinds: WorkerJobKind[];
    limit: number;
    now: string;
    staleBefore: string;
  }) => Promise<WorkerJobRecord[]>;
  completeWorkerJob: (input: {
    id: string;
    workerId: string;
    completedAt: string;
  }) => Promise<WorkerJobRecord | null>;
  failWorkerJob: (input: {
    id: string;
    workerId: string;
    failedAt: string;
    errorCode: string;
    errorMessage: string;
    retryAfter: string | null;
  }) => Promise<WorkerJobRecord | null>;
  deadLetterWorkerJob: (input: {
    id: string;
    workerId: string;
    failedAt: string;
    errorCode: string;
    errorMessage: string;
  }) => Promise<WorkerJobRecord | null>;
  cancelQueuedSourceFileJobs?: (input: {
    knowledgeBaseId: string;
    sourceFileIds: string[];
    cancelledAt: string;
    errorCode: string;
    errorMessage: string;
  }) => Promise<string[]>;
  cancelQueuedSourceDirectoryJobs?: (input: {
    knowledgeBaseId: string;
    deletionIntentId: string;
    cancelledAt: string;
    errorCode: string;
    errorMessage: string;
  }) => Promise<string[]>;
  cancelQueuedKnowledgeBaseJobs?: (input: {
    knowledgeBaseId: string;
    excludedJobIds?: string[];
    cancelledAt: string;
    errorCode: string;
    errorMessage: string;
  }) => Promise<string[]>;
  releaseWorkerJob: (input: {
    id: string;
    workerId: string;
    releasedAt: string;
    runAfter?: string | null;
    preserveAttempt?: boolean;
  }) => Promise<WorkerJobRecord | null>;
  heartbeatWorkerJob: (input: {
    id: string;
    workerId: string;
    heartbeatAt: string;
  }) => Promise<WorkerJobRecord | null>;
  recordWorkerHeartbeat: (input: {
    workerId: string;
    lastSeenAt: string;
    activeJobCount: number;
    metadata?: Record<string, unknown>;
  }) => Promise<WorkerHeartbeatRecord>;
  listWorkerHeartbeats: (input: {
    seenAfter?: string | null;
    limit: number;
  }) => Promise<WorkerHeartbeatRecord[]>;
  getWorkerQueueSummary: (input: {
    kinds?: WorkerJobKind[];
    knowledgeBaseId?: string | null;
    now: string;
  }) => Promise<WorkerQueueSummary>;
  cleanupWorkerJobs: (input: {
    completedBefore: string;
    failedBefore: string;
    deadLetterBefore: string;
    cancelledBefore?: string;
    limit: number;
  }) => Promise<number>;
  countActiveWorkerJobs: (input: {
    kinds?: WorkerJobKind[];
    knowledgeBaseId?: string | null;
  }) => Promise<number>;
};

type WorkerJobRow = {
  id: string;
  kind: WorkerJobKind;
  status: WorkerJobStatus;
  knowledge_base_id: string;
  source_file_id: string | null;
  payload_json: unknown;
  run_after: Date;
  attempt_count: number;
  max_attempts: number;
  locked_by: string | null;
  locked_at: Date | null;
  heartbeat_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  failed_at: Date | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: Date;
  updated_at: Date;
};

type WorkerHeartbeatRow = {
  worker_id: string;
  last_seen_at: Date;
  active_job_count: number;
  metadata_json: unknown;
  created_at: Date;
  updated_at: Date;
};

export function createPostgresWorkerJobRepository(sql: DatabaseClient): WorkerJobRepository {
  return {
    async enqueueWorkerJob(input) {
      const rows = await sql<WorkerJobRow[]>`
        INSERT INTO focowiki.worker_jobs (
          id,
          kind,
          knowledge_base_id,
          source_file_id,
          payload_json,
          run_after,
          max_attempts
        )
        VALUES (
          ${createWorkerJobId()},
          ${input.kind},
          ${input.knowledgeBaseId},
          ${input.sourceFileId ?? null},
          ${sql.json(input.payload as never)},
          ${input.runAfter},
          ${input.maxAttempts}
        )
        RETURNING *
      `;
      return mapWorkerJobRow(requireWorkerJobRow(rows));
    },
    async enqueueSourceFileJob(input) {
      const rows = await sql<WorkerJobRow[]>`
        INSERT INTO focowiki.worker_jobs (
          id,
          kind,
          knowledge_base_id,
          source_file_id,
          payload_json,
          run_after,
          max_attempts
        )
        SELECT
          ${createWorkerJobId()},
          'source_file_processing',
          ${input.knowledgeBaseId},
          ${input.sourceFileId},
          ${sql.json(createSourceFileJobPayload(input.reason) as never)},
          ${input.runAfter},
          ${input.maxAttempts}
        WHERE NOT EXISTS (
          SELECT 1
          FROM focowiki.worker_jobs
          WHERE kind = 'source_file_processing'
            AND source_file_id = ${input.sourceFileId}
            AND status IN ('queued', 'running')
        )
        RETURNING *
      `;

      if (rows[0]) {
        return mapWorkerJobRow(rows[0]);
      }

      const existing = await sql<WorkerJobRow[]>`
        SELECT *
        FROM focowiki.worker_jobs
        WHERE kind = 'source_file_processing'
          AND source_file_id = ${input.sourceFileId}
          AND status IN ('queued', 'running')
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `;
      return mapWorkerJobRow(requireWorkerJobRow(existing));
    },
    async enqueueUploadSessionFinalizationJob(input) {
      const payload = { sessionId: input.sessionId };
      const rows = await sql<WorkerJobRow[]>`
        INSERT INTO focowiki.worker_jobs (
          id, kind, knowledge_base_id, source_file_id, payload_json, run_after, max_attempts
        )
        SELECT ${createWorkerJobId()}, 'upload_session_finalization',
               ${input.knowledgeBaseId}, NULL, ${sql.json(payload as never)},
               ${input.runAfter}, ${input.maxAttempts}
        WHERE NOT EXISTS (
          SELECT 1
          FROM focowiki.worker_jobs
          WHERE kind = 'upload_session_finalization'
            AND knowledge_base_id = ${input.knowledgeBaseId}
            AND payload_json->>'sessionId' = ${input.sessionId}
            AND status IN ('queued', 'running')
        )
        RETURNING *
      `;
      if (rows[0]) return mapWorkerJobRow(rows[0]);
      const existing = await sql<WorkerJobRow[]>`
        SELECT *
        FROM focowiki.worker_jobs
        WHERE kind = 'upload_session_finalization'
          AND knowledge_base_id = ${input.knowledgeBaseId}
          AND payload_json->>'sessionId' = ${input.sessionId}
          AND status IN ('queued', 'running')
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `;
      return mapWorkerJobRow(requireWorkerJobRow(existing));
    },
    async enqueuePublicationJob(input) {
      const requestedPayload = createPublicationJobPayload(
        input.reason,
        input.targetCatalogGeneration
      );

      return sql.begin(async (transaction) => {
        const knowledgeBases = await transaction<Array<{ catalog_generation: number }>>`
          SELECT catalog_generation
          FROM focowiki.knowledge_bases
          WHERE id = ${input.knowledgeBaseId}
          FOR UPDATE
        `;
        const catalogGeneration = knowledgeBases[0]?.catalog_generation;
        if (catalogGeneration === undefined) {
          throw new Error("Knowledge base does not exist.");
        }
        if (requestedPayload.targetCatalogGeneration > catalogGeneration) {
          throw new Error("Publication target exceeds the committed catalog generation.");
        }

        const queued = await transaction<WorkerJobRow[]>`
          SELECT *
          FROM focowiki.worker_jobs
          WHERE kind = 'publication'
            AND knowledge_base_id = ${input.knowledgeBaseId}
            AND status = 'queued'
          ORDER BY run_after ASC, created_at ASC, id ASC
          LIMIT 1
          FOR UPDATE
        `;
        if (queued[0]) {
          const existingPayload = parsePublicationJobPayload(queued[0].payload_json);
          const promotedPayload = createPublicationJobPayload(
            mergePublicationJobReason(existingPayload.reason, requestedPayload.reason),
            Math.max(
              existingPayload.targetCatalogGeneration,
              requestedPayload.targetCatalogGeneration
            )
          );
          const promoted = await transaction<WorkerJobRow[]>`
            UPDATE focowiki.worker_jobs
            SET payload_json = ${transaction.json(promotedPayload as never)},
                run_after = LEAST(run_after, ${input.runAfter}),
                max_attempts = GREATEST(max_attempts, ${input.maxAttempts}),
                updated_at = now()
            WHERE id = ${queued[0].id}
              AND status = 'queued'
            RETURNING *
          `;
          return mapWorkerJobRow(requireWorkerJobRow(promoted));
        }

        const running = await transaction<WorkerJobRow[]>`
          SELECT *
          FROM focowiki.worker_jobs
          WHERE kind = 'publication'
            AND knowledge_base_id = ${input.knowledgeBaseId}
            AND status = 'running'
          ORDER BY created_at ASC, id ASC
          LIMIT 1
          FOR UPDATE
        `;
        if (running[0]) {
          const runningPayload = parsePublicationJobPayload(running[0].payload_json);
          if (
            !input.forceSuccessor &&
            runningPayload.targetCatalogGeneration
            >= requestedPayload.targetCatalogGeneration
          ) {
            return mapWorkerJobRow(running[0]);
          }
        }

        const inserted = await transaction<WorkerJobRow[]>`
          INSERT INTO focowiki.worker_jobs (
            id,
            kind,
            knowledge_base_id,
            source_file_id,
            payload_json,
            run_after,
            max_attempts
          )
          SELECT
            ${createWorkerJobId()},
            'publication',
            ${input.knowledgeBaseId},
            NULL,
            ${transaction.json(requestedPayload as never)},
            ${input.runAfter},
            ${input.maxAttempts}
          WHERE NOT EXISTS (
            SELECT 1
            FROM focowiki.worker_jobs
            WHERE kind = 'publication'
              AND knowledge_base_id = ${input.knowledgeBaseId}
              AND status IN ('queued', 'running')
              AND status = 'queued'
          )
          RETURNING *
        `;
        return mapWorkerJobRow(requireWorkerJobRow(inserted));
      });
    },
    async enqueueResourceOperationJob(input) {
      const payload = { operationId: input.operationId };
      const rows = await sql<WorkerJobRow[]>`
        INSERT INTO focowiki.worker_jobs (
          id, kind, knowledge_base_id, source_file_id, payload_json, run_after, max_attempts
        )
        SELECT
          ${createWorkerJobId()}, 'resource_operation', ${input.knowledgeBaseId}, NULL,
          ${sql.json(payload as never)}, ${input.runAfter}, ${input.maxAttempts}
        WHERE NOT EXISTS (
          SELECT 1
          FROM focowiki.worker_jobs
          WHERE kind = 'resource_operation'
            AND knowledge_base_id = ${input.knowledgeBaseId}
            AND payload_json->>'operationId' = ${input.operationId}
            AND status IN ('queued', 'running')
        )
        RETURNING *
      `;
      if (rows[0]) return mapWorkerJobRow(rows[0]);
      const existing = await sql<WorkerJobRow[]>`
        SELECT *
        FROM focowiki.worker_jobs
        WHERE kind = 'resource_operation'
          AND knowledge_base_id = ${input.knowledgeBaseId}
          AND payload_json->>'operationId' = ${input.operationId}
          AND status IN ('queued', 'running')
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `;
      return mapWorkerJobRow(requireWorkerJobRow(existing));
    },
    async enqueueHardDeleteJob(input) {
      const payload = {
        targetKind: input.targetKind,
        reason: input.reason,
        ...(input.sourceFileId ? { sourceFileId: input.sourceFileId } : {}),
        ...(input.sourceDirectoryId ? { sourceDirectoryId: input.sourceDirectoryId } : {}),
        ...(input.deletionIntentId ? { deletionIntentId: input.deletionIntentId } : {})
      };
      const rows = await sql<WorkerJobRow[]>`
        INSERT INTO focowiki.worker_jobs (
          id,
          kind,
          knowledge_base_id,
          source_file_id,
          payload_json,
          run_after,
          max_attempts
        )
        SELECT
          ${createWorkerJobId()},
          'hard_delete',
          ${input.knowledgeBaseId},
          NULL,
          ${sql.json(payload as never)},
          ${input.runAfter},
          ${input.maxAttempts}
        WHERE NOT EXISTS (
          SELECT 1
          FROM focowiki.worker_jobs
          WHERE kind = 'hard_delete'
            AND knowledge_base_id = ${input.knowledgeBaseId}
            AND status IN ('queued', 'running')
            AND (
              (
                payload_json->>'targetKind' = 'knowledge_base'
                AND ${input.targetKind} = 'knowledge_base'
              )
              OR (
                payload_json->>'targetKind' = 'source_file'
                AND payload_json->>'sourceFileId' = ${input.sourceFileId ?? ""}
                AND ${input.targetKind} = 'source_file'
              )
              OR (
                payload_json->>'targetKind' = 'source_directory'
                AND payload_json->>'deletionIntentId' = ${input.deletionIntentId ?? ""}
                AND ${input.targetKind} = 'source_directory'
              )
            )
        )
        RETURNING *
      `;

      if (rows[0]) {
        return mapWorkerJobRow(rows[0]);
      }

      const existing = await sql<WorkerJobRow[]>`
        SELECT *
        FROM focowiki.worker_jobs
        WHERE kind = 'hard_delete'
          AND knowledge_base_id = ${input.knowledgeBaseId}
          AND status IN ('queued', 'running')
          AND (
            (
              payload_json->>'targetKind' = 'knowledge_base'
              AND ${input.targetKind} = 'knowledge_base'
            )
            OR (
              payload_json->>'targetKind' = 'source_file'
              AND payload_json->>'sourceFileId' = ${input.sourceFileId ?? ""}
              AND ${input.targetKind} = 'source_file'
            )
            OR (
              payload_json->>'targetKind' = 'source_directory'
              AND payload_json->>'deletionIntentId' = ${input.deletionIntentId ?? ""}
              AND ${input.targetKind} = 'source_directory'
            )
          )
        ORDER BY run_after ASC, created_at ASC, id ASC
        LIMIT 1
      `;
      return mapWorkerJobRow(requireWorkerJobRow(existing));
    },
    async claimWorkerJobs(input) {
      if (input.limit <= 0 || input.kinds.length === 0) {
        return [];
      }

      const rows = await sql<WorkerJobRow[]>`
        WITH candidates AS (
          SELECT id
          FROM focowiki.worker_jobs candidate
          WHERE kind = ANY(${input.kinds})
            AND run_after <= ${input.now}
            AND (
              status = 'queued'
              OR (
                status = 'running'
                AND locked_at IS NOT NULL
                AND COALESCE(heartbeat_at, locked_at) < ${input.staleBefore}
              )
            )
            AND (
              kind <> 'publication'
              OR status = 'running'
              OR NOT EXISTS (
                SELECT 1
                FROM focowiki.worker_jobs running_publication
                WHERE running_publication.kind = 'publication'
                  AND running_publication.knowledge_base_id = candidate.knowledge_base_id
                  AND running_publication.status = 'running'
              )
            )
          ORDER BY run_after ASC, created_at ASC, id ASC
          LIMIT ${input.limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE focowiki.worker_jobs job
        SET
          status = 'running',
          locked_by = ${input.workerId},
          locked_at = ${input.now},
          heartbeat_at = ${input.now},
          started_at = COALESCE(job.started_at, ${input.now}),
          attempt_count = job.attempt_count + 1,
          updated_at = now()
        FROM candidates
        WHERE job.id = candidates.id
        RETURNING job.*
      `;

      return rows.map(mapWorkerJobRow);
    },
    async completeWorkerJob(input) {
      const rows = await sql<WorkerJobRow[]>`
        UPDATE focowiki.worker_jobs
        SET
          status = 'completed',
          locked_by = NULL,
          locked_at = NULL,
          heartbeat_at = NULL,
          completed_at = ${input.completedAt},
          failed_at = NULL,
          last_error_code = NULL,
          last_error_message = NULL,
          updated_at = now()
        WHERE id = ${input.id}
          AND locked_by = ${input.workerId}
          AND status = 'running'
        RETURNING *
      `;
      return rows[0] ? mapWorkerJobRow(rows[0]) : null;
    },
    async failWorkerJob(input) {
      const willRetry = input.retryAfter !== null;
      if (willRetry) {
        const transition = await transitionRunningPublicationJob(sql, {
          id: input.id,
          workerId: input.workerId,
          transitionAt: input.failedAt,
          runAfter: input.retryAfter!,
          preserveAttempt: false,
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          terminalStatus: "failed"
        });
        if (transition.handled) {
          return transition.record;
        }
      }
      const rows = await sql<WorkerJobRow[]>`
        UPDATE focowiki.worker_jobs
        SET
          status = ${willRetry ? "queued" : "failed"},
          run_after = COALESCE(${input.retryAfter}, run_after),
          locked_by = NULL,
          locked_at = NULL,
          heartbeat_at = NULL,
          failed_at = ${willRetry ? null : input.failedAt},
          last_error_code = ${input.errorCode},
          last_error_message = ${input.errorMessage},
          updated_at = now()
        WHERE id = ${input.id}
          AND locked_by = ${input.workerId}
          AND status = 'running'
        RETURNING *
      `;
      return rows[0] ? mapWorkerJobRow(rows[0]) : null;
    },
    async deadLetterWorkerJob(input) {
      const rows = await sql<WorkerJobRow[]>`
        UPDATE focowiki.worker_jobs
        SET
          status = 'dead_letter',
          locked_by = NULL,
          locked_at = NULL,
          heartbeat_at = NULL,
          failed_at = ${input.failedAt},
          last_error_code = ${input.errorCode},
          last_error_message = ${input.errorMessage},
          updated_at = now()
        WHERE id = ${input.id}
          AND locked_by = ${input.workerId}
          AND status = 'running'
        RETURNING *
      `;
      return rows[0] ? mapWorkerJobRow(rows[0]) : null;
    },
    async cancelQueuedSourceFileJobs(input) {
      if (input.sourceFileIds.length === 0) {
        return [];
      }

      const rows = await sql<Array<{ source_file_id: string }>>`
        UPDATE focowiki.worker_jobs
        SET
          status = 'cancelled',
          locked_by = NULL,
          locked_at = NULL,
          heartbeat_at = NULL,
          completed_at = GREATEST(${input.cancelledAt}, COALESCE(started_at, ${input.cancelledAt})),
          failed_at = NULL,
          last_error_code = ${input.errorCode},
          last_error_message = ${input.errorMessage},
          updated_at = now()
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND kind = 'source_file_processing'
          AND source_file_id = ANY(${input.sourceFileIds})
          AND status = 'queued'
        RETURNING source_file_id
      `;
      return rows
        .map((row) => row.source_file_id)
        .filter((sourceFileId): sourceFileId is string => Boolean(sourceFileId));
    },
    async cancelQueuedSourceDirectoryJobs(input) {
      const rows = await sql<Array<{ source_file_id: string }>>`
        UPDATE focowiki.worker_jobs job
        SET status = 'cancelled',
            locked_by = NULL,
            locked_at = NULL,
            heartbeat_at = NULL,
            completed_at = GREATEST(${input.cancelledAt}, COALESCE(started_at, ${input.cancelledAt})),
            failed_at = NULL,
            last_error_code = ${input.errorCode},
            last_error_message = ${input.errorMessage},
            updated_at = now()
        WHERE job.knowledge_base_id = ${input.knowledgeBaseId}
          AND job.kind = 'source_file_processing'
          AND job.status = 'queued'
          AND job.source_file_id IN (
            SELECT source.id
            FROM focowiki.source_files source
            WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
              AND source.deletion_intent_id = ${input.deletionIntentId}
          )
        RETURNING job.source_file_id
      `;
      return rows.map((row) => row.source_file_id).filter(Boolean);
    },
    async cancelQueuedKnowledgeBaseJobs(input) {
      const excludedJobIds = input.excludedJobIds ?? [];
      const excludedFilter =
        excludedJobIds.length > 0 ? sql`AND NOT (id = ANY(${excludedJobIds}))` : sql``;
      const rows = await sql<Array<{ id: string }>>`
        UPDATE focowiki.worker_jobs
        SET
          status = 'cancelled',
          locked_by = NULL,
          locked_at = NULL,
          heartbeat_at = NULL,
          completed_at = GREATEST(${input.cancelledAt}, COALESCE(started_at, ${input.cancelledAt})),
          failed_at = NULL,
          last_error_code = ${input.errorCode},
          last_error_message = ${input.errorMessage},
          updated_at = now()
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          ${excludedFilter}
          AND status = 'queued'
          AND (
            kind IN ('upload_session_finalization', 'source_file_processing', 'resource_operation', 'publication')
            OR (
              kind = 'hard_delete'
              AND COALESCE(payload_json->>'targetKind', '') <> 'knowledge_base'
            )
          )
        RETURNING id
      `;
      return rows.map((row) => row.id);
    },
    async releaseWorkerJob(input) {
      const transition = await transitionRunningPublicationJob(sql, {
        id: input.id,
        workerId: input.workerId,
        transitionAt: input.releasedAt,
        runAfter: input.runAfter ?? input.releasedAt,
        preserveAttempt: input.preserveAttempt ?? false,
        errorCode: null,
        errorMessage: null,
        terminalStatus: "cancelled"
      });
      if (transition.handled) {
        return transition.record;
      }
      const rows = await sql<WorkerJobRow[]>`
        UPDATE focowiki.worker_jobs
        SET
          status = 'queued',
          run_after = COALESCE(${input.runAfter ?? null}, run_after),
          locked_by = NULL,
          locked_at = NULL,
          heartbeat_at = NULL,
          attempt_count = CASE
            WHEN ${input.preserveAttempt ?? false} THEN GREATEST(attempt_count - 1, 0)
            ELSE attempt_count
          END,
          updated_at = ${input.releasedAt}
        WHERE id = ${input.id}
          AND locked_by = ${input.workerId}
          AND status = 'running'
        RETURNING *
      `;
      return rows[0] ? mapWorkerJobRow(rows[0]) : null;
    },
    async heartbeatWorkerJob(input) {
      const rows = await sql<WorkerJobRow[]>`
        UPDATE focowiki.worker_jobs
        SET
          heartbeat_at = ${input.heartbeatAt},
          updated_at = now()
        WHERE id = ${input.id}
          AND locked_by = ${input.workerId}
          AND status = 'running'
        RETURNING *
      `;
      return rows[0] ? mapWorkerJobRow(rows[0]) : null;
    },
    async recordWorkerHeartbeat(input) {
      const rows = await sql<WorkerHeartbeatRow[]>`
        INSERT INTO focowiki.worker_heartbeats (
          worker_id,
          last_seen_at,
          active_job_count,
          metadata_json
        )
        VALUES (
          ${input.workerId},
          ${input.lastSeenAt},
          ${input.activeJobCount},
          ${sql.json((input.metadata ?? {}) as never)}
        )
        ON CONFLICT (worker_id)
        DO UPDATE SET
          last_seen_at = EXCLUDED.last_seen_at,
          active_job_count = EXCLUDED.active_job_count,
          metadata_json = EXCLUDED.metadata_json,
          updated_at = now()
        RETURNING *
      `;
      return mapWorkerHeartbeatRow(requireWorkerHeartbeatRow(rows));
    },
    async listWorkerHeartbeats(input) {
      const limit = Math.max(1, input.limit);
      const rows = input.seenAfter
        ? await sql<WorkerHeartbeatRow[]>`
            SELECT *
            FROM focowiki.worker_heartbeats
            WHERE last_seen_at >= ${input.seenAfter}
            ORDER BY last_seen_at DESC, worker_id ASC
            LIMIT ${limit}
          `
        : await sql<WorkerHeartbeatRow[]>`
            SELECT *
            FROM focowiki.worker_heartbeats
            ORDER BY last_seen_at DESC, worker_id ASC
            LIMIT ${limit}
          `;
      return rows.map(mapWorkerHeartbeatRow);
    },
    async getWorkerQueueSummary(input) {
      const rows =
        input.kinds && input.kinds.length > 0
          ? input.knowledgeBaseId
            ? await sql<Array<{ status: WorkerJobStatus; count: string | number }>>`
                SELECT status, sum(job_count) AS count
                FROM focowiki.worker_queue_summaries
                WHERE kind = ANY(${input.kinds})
                  AND knowledge_base_id = ${input.knowledgeBaseId}
                GROUP BY status
              `
            : await sql<Array<{ status: WorkerJobStatus; count: string | number }>>`
                SELECT status, sum(job_count) AS count
                FROM focowiki.worker_queue_summaries
                WHERE kind = ANY(${input.kinds})
                GROUP BY status
              `
          : input.knowledgeBaseId
            ? await sql<Array<{ status: WorkerJobStatus; count: string | number }>>`
                SELECT status, sum(job_count) AS count
                FROM focowiki.worker_queue_summaries
                WHERE knowledge_base_id = ${input.knowledgeBaseId}
                GROUP BY status
              `
            : await sql<Array<{ status: WorkerJobStatus; count: string | number }>>`
                SELECT status, sum(job_count) AS count
                FROM focowiki.worker_queue_summaries
                GROUP BY status
              `;
      const oldestRows =
        input.kinds && input.kinds.length > 0
          ? input.knowledgeBaseId
            ? await sql<Array<{ oldest_queued_at: Date | null }>>`
                SELECT min(run_after) AS oldest_queued_at
                FROM focowiki.worker_jobs
                WHERE kind = ANY(${input.kinds})
                  AND knowledge_base_id = ${input.knowledgeBaseId}
                  AND status = 'queued'
              `
            : await sql<Array<{ oldest_queued_at: Date | null }>>`
                SELECT min(run_after) AS oldest_queued_at
                FROM focowiki.worker_jobs
                WHERE kind = ANY(${input.kinds})
                  AND status = 'queued'
              `
          : input.knowledgeBaseId
            ? await sql<Array<{ oldest_queued_at: Date | null }>>`
                SELECT min(run_after) AS oldest_queued_at
                FROM focowiki.worker_jobs
                WHERE knowledge_base_id = ${input.knowledgeBaseId}
                  AND status = 'queued'
              `
            : await sql<Array<{ oldest_queued_at: Date | null }>>`
                SELECT min(run_after) AS oldest_queued_at
                FROM focowiki.worker_jobs
                WHERE status = 'queued'
              `;
      return createQueueSummary({
        rows,
        oldestQueuedAt: oldestRows[0]?.oldest_queued_at ?? null,
        now: input.now
      });
    },
    async cleanupWorkerJobs(input) {
      if (input.limit <= 0) {
        return 0;
      }

      const rows = await sql<Array<{ id: string }>>`
        WITH expired AS (
          SELECT id
          FROM focowiki.worker_jobs
          WHERE (
              status = 'completed'
              AND completed_at IS NOT NULL
              AND completed_at < ${input.completedBefore}
            )
            OR (
              status = 'failed'
              AND failed_at IS NOT NULL
              AND failed_at < ${input.failedBefore}
            )
            OR (
              status = 'dead_letter'
              AND failed_at IS NOT NULL
              AND failed_at < ${input.deadLetterBefore}
            )
            OR (
              status = 'cancelled'
              AND completed_at IS NOT NULL
              AND completed_at < ${input.cancelledBefore ?? input.completedBefore}
            )
          ORDER BY COALESCE(completed_at, failed_at, created_at) ASC, id ASC
          LIMIT ${input.limit}
        )
        DELETE FROM focowiki.worker_jobs job
        USING expired
        WHERE job.id = expired.id
        RETURNING job.id
      `;
      return rows.length;
    },
    async countActiveWorkerJobs(input) {
      const rows =
        input.kinds && input.kinds.length > 0
          ? input.knowledgeBaseId
            ? await sql<Array<{ count: string | number }>>`
                SELECT count(*) AS count
                FROM focowiki.worker_jobs
                WHERE kind = ANY(${input.kinds})
                  AND knowledge_base_id = ${input.knowledgeBaseId}
                  AND status IN ('queued', 'running')
              `
            : await sql<Array<{ count: string | number }>>`
                SELECT count(*) AS count
                FROM focowiki.worker_jobs
                WHERE kind = ANY(${input.kinds})
                  AND status IN ('queued', 'running')
              `
          : input.knowledgeBaseId
            ? await sql<Array<{ count: string | number }>>`
                SELECT count(*) AS count
                FROM focowiki.worker_jobs
                WHERE knowledge_base_id = ${input.knowledgeBaseId}
                  AND status IN ('queued', 'running')
              `
            : await sql<Array<{ count: string | number }>>`
                SELECT count(*) AS count
                FROM focowiki.worker_jobs
                WHERE status IN ('queued', 'running')
              `;
      return Number(rows[0]?.count ?? 0);
    }
  };
}

async function transitionRunningPublicationJob(
  sql: DatabaseClient,
  input: {
    id: string;
    workerId: string;
    transitionAt: string;
    runAfter: string;
    preserveAttempt: boolean;
    errorCode: string | null;
    errorMessage: string | null;
    terminalStatus: "failed" | "cancelled";
  }
): Promise<{ handled: boolean; record: WorkerJobRecord | null }> {
  const candidates = await sql<Array<{ kind: WorkerJobKind; knowledge_base_id: string }>>`
    SELECT kind, knowledge_base_id
    FROM focowiki.worker_jobs
    WHERE id = ${input.id}
      AND locked_by = ${input.workerId}
      AND status = 'running'
    LIMIT 1
  `;
  const candidate = candidates[0];
  if (!candidate || candidate.kind !== "publication") {
    return { handled: false, record: null };
  }

  return sql.begin(async (transaction) => {
    await transaction`
      SELECT id
      FROM focowiki.knowledge_bases
      WHERE id = ${candidate.knowledge_base_id}
      FOR UPDATE
    `;
    const running = await transaction<WorkerJobRow[]>`
      SELECT *
      FROM focowiki.worker_jobs
      WHERE id = ${input.id}
        AND kind = 'publication'
        AND locked_by = ${input.workerId}
        AND status = 'running'
      FOR UPDATE
    `;
    if (!running[0]) {
      return { handled: true, record: null };
    }

    const queued = await transaction<WorkerJobRow[]>`
      SELECT *
      FROM focowiki.worker_jobs
      WHERE kind = 'publication'
        AND knowledge_base_id = ${candidate.knowledge_base_id}
        AND status = 'queued'
      ORDER BY run_after ASC, created_at ASC, id ASC
      LIMIT 1
      FOR UPDATE
    `;

    if (!queued[0]) {
      const requeued = await transaction<WorkerJobRow[]>`
        UPDATE focowiki.worker_jobs
        SET status = 'queued',
            run_after = LEAST(run_after, ${input.runAfter}),
            locked_by = NULL,
            locked_at = NULL,
            heartbeat_at = NULL,
            attempt_count = CASE
              WHEN ${input.preserveAttempt} THEN GREATEST(attempt_count - 1, 0)
              ELSE attempt_count
            END,
            failed_at = NULL,
            last_error_code = ${input.errorCode},
            last_error_message = ${input.errorMessage},
            updated_at = ${input.transitionAt}
        WHERE id = ${input.id}
          AND locked_by = ${input.workerId}
          AND status = 'running'
        RETURNING *
      `;
      return {
        handled: true,
        record: requeued[0] ? mapWorkerJobRow(requeued[0]) : null
      };
    }

    const runningPayload = parsePublicationJobPayload(running[0].payload_json);
    const queuedPayload = parsePublicationJobPayload(queued[0].payload_json);
    const mergedPayload = createPublicationJobPayload(
      mergePublicationJobReason(queuedPayload.reason, runningPayload.reason),
      Math.max(
        queuedPayload.targetCatalogGeneration,
        runningPayload.targetCatalogGeneration
      )
    );
    const successor = await transaction<WorkerJobRow[]>`
      UPDATE focowiki.worker_jobs
      SET payload_json = ${transaction.json(mergedPayload as never)},
          run_after = LEAST(run_after, ${input.runAfter}),
          max_attempts = GREATEST(max_attempts, ${running[0].max_attempts}),
          updated_at = ${input.transitionAt}
      WHERE id = ${queued[0].id}
        AND status = 'queued'
      RETURNING *
    `;
    await transaction`
      UPDATE focowiki.worker_jobs
      SET status = ${input.terminalStatus},
          locked_by = NULL,
          locked_at = NULL,
          heartbeat_at = NULL,
          completed_at = CASE
            WHEN ${input.terminalStatus === "cancelled"}
              THEN GREATEST(${input.transitionAt}, COALESCE(started_at, ${input.transitionAt}))
            ELSE NULL
          END,
          failed_at = CASE
            WHEN ${input.terminalStatus === "failed"}
              THEN GREATEST(${input.transitionAt}, COALESCE(started_at, ${input.transitionAt}))
            ELSE NULL
          END,
          last_error_code = ${input.errorCode},
          last_error_message = ${input.errorMessage},
          updated_at = ${input.transitionAt}
      WHERE id = ${input.id}
        AND locked_by = ${input.workerId}
        AND status = 'running'
    `;
    return {
      handled: true,
      record: successor[0] ? mapWorkerJobRow(successor[0]) : null
    };
  });
}

function createWorkerJobId(): string {
  return `worker-job-${randomUUID()}`;
}

function requireWorkerJobRow(rows: WorkerJobRow[]): WorkerJobRow {
  const row = rows[0];

  if (!row) {
    throw new Error("Worker job operation did not return a row");
  }

  return row;
}

function requireWorkerHeartbeatRow(rows: WorkerHeartbeatRow[]): WorkerHeartbeatRow {
  const row = rows[0];

  if (!row) {
    throw new Error("Worker heartbeat operation did not return a row");
  }

  return row;
}

function mapWorkerJobRow(row: WorkerJobRow): WorkerJobRecord {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    knowledgeBaseId: row.knowledge_base_id,
    sourceFileId: row.source_file_id,
    payload: isRecord(row.payload_json) ? row.payload_json : {},
    runAfter: row.run_after.toISOString(),
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    lockedBy: row.locked_by,
    lockedAt: row.locked_at?.toISOString() ?? null,
    heartbeatAt: row.heartbeat_at?.toISOString() ?? null,
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    failedAt: row.failed_at?.toISOString() ?? null,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapWorkerHeartbeatRow(row: WorkerHeartbeatRow): WorkerHeartbeatRecord {
  return {
    workerId: row.worker_id,
    lastSeenAt: row.last_seen_at.toISOString(),
    activeJobCount: Number(row.active_job_count),
    metadata: isRecord(row.metadata_json) ? row.metadata_json : {},
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function createQueueSummary(input: {
  rows: Array<{ status: WorkerJobStatus; count: string | number }>;
  oldestQueuedAt: Date | null;
  now: string;
}): WorkerQueueSummary {
  const countByStatus = new Map(
    input.rows.map((row) => [row.status, Number(row.count)] as const)
  );
  const oldestQueuedAt = input.oldestQueuedAt?.toISOString() ?? null;
  const nowMs = Date.parse(input.now);
  const oldestMs = oldestQueuedAt ? Date.parse(oldestQueuedAt) : NaN;

  return {
    queuedCount: countByStatus.get("queued") ?? 0,
    runningCount: countByStatus.get("running") ?? 0,
    completedCount: countByStatus.get("completed") ?? 0,
    failedCount: countByStatus.get("failed") ?? 0,
    deadLetterCount: countByStatus.get("dead_letter") ?? 0,
    cancelledCount: countByStatus.get("cancelled") ?? 0,
    oldestQueuedAt,
    oldestQueuedAgeSeconds:
      oldestQueuedAt && Number.isFinite(nowMs) && Number.isFinite(oldestMs)
        ? Math.max(0, Math.floor((nowMs - oldestMs) / 1_000))
        : null
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
