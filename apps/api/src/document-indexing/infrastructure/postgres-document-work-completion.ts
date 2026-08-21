import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import type { DocumentArtifactWorkRepository } from
  "../application/document-work-port.js";
import { releasePostgresProjectionScopeOutputsForDocument } from
  "./postgres-projection-scope-output-release.js";

type CompletionInput = Parameters<DocumentArtifactWorkRepository["complete"]>[0];

export async function completePostgresDocumentWork(
  sql: TransactionSql,
  input: CompletionInput,
  apply?: () => Promise<void>,
  afterComplete?: () => Promise<void>
): Promise<boolean> {
  const rows = await sql<Array<{
    knowledge_base_id: string;
    document_job_public_id: string;
    source_file_public_id: string;
    source_revision_public_id: string;
    state: "running" | "completed";
  }>>`
    SELECT knowledge_base_id, document_job_public_id,
           source_file_public_id, source_revision_public_id, state
    FROM focowiki.document_artifact_work
    WHERE public_id = ${input.publicId}
      AND ((state = 'running' AND lease_owner = ${input.workerId}
        AND lease_expires_at > ${input.now}) OR state = 'completed')
    FOR UPDATE
  `;
  const work = rows[0];
  if (!work) return false;
  if (work.state === "completed") {
    const receipts = await sql<Array<{ matches: boolean }>>`
      SELECT output_fingerprint_sha256 = ${input.receipt.outputFingerprintSha256}
        AND receipt = ${sql.json(input.receipt.value as never)}::jsonb AS matches
      FROM focowiki.document_artifact_receipts
      WHERE work_public_id = ${input.publicId}
        AND receipt_kind = ${input.receipt.kind}
        AND receipt_key = ${input.receipt.key}
        AND input_fingerprint_sha256 = ${input.receipt.inputFingerprintSha256}
      LIMIT 1
    `;
    return receipts[0]?.matches === true;
  }
  await apply?.();
  await sql`
    INSERT INTO focowiki.document_artifact_receipts (
      public_id, knowledge_base_id, document_job_public_id,
      work_public_id, source_file_public_id, source_revision_public_id,
      receipt_kind, receipt_key, input_fingerprint_sha256,
      output_fingerprint_sha256, receipt, committed_at
    ) VALUES (
      ${`document-receipt-${randomUUID()}`}, ${work.knowledge_base_id},
      ${work.document_job_public_id}, ${input.publicId},
      ${work.source_file_public_id}, ${work.source_revision_public_id},
      ${input.receipt.kind}, ${input.receipt.key},
      ${input.receipt.inputFingerprintSha256},
      ${input.receipt.outputFingerprintSha256},
      ${sql.json(input.receipt.value as never)}, ${input.now}
    )
    ON CONFLICT (
      knowledge_base_id, source_revision_public_id, receipt_kind,
      receipt_key, input_fingerprint_sha256
    ) DO NOTHING
  `;
  await sql`
    UPDATE focowiki.document_artifact_work
    SET state = 'completed', lease_owner = NULL, lease_expires_at = NULL,
        service_time_milliseconds = service_time_milliseconds
          + greatest(0, floor(extract(epoch FROM (
            ${input.now}::timestamptz - started_at
          )) * 1000)::bigint),
        ended_at = ${input.now}, updated_at = ${input.now}
    WHERE public_id = ${input.publicId}
      AND state = 'running' AND lease_owner = ${input.workerId}
  `;
  await updatePostgresDocumentJobSummary(
    sql,
    work.document_job_public_id,
    input.now
  );
  await releasePostgresProjectionScopeOutputsForDocument({
    transaction: sql as unknown as DatabaseClient,
    knowledgeBaseId: work.knowledge_base_id,
    documentJobPublicId: work.document_job_public_id,
    releasedAt: input.now
  });
  await afterComplete?.();
  return true;
}

export async function updatePostgresDocumentJobSummary(
  sql: TransactionSql,
  documentJobPublicId: string,
  now: string
): Promise<void> {
  await sql`
    UPDATE focowiki.document_processing_jobs job
    SET completed_work_count = summary.completed_count,
        service_time_milliseconds = summary.service_time_milliseconds,
        active_work_kinds = CASE WHEN job.state = 'error'
          THEN job.active_work_kinds ELSE summary.active_kinds END,
        blocking_work_kind = CASE WHEN job.state = 'error'
          THEN job.blocking_work_kind ELSE summary.blocking_kind END,
        retrying_work_kind = CASE WHEN job.state = 'error'
          THEN job.retrying_work_kind ELSE summary.retrying_kind END,
        state = CASE
          WHEN job.state = 'error' THEN job.state
          WHEN summary.activation_completed THEN 'available'
          WHEN job.state IN (
            'processing', 'available', 'deleting', 'cancelled', 'superseded'
          ) THEN job.state
          WHEN summary.active_count > 0 OR summary.projection_wait_count > 0
          THEN 'processing'
          ELSE 'waiting'
        END,
        terminal_at = CASE
          WHEN summary.activation_completed THEN coalesce(job.terminal_at, ${now})
          ELSE job.terminal_at
        END,
        updated_at = ${now}
    FROM (
      SELECT count(*) FILTER (WHERE state = 'completed')::integer AS completed_count,
             count(*) FILTER (WHERE state = 'running')::integer AS active_count,
             count(*) FILTER (WHERE state = 'waiting_on_projection')::integer
               AS projection_wait_count,
             coalesce(array_agg(work_kind ORDER BY work_kind)
               FILTER (WHERE state = 'running'), '{}'::text[]) AS active_kinds,
             (array_agg(work_kind ORDER BY CASE work_kind
               WHEN 'prepare' THEN 1 WHEN 'first_layer' THEN 2
               WHEN 'content_projection' THEN 3 WHEN 'graphrag' THEN 4
               WHEN 'relation_reconcile' THEN 5
               WHEN 'knowledge_projection' THEN 6
               WHEN 'activate' THEN 7 WHEN 'cleanup' THEN 8 ELSE 9 END)
               FILTER (WHERE state IN (
                 'waiting', 'running', 'waiting_on_projection'
               )))[1]
               AS blocking_kind,
             (array_agg(work_kind ORDER BY CASE work_kind
               WHEN 'prepare' THEN 1 WHEN 'first_layer' THEN 2
               WHEN 'content_projection' THEN 3 WHEN 'graphrag' THEN 4
               WHEN 'relation_reconcile' THEN 5
               WHEN 'knowledge_projection' THEN 6
               WHEN 'activate' THEN 7 WHEN 'cleanup' THEN 8 ELSE 9 END)
               FILTER (WHERE state = 'waiting' AND attempt_count > 0))[1]
               AS retrying_kind,
             coalesce(sum(service_time_milliseconds), 0)::bigint
               AS service_time_milliseconds,
             bool_or(work_kind = 'activate' AND state = 'completed')
               AS activation_completed
      FROM focowiki.document_artifact_work
      WHERE document_job_public_id = ${documentJobPublicId}
    ) summary
    WHERE job.public_id = ${documentJobPublicId}
  `;
}
