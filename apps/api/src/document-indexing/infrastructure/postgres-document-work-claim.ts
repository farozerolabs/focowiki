import type { TransactionSql } from "postgres";
import type { ClaimedDocumentArtifactWork } from
  "../application/document-work-port.js";
import { enqueuePostgresDocumentWebhookEvent } from
  "./postgres-document-webhook-event.js";

type WorkRow = {
  public_id: string;
  knowledge_base_id: string;
  document_job_public_id: string;
  source_file_public_id: string;
  source_revision_public_id: string;
  work_kind: ClaimedDocumentArtifactWork["kind"];
  resource_lane: ClaimedDocumentArtifactWork["resourceLane"];
  input_fingerprint_sha256: string;
  attempt_count: number | string;
  maximum_attempts: number | string;
  lease_owner: string;
  lease_expires_at: string | Date;
  started_at: string | Date;
};

export async function claimPostgresDocumentArtifactWork(input: {
  transaction: TransactionSql;
  kind: ClaimedDocumentArtifactWork["kind"];
  resourceLane: ClaimedDocumentArtifactWork["resourceLane"];
  workerId: string;
  now: string;
  limit: number;
  leaseExpiresAt: string;
  projectionBacklogLimit: number;
  webhookRetentionMilliseconds: number | undefined;
}): Promise<readonly ClaimedDocumentArtifactWork[]> {
  const tx = input.transaction;
  const rows = await tx<WorkRow[]>`
    WITH claimable AS (
      SELECT work.public_id
      FROM focowiki.document_artifact_work work
      JOIN focowiki.document_processing_jobs job
        ON job.knowledge_base_id = work.knowledge_base_id
       AND job.public_id = work.document_job_public_id
       AND job.source_revision_public_id = work.source_revision_public_id
      WHERE work.state = 'waiting'
        AND work.attempt_count < work.maximum_attempts
        AND work.work_kind = ${input.kind}
        AND work.next_eligible_at <= ${input.now}
        AND job.state IN ('waiting', 'processing', 'available')
        AND job.cancellation_requested_at IS NULL
        AND (
          work.work_kind <> 'knowledge_projection'
          OR NOT EXISTS (
            SELECT 1
            FROM focowiki.document_artifact_work projection_backlog
            WHERE projection_backlog.work_kind = 'knowledge_projection'
              AND projection_backlog.state = 'waiting_on_projection'
            OFFSET ${input.projectionBacklogLimit - 1}
            LIMIT 1
          )
        )
        AND ${fixedPrerequisiteSql(tx)}
      ORDER BY work.next_eligible_at, work.created_at, work.public_id
      FOR UPDATE OF work SKIP LOCKED
      LIMIT ${input.limit}
    ), claimed AS (
      UPDATE focowiki.document_artifact_work work
      SET state = 'running', attempt_count = work.attempt_count + 1,
          resource_lane = ${input.resourceLane},
          wait_time_milliseconds = work.wait_time_milliseconds
            + greatest(0, floor(extract(epoch FROM (
              ${input.now}::timestamptz - work.updated_at
            )) * 1000)::bigint),
          lease_owner = ${input.workerId},
          lease_expires_at = ${input.leaseExpiresAt},
          started_at = ${input.now},
          ended_at = NULL, safe_error_code = NULL,
          safe_error_message = NULL, retryable = false,
          updated_at = ${input.now}
      FROM claimable
      WHERE work.public_id = claimable.public_id
      RETURNING work.*
    )
    SELECT * FROM claimed
  `;
  if (rows.length === 0) return [];
  const documentJobPublicIds = [
    ...new Set(rows.map((row) => row.document_job_public_id))
  ];
  const startedJobs = await tx<Array<{
    public_id: string;
    revision: number | string;
    knowledge_base_id: string;
    operation_public_id: string;
    source_file_public_id: string;
  }>>`
    WITH target AS (
      SELECT public_id, state AS previous_state
      FROM focowiki.document_processing_jobs
      WHERE public_id = ANY(${documentJobPublicIds}::text[])
      FOR UPDATE
    ), updated AS (
      UPDATE focowiki.document_processing_jobs job
      SET state = CASE WHEN target.previous_state = 'waiting'
            THEN 'processing' ELSE job.state END,
          started_at = coalesce(job.started_at, ${input.now}),
          active_work_kinds = ARRAY(
            SELECT DISTINCT value
            FROM unnest(array_append(job.active_work_kinds, ${input.kind})) value
            ORDER BY value
          ),
          blocking_work_kind = coalesce(job.blocking_work_kind, ${input.kind}),
          total_attempt_count = job.total_attempt_count + 1,
          revision = revision + CASE WHEN target.previous_state = 'waiting'
            THEN 1 ELSE 0 END,
          updated_at = ${input.now}
      FROM target
      WHERE job.public_id = target.public_id
      RETURNING job.public_id, job.revision, job.knowledge_base_id,
                job.operation_public_id, job.source_file_public_id,
                target.previous_state
    )
    SELECT public_id, revision, knowledge_base_id,
           operation_public_id, source_file_public_id
    FROM updated WHERE previous_state = 'waiting'
  `;
  if (input.webhookRetentionMilliseconds !== undefined) {
    for (const job of startedJobs) {
      await enqueuePostgresDocumentWebhookEvent(tx, {
        documentJobPublicId: job.public_id,
        documentJobRevision: Number(job.revision),
        knowledgeBaseId: job.knowledge_base_id,
        operationPublicId: job.operation_public_id,
        sourceFilePublicId: job.source_file_public_id,
        eventType: "document.processing",
        state: "processing",
        occurredAt: input.now,
        expiresAt: new Date(Date.parse(input.now)
          + input.webhookRetentionMilliseconds).toISOString()
      });
    }
  }
  return rows.map(mapWork);
}

function fixedPrerequisiteSql(sql: TransactionSql) {
  return sql`
    CASE work.work_kind
      WHEN 'prepare' THEN true
      WHEN 'first_layer' THEN ${hasReceipt(sql, "prepare")}
      WHEN 'content_projection' THEN ${hasReceipt(sql, "prepare")}
      WHEN 'graphrag' THEN ${hasReceipt(sql, "first_layer")}
      WHEN 'relation_reconcile' THEN
        ${hasReceipt(sql, "first_layer")} AND ${hasReceipt(sql, "graphrag")}
      WHEN 'knowledge_projection' THEN
        ${hasReceipt(sql, "content_projection")}
        AND ${hasReceipt(sql, "relation_reconcile")}
      WHEN 'activate' THEN ${hasReceipt(sql, "knowledge_projection")}
      WHEN 'cleanup' THEN ${hasReceipt(sql, "activate")}
      ELSE false
    END
  `;
}

function hasReceipt(sql: TransactionSql, prerequisiteKind: string) {
  return sql`
    EXISTS (
      SELECT 1
      FROM focowiki.document_artifact_work prerequisite
      JOIN focowiki.document_artifact_receipts receipt
        ON receipt.work_public_id = prerequisite.public_id
      WHERE prerequisite.knowledge_base_id = work.knowledge_base_id
        AND prerequisite.document_job_public_id = work.document_job_public_id
        AND prerequisite.source_revision_public_id = work.source_revision_public_id
        AND prerequisite.work_kind = ${prerequisiteKind}
        AND prerequisite.state = 'completed'
    )
  `;
}

function mapWork(row: WorkRow): ClaimedDocumentArtifactWork {
  return {
    publicId: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    documentJobPublicId: row.document_job_public_id,
    sourceFilePublicId: row.source_file_public_id,
    sourceRevisionPublicId: row.source_revision_public_id,
    kind: row.work_kind,
    resourceLane: row.resource_lane,
    inputFingerprintSha256: row.input_fingerprint_sha256,
    attemptCount: Number(row.attempt_count),
    maximumAttempts: Number(row.maximum_attempts),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: timestamp(row.lease_expires_at),
    startedAt: timestamp(row.started_at)
  };
}

function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
