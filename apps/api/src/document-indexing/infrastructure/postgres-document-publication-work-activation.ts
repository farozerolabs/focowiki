import { createHash } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import { enqueuePostgresDocumentWebhookEvent } from
  "./postgres-document-webhook-event.js";
import { updatePostgresDocumentJobSummary } from
  "./postgres-document-work-completion.js";

const RESULT_RETENTION_MILLISECONDS = 30 * 86_400_000;

export async function completePostgresDocumentPublicationWork(input: {
  transaction: DatabaseClient;
  generationPublicId: string;
  knowledgeBaseId: string;
  outputFingerprintSha256: string;
  activatedAt: string;
}): Promise<number> {
  const sql = input.transaction;
  const works = await sql<Array<{
    document_job_public_id: string;
    source_file_public_id: string;
    source_revision_public_id: string;
    projection_work_public_id: string;
    projection_input_fingerprint_sha256: string;
    activation_work_public_id: string;
    activation_input_fingerprint_sha256: string;
    operation_public_id: string;
    operation_kind: string;
    job_revision: number | string;
  }>>`
    SELECT job.public_id AS document_job_public_id,
           job.source_file_public_id, job.source_revision_public_id,
           projection.public_id AS projection_work_public_id,
           projection.input_fingerprint_sha256
             AS projection_input_fingerprint_sha256,
           activation.public_id AS activation_work_public_id,
           activation.input_fingerprint_sha256
             AS activation_input_fingerprint_sha256,
           job.operation_public_id, operation.operation_kind,
           job.revision AS job_revision
    FROM focowiki.projection_generation_documents document
    JOIN focowiki.document_processing_jobs job
      ON job.public_id = document.document_job_public_id
    JOIN focowiki.document_artifact_work projection
      ON projection.document_job_public_id = job.public_id
     AND projection.work_kind = 'knowledge_projection'
     AND projection.state = 'waiting_on_projection'
    JOIN focowiki.document_artifact_work activation
      ON activation.document_job_public_id = job.public_id
     AND activation.work_kind = 'activate'
     AND activation.state = 'waiting'
    JOIN focowiki.operations operation
      ON operation.knowledge_base_id = job.knowledge_base_id
     AND operation.public_id = job.operation_public_id
    WHERE document.generation_public_id = ${input.generationPublicId}
      AND job.knowledge_base_id = ${input.knowledgeBaseId}
      AND job.state = 'processing'
    ORDER BY job.public_id COLLATE "C"
    FOR UPDATE OF job, projection, activation
  `;
  const expected = await sql<Array<{ count: number | string }>>`
    SELECT count(*) AS count FROM focowiki.projection_generation_documents
    WHERE generation_public_id = ${input.generationPublicId}
      AND document_job_public_id IS NOT NULL
  `;
  if (works.length !== Number(expected[0]?.count ?? -1)) {
    throw activationError("publication_work_precondition_failed");
  }
  if (works.length === 0) return 0;
  const receipts = works.flatMap((work) => [{
    public_id: receiptId(input.generationPublicId,
      work.document_job_public_id, "projection"),
    knowledge_base_id: input.knowledgeBaseId,
    document_job_public_id: work.document_job_public_id,
    work_public_id: work.projection_work_public_id,
    source_file_public_id: work.source_file_public_id,
    source_revision_public_id: work.source_revision_public_id,
    receipt_kind: "generated_page",
    receipt_key: "closure",
    input_fingerprint_sha256: work.projection_input_fingerprint_sha256,
    output_fingerprint_sha256: input.outputFingerprintSha256,
    receipt: {
      schemaVersion: "document-publication-generation-receipt-v1",
      generationPublicId: input.generationPublicId
    }
  }, {
    public_id: receiptId(input.generationPublicId,
      work.document_job_public_id, "activation"),
    knowledge_base_id: input.knowledgeBaseId,
    document_job_public_id: work.document_job_public_id,
    work_public_id: work.activation_work_public_id,
    source_file_public_id: work.source_file_public_id,
    source_revision_public_id: work.source_revision_public_id,
    receipt_kind: "activation",
    receipt_key: "visible",
    input_fingerprint_sha256: work.activation_input_fingerprint_sha256,
    output_fingerprint_sha256: input.outputFingerprintSha256,
    receipt: {
      schemaVersion: "document-publication-activation-receipt-v1",
      generationPublicId: input.generationPublicId
    }
  }]);
  await sql`
    INSERT INTO focowiki.document_artifact_receipts (
      public_id, knowledge_base_id, document_job_public_id, work_public_id,
      source_file_public_id, source_revision_public_id, receipt_kind,
      receipt_key, input_fingerprint_sha256, output_fingerprint_sha256,
      receipt, committed_at
    )
    SELECT public_id, knowledge_base_id, document_job_public_id,
           work_public_id, source_file_public_id, source_revision_public_id,
           receipt_kind, receipt_key, input_fingerprint_sha256,
           output_fingerprint_sha256, receipt, ${input.activatedAt}
    FROM jsonb_to_recordset(${sql.json(receipts as never)}::jsonb) desired(
      public_id text, knowledge_base_id text, document_job_public_id text,
      work_public_id text, source_file_public_id text,
      source_revision_public_id text, receipt_kind text, receipt_key text,
      input_fingerprint_sha256 text, output_fingerprint_sha256 text,
      receipt jsonb
    )
    ON CONFLICT (
      knowledge_base_id, source_revision_public_id, receipt_kind,
      receipt_key, input_fingerprint_sha256
    ) DO NOTHING
  `;
  const workIds = works.flatMap((work) => [
    work.projection_work_public_id,
    work.activation_work_public_id
  ]);
  const completed = await sql<Array<{ public_id: string }>>`
    UPDATE focowiki.document_artifact_work work
    SET state = 'completed', lease_owner = NULL, lease_expires_at = NULL,
        ended_at = ${input.activatedAt}, updated_at = ${input.activatedAt}
    WHERE work.public_id IN ${sql(workIds)}
      AND ((work.work_kind = 'knowledge_projection'
            AND work.state = 'waiting_on_projection')
        OR (work.work_kind = 'activate' AND work.state = 'waiting'))
    RETURNING public_id
  `;
  if (completed.length !== workIds.length) {
    throw activationError("publication_work_completion_conflict");
  }
  const jobIds = works.map((work) => work.document_job_public_id);
  for (const work of works) {
    await updatePostgresDocumentJobSummary(
      sql as unknown as TransactionSql,
      work.document_job_public_id,
      input.activatedAt
    );
  }
  const available = await sql<Array<{ public_id: string }>>`
    SELECT public_id FROM focowiki.document_processing_jobs
    WHERE public_id IN ${sql(jobIds)} AND state = 'available'
  `;
  if (available.length !== works.length) {
    throw activationError("publication_job_completion_conflict");
  }
  await sql`
    DELETE FROM focowiki.document_projection_waiting_completions
    WHERE document_job_public_id IN ${sql(jobIds)}
  `;
  await sql`
    UPDATE focowiki.operations operation
    SET state = 'completed', completed_at = ${input.activatedAt},
        updated_at = ${input.activatedAt}
    WHERE operation.knowledge_base_id = ${input.knowledgeBaseId}
      AND operation.operation_kind IN ('source_replace', 'source_file_move')
      AND operation.state IN ('accepted', 'validating', 'processing')
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.document_processing_jobs job
        WHERE job.operation_public_id = operation.public_id
          AND job.state NOT IN ('available', 'cancelled', 'superseded')
      )
  `;
  const expiresAt = new Date(Date.parse(input.activatedAt)
    + RESULT_RETENTION_MILLISECONDS).toISOString();
  for (const work of works) {
    await enqueuePostgresDocumentWebhookEvent(sql, {
      documentJobPublicId: work.document_job_public_id,
      documentJobRevision: Number(work.job_revision),
      knowledgeBaseId: input.knowledgeBaseId,
      operationPublicId: work.operation_public_id,
      sourceFilePublicId: work.source_file_public_id,
      eventType: "document.available",
      state: "available",
      occurredAt: input.activatedAt,
      expiresAt
    });
    if (!["upload", "maintenance", "source_directory_move"]
      .includes(work.operation_kind)) {
      await sql`
        INSERT INTO focowiki.operation_results (
          public_id, knowledge_base_id, operation_kind, terminal_state,
          result_code, safe_message, result_summary, correlation_public_id,
          completed_at, expires_at
        ) VALUES (
          ${work.operation_public_id}, ${input.knowledgeBaseId},
          ${work.operation_kind}, 'completed', 'DOCUMENT_AVAILABLE', NULL,
          ${sql.json({
            sourceFilePublicId: work.source_file_public_id,
            sourceRevisionPublicId: work.source_revision_public_id
          })}, ${work.document_job_public_id}, ${input.activatedAt}, ${expiresAt}
        ) ON CONFLICT (public_id) DO NOTHING
      `;
    }
  }
  return works.length;
}

function receiptId(
  generationPublicId: string,
  documentJobPublicId: string,
  kind: string
): string {
  const value = `${generationPublicId}-${documentJobPublicId}-${kind}`;
  return `document-receipt-publication-${createHash("sha256")
    .update(value).digest("hex")}`;
}

function activationError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Publication work activation error: ${code}`), {
    code
  });
}
