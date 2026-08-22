import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";

type AggregateSql = DatabaseClient | TransactionSql;

type AggregateRow = {
  total_count: number | string;
  available_count: number | string;
  error_count: number | string;
  cancelled_count: number | string;
  superseded_count: number | string;
  nonterminal_count: number | string;
};

type UploadOperationSummaryRow = {
  session_public_id: string;
  expected_entry_count: number | string;
  expected_byte_count: number | string;
  received_entry_count: number | string;
  received_byte_count: number | string;
  skipped_existing_count: number | string;
  expires_at: string | Date;
};

export async function convergePostgresUploadDocumentOperation(
  sql: AggregateSql,
  input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    completedAt: string;
  }
): Promise<"pending" | "completed" | "not_upload"> {
  const operations = await sql<Array<{ operation_kind: string; state: string }>>`
    SELECT operation_kind, state
    FROM focowiki.operations
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND public_id = ${input.operationPublicId}
    FOR UPDATE
  `;
  const operation = operations[0];
  if (!operation) throw aggregateError("operation_missing");
  if (operation.operation_kind !== "upload") return "not_upload";
  if (operation.state === "completed") {
    const pendingSummaries = await sql<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM focowiki.upload_operation_summaries
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND operation_public_id = ${input.operationPublicId}
      ) AS exists
    `;
    if (pendingSummaries[0]?.exists !== true) return "completed";
  }

  const aggregateRows = await sql<AggregateRow[]>`
    SELECT count(*) AS total_count,
           count(*) FILTER (WHERE state = 'available') AS available_count,
           count(*) FILTER (WHERE state = 'error') AS error_count,
           count(*) FILTER (WHERE state = 'cancelled') AS cancelled_count,
           count(*) FILTER (WHERE state = 'superseded') AS superseded_count,
           count(*) FILTER (
             WHERE state IN ('waiting', 'processing', 'deleting')
           ) AS nonterminal_count
    FROM focowiki.document_processing_jobs
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND operation_public_id = ${input.operationPublicId}
  `;
  const aggregate = requireAggregate(aggregateRows[0]);
  if (aggregate.nonterminalCount > 0) return "pending";

  const summaries = await sql<UploadOperationSummaryRow[]>`
    SELECT session_public_id, expected_entry_count, expected_byte_count,
           received_entry_count, received_byte_count, skipped_existing_count,
           expires_at
    FROM focowiki.upload_operation_summaries
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND operation_public_id = ${input.operationPublicId}
    FOR UPDATE
  `;
  const summary = summaries[0];
  if (!summary) throw aggregateError("upload_operation_summary_missing");
  const receivedCount = count(summary.received_entry_count);
  if (aggregate.totalCount !== receivedCount) {
    throw aggregateError("document_count_mismatch");
  }
  const expiresAt = timestamp(summary.expires_at);
  if (Date.parse(expiresAt) <= Date.parse(input.completedAt)) {
    throw aggregateError("result_expiry_invalid");
  }

  await sql`
    UPDATE focowiki.operations
    SET state = 'completed', completed_at = ${input.completedAt},
        updated_at = ${input.completedAt}
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND public_id = ${input.operationPublicId}
      AND state NOT IN (
        'completed', 'failed', 'cancelled', 'superseded',
        'timed_out', 'deleted'
      )
  `;
  await sql`
    INSERT INTO focowiki.operation_results (
      public_id, knowledge_base_id, operation_kind, terminal_state,
      result_code, safe_message, result_summary, correlation_public_id,
      completed_at, expires_at
    ) VALUES (
      ${input.operationPublicId}, ${input.knowledgeBaseId}, 'upload',
      'completed', 'UPLOAD_DOCUMENTS_TERMINAL', NULL,
      ${sql.json({
        sessionPublicId: summary.session_public_id,
        expectedEntryCount: count(summary.expected_entry_count),
        expectedByteCount: count(summary.expected_byte_count),
        receivedEntryCount: receivedCount,
        receivedByteCount: count(summary.received_byte_count),
        skippedExistingCount: count(summary.skipped_existing_count),
        totalCount: aggregate.totalCount,
        waitingCount: 0,
        processingCount: 0,
        availableCount: aggregate.availableCount,
        failedCount: aggregate.errorCount,
        deletingCount: 0,
        cancelledCount: aggregate.cancelledCount,
        supersededCount: aggregate.supersededCount
      })}, ${summary.session_public_id}, ${input.completedAt}, ${expiresAt}
    )
    ON CONFLICT (public_id) DO NOTHING
  `;
  await sql`
    DELETE FROM focowiki.upload_path_reservations
    WHERE upload_session_public_id = ${summary.session_public_id}
  `;
  await sql`
    DELETE FROM focowiki.upload_entries
    WHERE upload_session_public_id = ${summary.session_public_id}
  `;
  await sql`
    DELETE FROM focowiki.upload_sessions
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND public_id = ${summary.session_public_id}
  `;
  await sql`
    DELETE FROM focowiki.operation_work_items
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND operation_public_id = ${input.operationPublicId}
      AND work_kind = 'upload'
  `;
  await sql`
    DELETE FROM focowiki.upload_operation_summaries
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND operation_public_id = ${input.operationPublicId}
  `;
  return "completed";
}

export async function failPostgresDocumentOperation(
  sql: AggregateSql,
  input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    documentJobPublicId: string;
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
    errorCode: string;
    safeMessage: string | null;
    completedAt: string;
  }
): Promise<void> {
  const rows = await sql<Array<{
    operation_kind: string;
    expires_at: string | Date;
  }>>`
    SELECT operation.operation_kind,
           (SELECT max(idempotency.expires_at)
            FROM focowiki.operation_idempotency idempotency
            WHERE idempotency.knowledge_base_id = operation.knowledge_base_id
              AND idempotency.operation_public_id = operation.public_id
           ) AS expires_at
    FROM focowiki.operations operation
    WHERE operation.knowledge_base_id = ${input.knowledgeBaseId}
      AND operation.public_id = ${input.operationPublicId}
      AND operation.operation_kind <> 'upload'
    FOR UPDATE OF operation
  `;
  const row = rows[0];
  if (!row) return;
  if (["source_directory_move", "maintenance"].includes(row.operation_kind)) {
    return;
  }
  const expiresAt = timestamp(row.expires_at);
  if (Date.parse(expiresAt) <= Date.parse(input.completedAt)) {
    throw aggregateError("result_expiry_invalid");
  }
  await sql`
    UPDATE focowiki.operations
    SET state = 'failed', completed_at = ${input.completedAt},
        updated_at = ${input.completedAt}
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND public_id = ${input.operationPublicId}
      AND state NOT IN (
        'completed', 'failed', 'cancelled', 'superseded',
        'timed_out', 'deleted'
      )
  `;
  await sql`
    INSERT INTO focowiki.operation_results (
      public_id, knowledge_base_id, operation_kind, terminal_state,
      result_code, safe_message, result_summary, correlation_public_id,
      completed_at, expires_at
    ) VALUES (
      ${input.operationPublicId}, ${input.knowledgeBaseId},
      ${row.operation_kind}, 'failed', ${input.errorCode}, ${input.safeMessage},
      ${sql.json({
        documentJobPublicId: input.documentJobPublicId,
        sourceFilePublicId: input.sourceFilePublicId,
        sourceRevisionPublicId: input.sourceRevisionPublicId
      })}, ${input.documentJobPublicId}, ${input.completedAt}, ${expiresAt}
    )
    ON CONFLICT (public_id) DO NOTHING
  `;
}

function requireAggregate(row: AggregateRow | undefined): {
  totalCount: number;
  availableCount: number;
  errorCount: number;
  cancelledCount: number;
  supersededCount: number;
  nonterminalCount: number;
} {
  if (!row) throw aggregateError("aggregate_missing");
  return {
    totalCount: count(row.total_count),
    availableCount: count(row.available_count),
    errorCount: count(row.error_count),
    cancelledCount: count(row.cancelled_count),
    supersededCount: count(row.superseded_count),
    nonterminalCount: count(row.nonterminal_count)
  };
}

function count(value: number | string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw aggregateError("count_invalid");
  }
  return result;
}

function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function aggregateError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Upload document aggregation error: ${code}`),
    { code }
  );
}
