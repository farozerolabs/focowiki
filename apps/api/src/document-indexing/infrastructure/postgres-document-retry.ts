import type { DatabaseClient } from "../../db/client.js";
import { enqueuePostgresDocumentWebhookEvent } from
  "./postgres-document-webhook-event.js";

type RetryRow = {
  public_id: string;
  operation_public_id: string;
  operation_kind: string;
  source_file_public_id: string;
  source_revision_public_id: string;
  state: string;
  retryable: boolean;
  attempt_count: number | string;
  total_attempt_count: number | string;
  maximum_attempts: number | string;
  revision: number | string;
  active_source_revision_public_id: string | null;
  active_generated_path: string | null;
  logical_path: string;
  title: string;
  metadata: Record<string, unknown>;
  resource_revision: number | string;
  object_id: string;
  byte_count: number | string;
  content_type: string;
  created_at: string | Date;
};

export type DocumentRetryOutcome =
  | { outcome: "not_found" }
  | { outcome: "already_running" }
  | { outcome: "not_allowed" }
  | { outcome: "resource_conflict" }
  | {
      outcome: "accepted";
      documentJobPublicId: string;
      operationPublicId: string;
      sourceFilePublicId: string;
      sourceRevisionPublicId: string;
      activeSourceRevisionPublicId: string | null;
      activeGeneratedPath: string | null;
      logicalPath: string;
      title: string;
      metadata: Readonly<Record<string, unknown>>;
      resourceRevision: number;
      byteCount: number;
      contentType: string;
      createdAt: string;
      retryCount: number;
      jobRevision: number;
    };

export function createPostgresDocumentRetry(
  sql: DatabaseClient,
  options: { webhookRetentionMilliseconds?: number } = {}
) {
  return async (input: {
    knowledgeBaseId: string;
    sourceFilePublicId: string;
    retriedAt: string;
  }): Promise<DocumentRetryOutcome> => {
    validateInput(input);
    return sql.begin(async (transaction) => {
      const rows = await transaction<RetryRow[]>`
        SELECT job.public_id, job.operation_public_id,
               operation.operation_kind,
               job.source_file_public_id, job.source_revision_public_id,
               job.state, job.retryable, job.attempt_count,
               job.total_attempt_count,
               job.maximum_attempts, job.revision,
               active.active_source_revision_public_id,
               page.logical_path AS active_generated_path,
               source.logical_path, source.title, source.metadata,
               source.revision AS resource_revision,
               revision.object_id, revision.byte_count,
               revision.content_type, revision.created_at
        FROM focowiki.source_files source
        JOIN focowiki.source_file_active_revisions active
          ON active.knowledge_base_id = source.knowledge_base_id
         AND active.source_file_public_id = source.public_id
        JOIN focowiki.source_revisions revision
          ON revision.knowledge_base_id = active.knowledge_base_id
         AND revision.source_file_public_id = active.source_file_public_id
         AND revision.public_id = active.current_source_revision_public_id
        JOIN focowiki.document_processing_jobs job
          ON job.knowledge_base_id = active.knowledge_base_id
         AND job.source_file_public_id = active.source_file_public_id
         AND job.source_revision_public_id = active.current_source_revision_public_id
        JOIN focowiki.operations operation
          ON operation.knowledge_base_id = job.knowledge_base_id
         AND operation.public_id = job.operation_public_id
        LEFT JOIN focowiki.generated_page_heads page
          ON page.knowledge_base_id = active.knowledge_base_id
         AND page.source_file_public_id = active.source_file_public_id
         AND page.source_revision_public_id = active.active_source_revision_public_id
         AND page.entry_kind = 'source'
        WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
          AND source.public_id = ${input.sourceFilePublicId}
          AND source.deleted_at IS NULL
          AND revision.deleted_at IS NULL
        FOR UPDATE OF source, active, revision, job
      `;
      const row = rows[0];
      if (!row) {
        const source = await transaction<Array<{ exists: boolean }>>`
          SELECT true AS exists
          FROM focowiki.source_files
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND public_id = ${input.sourceFilePublicId}
            AND deleted_at IS NULL
        `;
        return source[0] ? { outcome: "resource_conflict" } : { outcome: "not_found" };
      }
      if (row.state === "waiting" || row.state === "processing") {
        return { outcome: "already_running" };
      }
      if (row.state !== "error" || !row.retryable) {
        return { outcome: "not_allowed" };
      }
      if (!["upload", "source_directory_move"].includes(row.operation_kind)) {
        await transaction`
          DELETE FROM focowiki.operation_results
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND public_id = ${row.operation_public_id}
        `;
        await transaction`
          UPDATE focowiki.operations
          SET state = 'processing', completed_at = NULL,
              updated_at = ${input.retriedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND public_id = ${row.operation_public_id}
        `;
      }
      const updated = await transaction<Array<{
        revision: number | string;
        failure_count: number | string;
      }>>`
        UPDATE focowiki.document_processing_jobs
        SET state = 'waiting',
            attempt_count = 0, failure_count = 0,
            manual_retry_count = manual_retry_count + 1,
            next_attempt_at = ${input.retriedAt},
            active_work_kinds = '{}'::text[],
            blocking_work_kind = (
              SELECT work_kind FROM focowiki.document_artifact_work
              WHERE document_job_public_id = ${row.public_id}
                AND state = 'error'
              ORDER BY created_at, public_id COLLATE "C" LIMIT 1
            ),
            retrying_work_kind = NULL,
            completed_work_count = (
              SELECT count(*)::integer FROM focowiki.document_artifact_work
              WHERE document_job_public_id = ${row.public_id}
                AND state = 'completed'
            ),
            cancellation_requested_at = NULL,
            safe_error_code = NULL, safe_error_message = NULL,
            retryable = false,
            model_status = CASE WHEN EXISTS (
              SELECT 1 FROM focowiki.document_artifact_work
              WHERE document_job_public_id = ${row.public_id}
                AND work_kind = 'first_layer' AND state = 'error'
            ) THEN NULL ELSE model_status END,
            model_name = CASE WHEN EXISTS (
              SELECT 1 FROM focowiki.document_artifact_work
              WHERE document_job_public_id = ${row.public_id}
                AND work_kind = 'first_layer' AND state = 'error'
            ) THEN NULL ELSE model_name END,
            model_started_at = CASE WHEN EXISTS (
              SELECT 1 FROM focowiki.document_artifact_work
              WHERE document_job_public_id = ${row.public_id}
                AND work_kind = 'first_layer' AND state = 'error'
            ) THEN NULL ELSE model_started_at END,
            model_ended_at = CASE WHEN EXISTS (
              SELECT 1 FROM focowiki.document_artifact_work
              WHERE document_job_public_id = ${row.public_id}
                AND work_kind = 'first_layer' AND state = 'error'
            ) THEN NULL ELSE model_ended_at END,
            model_warning_count = CASE WHEN EXISTS (
              SELECT 1 FROM focowiki.document_artifact_work
              WHERE document_job_public_id = ${row.public_id}
                AND work_kind = 'first_layer' AND state = 'error'
            ) THEN NULL ELSE model_warning_count END,
            model_error_code = CASE WHEN EXISTS (
              SELECT 1 FROM focowiki.document_artifact_work
              WHERE document_job_public_id = ${row.public_id}
                AND work_kind = 'first_layer' AND state = 'error'
            ) THEN NULL ELSE model_error_code END,
            terminal_at = NULL,
            service_time_milliseconds = 0,
            revision = revision + 1, updated_at = ${input.retriedAt}
        WHERE public_id = ${row.public_id}
          AND state = 'error' AND retryable
          AND revision = ${Number(row.revision)}
        RETURNING revision, failure_count
      `;
      if (!updated[0]) return { outcome: "resource_conflict" };
      await transaction`
        UPDATE focowiki.projection_dirty_scopes scope
        SET state = 'waiting', attempt_count = 0,
            next_eligible_at = ${input.retriedAt},
            coalesce_until = ${input.retriedAt},
            lease_owner = NULL, lease_expires_at = NULL,
            safe_error_code = NULL, safe_error_message = NULL,
            retryable = false, updated_at = ${input.retriedAt}
        FROM focowiki.projection_scope_contributions contribution
        WHERE contribution.document_job_public_id = ${row.public_id}
          AND contribution.state = 'waiting'
          AND scope.public_id = contribution.scope_public_id
          AND scope.state = 'error'
      `;
      await transaction`
        UPDATE focowiki.document_artifact_work
        SET state = 'waiting', attempt_count = 0,
            next_eligible_at = ${input.retriedAt},
            lease_owner = NULL, lease_expires_at = NULL,
            safe_error_code = NULL, safe_error_message = NULL,
            retryable = false, ended_at = NULL,
            wait_time_milliseconds = 0, service_time_milliseconds = 0,
            updated_at = ${input.retriedAt}
        WHERE document_job_public_id = ${row.public_id}
          AND state = 'error'
      `;
      if (options.webhookRetentionMilliseconds !== undefined) {
        await enqueuePostgresDocumentWebhookEvent(transaction, {
          documentJobPublicId: row.public_id,
          documentJobRevision: Number(updated[0].revision),
          knowledgeBaseId: input.knowledgeBaseId,
          operationPublicId: row.operation_public_id,
          sourceFilePublicId: row.source_file_public_id,
          eventType: "document.waiting",
          state: "waiting",
          occurredAt: input.retriedAt,
          expiresAt: new Date(
            Date.parse(input.retriedAt) + options.webhookRetentionMilliseconds
          ).toISOString()
        });
      }
      return {
        outcome: "accepted",
        documentJobPublicId: row.public_id,
        operationPublicId: row.operation_public_id,
        sourceFilePublicId: row.source_file_public_id,
        sourceRevisionPublicId: row.source_revision_public_id,
        activeSourceRevisionPublicId: row.active_source_revision_public_id,
        activeGeneratedPath: row.active_generated_path,
        logicalPath: row.logical_path,
        title: row.title,
        metadata: row.metadata,
        resourceRevision: Number(row.resource_revision),
        byteCount: Number(row.byte_count),
        contentType: row.content_type,
        createdAt: timestamp(row.created_at),
        retryCount: Number(row.total_attempt_count),
        jobRevision: Number(updated[0].revision)
      };
    });
  };
}

function validateInput(input: {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  retriedAt: string;
}): void {
  if ([input.knowledgeBaseId, input.sourceFilePublicId]
    .some((value) => !value || Buffer.byteLength(value, "utf8") > 255)
    || !Number.isFinite(Date.parse(input.retriedAt))) {
    throw documentRetryError("input_invalid");
  }
}

function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function documentRetryError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document retry error: ${code}`), { code });
}
