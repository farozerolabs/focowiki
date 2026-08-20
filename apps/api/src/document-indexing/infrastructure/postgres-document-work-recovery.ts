import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import { enqueuePostgresDocumentWebhookEvent } from
  "./postgres-document-webhook-event.js";
import { releasePostgresDocumentPageCandidates } from
  "./postgres-document-page-candidate-release.js";

export async function recoverExpiredPostgresDocumentArtifactWork(input: {
  transaction: TransactionSql;
  now: string;
  retryAt: string;
  limit: number;
  webhookRetentionMilliseconds: number | undefined;
}): Promise<number> {
  const tx = input.transaction;
  const rows = await tx<Array<{
    count: number | string;
    terminal_job_public_ids: string[];
  }>>`
    WITH expired AS (
      SELECT public_id, document_job_public_id, attempt_count,
             maximum_attempts, work_kind
      FROM focowiki.document_artifact_work
      WHERE state = 'running' AND lease_expires_at <= ${input.now}
      ORDER BY lease_expires_at, public_id
      FOR UPDATE SKIP LOCKED
      LIMIT ${input.limit}
    ), recovered AS (
      UPDATE focowiki.document_artifact_work work
      SET state = CASE
            WHEN expired.attempt_count < expired.maximum_attempts
            THEN 'waiting' ELSE 'error'
          END,
          next_eligible_at = ${input.retryAt},
          lease_owner = NULL, lease_expires_at = NULL,
          safe_error_code = 'WORK_LEASE_EXPIRED', retryable = true,
          ended_at = CASE
            WHEN expired.attempt_count < expired.maximum_attempts
            THEN NULL ELSE ${input.now}::timestamptz
          END,
          updated_at = ${input.now}
      FROM expired
      WHERE work.public_id = expired.public_id
      RETURNING work.public_id, work.document_job_public_id,
                work.state, work.work_kind
    )
    SELECT count(*) AS count,
           coalesce(array_agg(document_job_public_id)
             FILTER (WHERE state = 'error'), '{}'::text[])
             AS terminal_job_public_ids
    FROM recovered
  `;
  const terminalJobPublicIds = rows[0]?.terminal_job_public_ids ?? [];
  if (terminalJobPublicIds.length > 0) {
    await terminalizeJobs({
      transaction: tx,
      terminalJobPublicIds,
      now: input.now,
      webhookRetentionMilliseconds: input.webhookRetentionMilliseconds
    });
  }
  return Number(rows[0]?.count ?? 0);
}

async function terminalizeJobs(input: {
  transaction: TransactionSql;
  terminalJobPublicIds: readonly string[];
  now: string;
    webhookRetentionMilliseconds: number | undefined;
}): Promise<void> {
  const tx = input.transaction;
  const terminalJobs = await tx<Array<{
    public_id: string;
    revision: number | string;
    knowledge_base_id: string;
    operation_public_id: string;
    source_file_public_id: string;
  }>>`
    UPDATE focowiki.document_processing_jobs job
    SET state = 'error', active_work_kinds = '{}'::text[],
        blocking_work_kind = terminal.work_kind,
        safe_error_code = 'WORK_LEASE_EXPIRED',
        safe_error_message = NULL, retryable = true,
        failure_count = failure_count + 1,
        terminal_at = ${input.now}, revision = revision + 1,
        updated_at = ${input.now}
    FROM (
      SELECT DISTINCT ON (document_job_public_id)
             document_job_public_id, work_kind
      FROM focowiki.document_artifact_work
      WHERE document_job_public_id = ANY(${input.terminalJobPublicIds}::text[])
        AND state = 'error'
      ORDER BY document_job_public_id, updated_at DESC, public_id
    ) terminal
    WHERE job.public_id = terminal.document_job_public_id
    RETURNING job.public_id, job.revision, job.knowledge_base_id,
              job.operation_public_id, job.source_file_public_id
  `;
  for (const job of terminalJobs) {
    await releasePostgresDocumentPageCandidates({
      transaction: tx as unknown as DatabaseClient,
      knowledgeBaseId: job.knowledge_base_id,
      operationPublicId: job.operation_public_id,
      documentJobPublicId: job.public_id,
      retainedCandidatePublicIds: [],
      releasedAt: input.now
    });
    if (input.webhookRetentionMilliseconds !== undefined) {
      await enqueuePostgresDocumentWebhookEvent(tx, {
        documentJobPublicId: job.public_id,
        documentJobRevision: Number(job.revision),
        knowledgeBaseId: job.knowledge_base_id,
        operationPublicId: job.operation_public_id,
        sourceFilePublicId: job.source_file_public_id,
        eventType: "document.error",
        state: "error",
        safeErrorCode: "WORK_LEASE_EXPIRED",
        occurredAt: input.now,
        expiresAt: new Date(Date.parse(input.now)
          + input.webhookRetentionMilliseconds).toISOString()
      });
    }
  }
}
