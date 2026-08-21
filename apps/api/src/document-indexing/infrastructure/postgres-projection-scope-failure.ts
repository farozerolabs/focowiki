import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import { convergePostgresUploadDocumentOperation,
  failPostgresDocumentOperation } from
  "./postgres-upload-operation-aggregation.js";
import { enqueuePostgresDocumentWebhookEvent } from
  "./postgres-document-webhook-event.js";
import { releasePostgresDocumentPageCandidates } from
  "./postgres-document-page-candidate-release.js";

type BlockedProjectionRow = {
  work_public_id: string;
  document_job_public_id: string;
  knowledge_base_id: string;
  operation_public_id: string;
  source_file_public_id: string;
  source_revision_public_id: string;
  error_code: string;
  retryable: boolean;
};

export async function failPostgresDocumentsBlockedByProjectionScopes(input: {
  transaction: TransactionSql;
  now: string;
  limit: number;
  webhookRetentionMilliseconds: number | undefined;
}): Promise<number> {
  const tx = input.transaction;
  const blocked = await tx<BlockedProjectionRow[]>`
    WITH failed_jobs AS (
      SELECT DISTINCT ON (contribution.document_job_public_id)
             contribution.document_job_public_id,
             coalesce(scope.safe_error_code, 'PROJECTION_SCOPE_FAILED')
               AS error_code,
             scope.retryable
      FROM focowiki.projection_dirty_scopes scope
      JOIN focowiki.projection_scope_contributions contribution
        ON contribution.scope_public_id = scope.public_id
       AND contribution.state = 'waiting'
      WHERE scope.state = 'error'
      ORDER BY contribution.document_job_public_id,
               scope.updated_at DESC,
               scope.public_id COLLATE "C"
    )
    SELECT work.public_id AS work_public_id,
           work.document_job_public_id, work.knowledge_base_id,
           job.operation_public_id, work.source_file_public_id,
           work.source_revision_public_id,
           failed.error_code, failed.retryable
    FROM failed_jobs failed
    JOIN focowiki.document_artifact_work work
      ON work.document_job_public_id = failed.document_job_public_id
    JOIN focowiki.document_processing_jobs job
      ON job.knowledge_base_id = work.knowledge_base_id
     AND job.public_id = work.document_job_public_id
    WHERE work.work_kind = 'knowledge_projection'
      AND work.state = 'waiting_on_projection'
      AND job.state = 'processing'
    ORDER BY work.updated_at, work.public_id COLLATE "C"
    FOR UPDATE OF work, job SKIP LOCKED
    LIMIT ${input.limit}
  `;
  if (blocked.length === 0) return 0;

  await tx`
    UPDATE focowiki.document_artifact_work work
    SET state = 'error', lease_owner = NULL, lease_expires_at = NULL,
        safe_error_code = failure.error_code,
        safe_error_message = NULL, retryable = failure.retryable,
        ended_at = ${input.now}, updated_at = ${input.now}
    FROM jsonb_to_recordset(${tx.json(blocked as never)}::jsonb) AS failure(
      work_public_id text, error_code text, retryable boolean
    )
    WHERE work.public_id = failure.work_public_id
      AND work.state = 'waiting_on_projection'
  `;
  const failedJobs = await tx<Array<{
    public_id: string;
    revision: number | string;
  }>>`
    UPDATE focowiki.document_processing_jobs job
    SET state = 'error', active_work_kinds = '{}'::text[],
        blocking_work_kind = 'knowledge_projection',
        retrying_work_kind = NULL,
        safe_error_code = failure.error_code,
        safe_error_message = NULL, retryable = failure.retryable,
        failure_count = failure_count + 1,
        total_attempt_count = greatest(total_attempt_count, failure_count + 1),
        started_at = coalesce(started_at, accepted_at),
        terminal_at = ${input.now}, revision = revision + 1,
        updated_at = ${input.now}
    FROM jsonb_to_recordset(${tx.json(blocked as never)}::jsonb) AS failure(
      document_job_public_id text, error_code text, retryable boolean
    )
    WHERE job.public_id = failure.document_job_public_id
      AND job.state = 'processing'
    RETURNING job.public_id, job.revision
  `;
  const revisions = new Map(failedJobs.map((job) => [
    job.public_id, Number(job.revision)
  ]));
  for (const row of blocked) {
    const revision = revisions.get(row.document_job_public_id);
    if (revision === undefined) continue;
    await releasePostgresDocumentPageCandidates({
      transaction: tx as unknown as DatabaseClient,
      knowledgeBaseId: row.knowledge_base_id,
      documentJobPublicId: row.document_job_public_id,
      operationPublicId: row.operation_public_id,
      retainedCandidatePublicIds: [],
      releasedAt: input.now
    });
    await failPostgresDocumentOperation(tx, {
      knowledgeBaseId: row.knowledge_base_id,
      operationPublicId: row.operation_public_id,
      documentJobPublicId: row.document_job_public_id,
      sourceFilePublicId: row.source_file_public_id,
      sourceRevisionPublicId: row.source_revision_public_id,
      errorCode: row.error_code,
      safeMessage: null,
      completedAt: input.now
    });
    await convergePostgresUploadDocumentOperation(tx, {
      knowledgeBaseId: row.knowledge_base_id,
      operationPublicId: row.operation_public_id,
      completedAt: input.now
    });
    if (input.webhookRetentionMilliseconds !== undefined) {
      await enqueuePostgresDocumentWebhookEvent(tx, {
        documentJobPublicId: row.document_job_public_id,
        documentJobRevision: revision,
        knowledgeBaseId: row.knowledge_base_id,
        operationPublicId: row.operation_public_id,
        sourceFilePublicId: row.source_file_public_id,
        eventType: "document.error",
        state: "error",
        safeErrorCode: row.error_code,
        occurredAt: input.now,
        expiresAt: new Date(Date.parse(input.now)
          + input.webhookRetentionMilliseconds).toISOString()
      });
    }
  }
  return failedJobs.length;
}
