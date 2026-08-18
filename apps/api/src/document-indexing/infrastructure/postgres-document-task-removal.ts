import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import type { TransactionSql } from "postgres";
import { terminalizePostgresDocumentWork } from
  "./postgres-document-work-terminalization.js";

type TaskRow = {
  source_file_public_id: string;
  source_revision_public_id: string;
  active_source_revision_public_id: string | null;
  document_job_public_id: string;
  operation_public_id: string;
  operation_kind: string;
  job_state: string;
  job_revision: number | string;
};

export type DocumentTaskRemovalOutcome = {
  sourceFilePublicId: string;
  outcome: "source_deletion_accepted" | "failed_attempt_removed" | "skipped";
  reason?: "missing" | "not_removable";
  activeSourceRevisionPublicId?: string;
};

export function createPostgresDocumentTaskRemoval(sql: DatabaseClient) {
  return async (input: {
    knowledgeBaseId: string;
    sourceFilePublicIds: readonly string[];
    removedAt: string;
    resultExpiresAt: string;
  }): Promise<readonly DocumentTaskRemovalOutcome[]> => {
    validateInput(input);
    return sql.begin(async (transaction) => {
      const outcomes: DocumentTaskRemovalOutcome[] = [];
      for (const sourceFilePublicId of input.sourceFilePublicIds) {
        const rows = await transaction<TaskRow[]>`
          SELECT source.public_id AS source_file_public_id,
                 active.current_source_revision_public_id AS source_revision_public_id,
                 active.active_source_revision_public_id,
                 job.public_id AS document_job_public_id,
                 job.operation_public_id, operation.operation_kind,
                 job.state AS job_state, job.revision AS job_revision
          FROM focowiki.source_files source
          JOIN focowiki.source_file_active_revisions active
            ON active.knowledge_base_id = source.knowledge_base_id
           AND active.source_file_public_id = source.public_id
          JOIN focowiki.document_processing_jobs job
            ON job.knowledge_base_id = active.knowledge_base_id
           AND job.source_file_public_id = active.source_file_public_id
           AND job.source_revision_public_id = active.current_source_revision_public_id
          JOIN focowiki.operations operation
            ON operation.knowledge_base_id = job.knowledge_base_id
           AND operation.public_id = job.operation_public_id
          WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
            AND source.public_id = ${sourceFilePublicId}
            AND source.deleted_at IS NULL
          FOR UPDATE OF source, active, job, operation
        `;
        const row = rows[0];
        if (!row) {
          outcomes.push({ sourceFilePublicId, outcome: "skipped", reason: "missing" });
          continue;
        }
        if (!["waiting", "processing", "error"].includes(row.job_state)
          || row.active_source_revision_public_id === row.source_revision_public_id) {
          outcomes.push({
            sourceFilePublicId,
            outcome: "skipped",
            reason: "not_removable"
          });
          continue;
        }
        if (row.active_source_revision_public_id === null) {
          await transaction`
            UPDATE focowiki.source_files
            SET deleted_at = ${input.removedAt}, revision = revision + 1,
                updated_at = ${input.removedAt}
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
              AND public_id = ${sourceFilePublicId}
          `;
          await terminalizeJob(transaction, row, "cancelled", input.removedAt);
          await terminalizeOperation(transaction, input, row, "cancelled", {
            outcome: "source_deletion_accepted",
            sourceFilePublicId,
            sourceRevisionPublicId: row.source_revision_public_id
          });
          await enqueueCleanup(transaction, input, row, "source_file", sourceFilePublicId);
          outcomes.push({ sourceFilePublicId, outcome: "source_deletion_accepted" });
          continue;
        }
        await transaction`
          UPDATE focowiki.source_file_active_revisions
          SET current_source_revision_public_id = active_source_revision_public_id,
              updated_at = ${input.removedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND source_file_public_id = ${sourceFilePublicId}
            AND current_source_revision_public_id = ${row.source_revision_public_id}
        `;
        await terminalizeJob(transaction, row, "superseded", input.removedAt);
        await terminalizeOperation(transaction, input, row, "superseded", {
          outcome: "failed_attempt_removed",
          sourceFilePublicId,
          sourceRevisionPublicId: row.source_revision_public_id,
          activeSourceRevisionPublicId: row.active_source_revision_public_id
        });
        await enqueueCleanup(
          transaction,
          input,
          row,
          "source_revision",
          row.source_revision_public_id
        );
        outcomes.push({
          sourceFilePublicId,
          outcome: "failed_attempt_removed",
          activeSourceRevisionPublicId: row.active_source_revision_public_id
        });
      }
      return outcomes;
    });
  };
}

async function terminalizeJob(
  sql: TransactionSql,
  row: TaskRow,
  state: "cancelled" | "superseded",
  at: string
): Promise<void> {
  await terminalizePostgresDocumentWork({
    sql,
    documentJobPublicIds: [row.document_job_public_id],
    state,
    terminalAt: at
  });
  await sql`
    UPDATE focowiki.document_processing_jobs
    SET state = ${state},
        cancellation_requested_at = CASE
          WHEN ${state} = 'cancelled' THEN ${at}::timestamptz
          ELSE cancellation_requested_at END,
        started_at = coalesce(started_at, accepted_at), terminal_at = ${at},
        next_attempt_at = NULL,
        safe_error_code = NULL, safe_error_message = NULL, retryable = false,
        active_work_kinds = '{}'::text[], blocking_work_kind = NULL,
        retrying_work_kind = NULL,
        revision = revision + 1, updated_at = ${at}
    WHERE public_id = ${row.document_job_public_id}
      AND revision = ${Number(row.job_revision)}
  `;
}

async function terminalizeOperation(
  sql: TransactionSql,
  input: { knowledgeBaseId: string; removedAt: string; resultExpiresAt: string },
  row: TaskRow,
  state: "cancelled" | "superseded",
  summary: Readonly<Record<string, unknown>>
): Promise<void> {
  if (row.operation_kind === "upload") return;
  await sql`
    UPDATE focowiki.operations
    SET state = ${state}, completed_at = ${input.removedAt},
        updated_at = ${input.removedAt}
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND public_id = ${row.operation_public_id}
  `;
  await sql`
    INSERT INTO focowiki.operation_results (
      public_id, knowledge_base_id, operation_kind, terminal_state,
      result_code, result_summary, correlation_public_id,
      completed_at, expires_at
    ) VALUES (
      ${row.operation_public_id}, ${input.knowledgeBaseId}, ${row.operation_kind},
      ${state}, ${state === "cancelled" ? "SOURCE_DELETION_ACCEPTED" : "FAILED_ATTEMPT_REMOVED"},
      ${sql.json(summary as never)}, ${row.document_job_public_id},
      ${input.removedAt}, ${input.resultExpiresAt}
    )
    ON CONFLICT (public_id) DO UPDATE
    SET terminal_state = EXCLUDED.terminal_state,
        result_code = EXCLUDED.result_code,
        result_summary = EXCLUDED.result_summary,
        correlation_public_id = EXCLUDED.correlation_public_id,
        completed_at = EXCLUDED.completed_at,
        expires_at = EXCLUDED.expires_at
  `;
}

async function enqueueCleanup(
  sql: TransactionSql,
  input: { knowledgeBaseId: string; removedAt: string },
  row: TaskRow,
  resourceKind: "source_file" | "source_revision",
  resourcePublicId: string
): Promise<void> {
  const identity = createHash("sha256").update([
    "document-task-removal-v1",
    input.knowledgeBaseId,
    row.document_job_public_id,
    resourceKind,
    resourcePublicId
  ].join("\0")).digest("hex");
  const actionKind = resourceKind === "source_file"
    ? "document_resource_deletion"
    : "document_revision_purge";
  await sql`
    INSERT INTO focowiki.cleanup_actions (
      public_id, knowledge_base_id, operation_public_id,
      document_job_public_id, source_revision_public_id,
      action_kind, cleanup_plane, search_provider_kind,
      resource_kind, resource_public_id, required, priority,
      sequence_number, idempotency_key, request_hash, checkpoint,
      state, attempt_count, maximum_attempts, not_before,
      created_at, updated_at
    ) VALUES (
      ${`cleanup-document-task-${identity}`}, ${input.knowledgeBaseId},
      ${row.operation_public_id},
      ${resourceKind === "source_file" ? null : row.document_job_public_id},
      ${resourceKind === "source_file" ? null : row.source_revision_public_id},
      ${actionKind}, 'postgres', NULL,
      ${resourceKind}, ${resourcePublicId}, true, 20, 0,
      ${`document-task-${identity}`}, ${identity}, '{}'::jsonb,
      'queued', 0, 10, ${input.removedAt}, ${input.removedAt}, ${input.removedAt}
    )
    ON CONFLICT DO NOTHING
  `;
}

function validateInput(input: {
  knowledgeBaseId: string;
  sourceFilePublicIds: readonly string[];
  removedAt: string;
  resultExpiresAt: string;
}): void {
  if (!input.knowledgeBaseId || input.sourceFilePublicIds.length < 1
    || input.sourceFilePublicIds.length > 200
    || new Set(input.sourceFilePublicIds).size !== input.sourceFilePublicIds.length
    || input.sourceFilePublicIds.some((value) => !value || value.length > 255)
    || !Number.isFinite(Date.parse(input.removedAt))
    || Date.parse(input.resultExpiresAt) <= Date.parse(input.removedAt)) {
    throw taskRemovalError("input_invalid");
  }
}

function taskRemovalError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document task removal error: ${code}`), { code });
}
