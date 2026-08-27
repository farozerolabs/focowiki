import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import { convergePostgresUploadDocumentOperation,
  failPostgresDocumentOperation } from
  "./postgres-upload-operation-aggregation.js";
import { enqueuePostgresDocumentWebhookEvent } from
  "./postgres-document-webhook-event.js";
import { releasePostgresDocumentPageCandidates } from
  "./postgres-document-page-candidate-release.js";
import { markDocumentDeletionOperationFailed } from
  "./postgres-document-resource-deletion-support.js";
import { deferPostgresDocumentPublicationOutputCleanup } from
  "./postgres-document-publication-output-cleanup.js";

const RESULT_RETENTION_MILLISECONDS = 30 * 86_400_000;

export async function failPostgresDocumentPublicationJob(input: {
  transaction: DatabaseClient;
  jobPublicId: string;
  errorCode: string;
  failedAt: string;
}): Promise<void> {
  const sql = input.transaction;
  const stages = await sql<Array<{
    work_kind: "knowledge_projection" | "activate";
  }>>`
    SELECT CASE WHEN manifest_fingerprint_sha256 IS NULL
      THEN 'knowledge_projection' ELSE 'activate' END AS work_kind
    FROM focowiki.publication_jobs
    WHERE public_id = ${input.jobPublicId} AND outcome = 'pending'
    FOR UPDATE
  `;
  const stage = stages[0]?.work_kind;
  if (!stage) return;
  await deferPostgresDocumentPublicationOutputCleanup({
    transaction: sql,
    jobPublicId: input.jobPublicId,
    retainedObjectIds: [],
    releasedAt: input.failedAt
  });
  await sql`
    UPDATE focowiki.publication_items item
    SET outcome = 'failed', safe_error_code = ${input.errorCode},
        terminal_at = ${input.failedAt}, updated_at = ${input.failedAt}
    FROM focowiki.publication_job_items membership
    WHERE membership.job_public_id = ${input.jobPublicId}
      AND membership.item_public_id = item.public_id
      AND item.outcome = 'pending'
  `;
  await sql`
    UPDATE focowiki.document_artifact_work work
    SET state = 'error', lease_owner = NULL, lease_expires_at = NULL,
        safe_error_code = ${input.errorCode}, safe_error_message = NULL,
        retryable = true, ended_at = ${input.failedAt},
        updated_at = ${input.failedAt}
    FROM focowiki.publication_job_items membership
    JOIN focowiki.publication_items item
      ON item.public_id = membership.item_public_id
    WHERE membership.job_public_id = ${input.jobPublicId}
      AND item.document_job_public_id = work.document_job_public_id
      AND work.work_kind = ${stage}
      AND work.state NOT IN ('completed', 'error', 'cancelled', 'superseded')
  `;
  const failedJobs = await sql<Array<{
    public_id: string;
    revision: number | string;
    knowledge_base_id: string;
    operation_public_id: string;
    source_file_public_id: string;
    source_revision_public_id: string;
  }>>`
    UPDATE focowiki.document_processing_jobs document_job
    SET state = 'error', active_work_kinds = '{}'::text[],
        blocking_work_kind = ${stage}, retrying_work_kind = NULL,
        safe_error_code = ${input.errorCode}, safe_error_message = NULL,
        retryable = true,
        failure_count = least(failure_count + 1, total_attempt_count),
        terminal_at = ${input.failedAt}, revision = revision + 1,
        updated_at = ${input.failedAt}
    FROM focowiki.publication_job_items membership
    JOIN focowiki.publication_items item
      ON item.public_id = membership.item_public_id
    WHERE membership.job_public_id = ${input.jobPublicId}
      AND item.document_job_public_id = document_job.public_id
      AND document_job.state NOT IN (
        'available', 'error', 'cancelled', 'superseded'
      )
    RETURNING document_job.public_id, document_job.revision,
              document_job.knowledge_base_id,
              document_job.operation_public_id,
              document_job.source_file_public_id,
              document_job.source_revision_public_id
  `;
  for (const job of failedJobs) {
    await releasePostgresDocumentPageCandidates({
      transaction: sql,
      knowledgeBaseId: job.knowledge_base_id,
      operationPublicId: job.operation_public_id,
      documentJobPublicId: job.public_id,
      retainedCandidatePublicIds: [],
      releasedAt: input.failedAt
    });
    await failPostgresDocumentOperation(sql as unknown as TransactionSql, {
      knowledgeBaseId: job.knowledge_base_id,
      operationPublicId: job.operation_public_id,
      documentJobPublicId: job.public_id,
      sourceFilePublicId: job.source_file_public_id,
      sourceRevisionPublicId: job.source_revision_public_id,
      errorCode: input.errorCode,
      safeMessage: null,
      completedAt: input.failedAt
    });
    await convergePostgresUploadDocumentOperation(
      sql as unknown as TransactionSql,
      {
        knowledgeBaseId: job.knowledge_base_id,
        operationPublicId: job.operation_public_id,
        completedAt: input.failedAt
      }
    );
    await enqueuePostgresDocumentWebhookEvent(sql as unknown as TransactionSql, {
      documentJobPublicId: job.public_id,
      documentJobRevision: Number(job.revision),
      knowledgeBaseId: job.knowledge_base_id,
      operationPublicId: job.operation_public_id,
      sourceFilePublicId: job.source_file_public_id,
      eventType: "document.error",
      state: "error",
      safeErrorCode: input.errorCode,
      occurredAt: input.failedAt,
      expiresAt: new Date(Date.parse(input.failedAt)
        + RESULT_RETENTION_MILLISECONDS).toISOString()
    });
  }
  const deletionActions = await sql<Array<{ public_id: string }>>`
    UPDATE focowiki.cleanup_actions action
    SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL,
        safe_error_code = ${input.errorCode}, completed_at = ${input.failedAt},
        updated_at = ${input.failedAt}
    FROM focowiki.publication_job_items membership
    JOIN focowiki.publication_items item
      ON item.public_id = membership.item_public_id
    WHERE membership.job_public_id = ${input.jobPublicId}
      AND item.affected_evidence ? 'deletionOperationPublicId'
      AND action.knowledge_base_id = item.knowledge_base_id
      AND action.operation_public_id
            = item.affected_evidence->>'deletionOperationPublicId'
      AND action.action_kind = 'document_resource_deletion'
      AND action.state IN ('queued', 'retry', 'running')
    RETURNING action.public_id
  `;
  for (const action of deletionActions) {
    await markDocumentDeletionOperationFailed(sql, {
      actionPublicId: action.public_id,
      safeErrorCode: input.errorCode,
      failedAt: input.failedAt
    });
  }
  await sql`
    UPDATE focowiki.publication_jobs
    SET outcome = 'failed', attempt_owner = NULL, attempt_token = NULL,
        attempt_started_at = NULL, attempt_deadline = NULL,
        safe_error_code = ${input.errorCode}, completed_at = ${input.failedAt},
        updated_at = ${input.failedAt}
    WHERE public_id = ${input.jobPublicId} AND outcome = 'pending'
  `;
}
