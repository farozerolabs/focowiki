import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import type { StorageVnextUploadTerminalPort } from "./ports.js";
import { convergePostgresUploadDocumentOperation } from
  "../../document-indexing/infrastructure/postgres-upload-operation-aggregation.js";
import {
  createStorageVnextUploadIdentity,
  createStorageVnextUploadRequestHash
} from "./identity.js";

type ExistingResultRow = {
  terminal_state: string;
  result_code: string;
  correlation_public_id: string | null;
};

type SessionSummaryRow = {
  expected_entry_count: number | string;
  expected_byte_count: number | string;
  received_entry_count: number | string;
  received_byte_count: number | string;
  skipped_existing_count: number | string;
};

export function createPostgresStorageVnextUploadTerminalPort(
  sql: DatabaseClient,
  input: { resultRetentionMilliseconds: number }
): StorageVnextUploadTerminalPort {
  assertRetention(input.resultRetentionMilliseconds);
  return {
    async converge(context) {
      return sql.begin(async (transaction) => {
        if (context.outcome === "accepted") {
          const aggregateExpiresAt = new Date(
            Date.parse(context.completedAt) + input.resultRetentionMilliseconds
          ).toISOString();
          await transaction`
            UPDATE focowiki.upload_sessions
            SET expires_at = ${aggregateExpiresAt}, updated_at = ${context.completedAt}
            WHERE knowledge_base_id = ${context.knowledgeBaseId}
              AND public_id = ${context.sessionPublicId}
          `;
          await transaction`
            DELETE FROM focowiki.upload_path_reservations
            WHERE upload_session_public_id = ${context.sessionPublicId}
          `;
          const summaries = await transaction<SessionSummaryRow[]>`
            SELECT session.expected_entry_count, session.expected_byte_count,
                   session.received_entry_count, session.received_byte_count,
                   (SELECT count(*)
                    FROM focowiki.upload_entries entry
                    WHERE entry.knowledge_base_id = session.knowledge_base_id
                      AND entry.upload_session_public_id = session.public_id
                      AND NOT EXISTS (
                        SELECT 1
                        FROM focowiki.document_processing_jobs job
                        WHERE job.knowledge_base_id = entry.knowledge_base_id
                          AND job.source_file_public_id = entry.source_file_public_id
                          AND job.operation_public_id = session.operation_public_id
                      )) AS skipped_existing_count
            FROM focowiki.upload_sessions session
            WHERE session.public_id = ${context.sessionPublicId}
              AND session.knowledge_base_id = ${context.knowledgeBaseId}
            FOR UPDATE OF session
          `;
          const summary = summaries[0];
          if (!summary) throw terminalError("session_missing");
          await persistAcceptedSummary(transaction, context, summary, aggregateExpiresAt);
          await transaction`
            DELETE FROM focowiki.operation_work_items
            WHERE knowledge_base_id = ${context.knowledgeBaseId}
              AND operation_public_id = ${context.operationPublicId}
              AND work_kind = 'upload'
          `;
          const aggregate = await convergePostgresUploadDocumentOperation(
            transaction,
            {
              knowledgeBaseId: context.knowledgeBaseId,
              operationPublicId: context.operationPublicId,
              completedAt: context.completedAt
            }
          );
          return {
            status: aggregate === "completed" ? "completed" as const : "blocked" as const
          };
        }
        const existing = await transaction<ExistingResultRow[]>`
          SELECT terminal_state, result_code, correlation_public_id
          FROM focowiki.operation_results
          WHERE public_id = ${context.operationPublicId}
          FOR UPDATE
        `;
        if (existing[0]) {
          assertMatchingResult(existing[0], context);
          return { status: "completed" as const };
        }
        const summaries = await transaction<SessionSummaryRow[]>`
          SELECT session.expected_entry_count, session.expected_byte_count,
                 session.received_entry_count, session.received_byte_count,
                 (SELECT count(*)
                  FROM focowiki.upload_entries entry
                  WHERE entry.upload_session_public_id = session.public_id
                    AND EXISTS (
                      SELECT 1 FROM focowiki.source_files source
                      WHERE source.knowledge_base_id = entry.knowledge_base_id
                        AND source.public_id = entry.source_file_public_id
                        AND source.normalized_path = entry.normalized_path
                        AND source.deleted_at IS NULL
                    )) AS skipped_existing_count
          FROM focowiki.upload_sessions session
          WHERE session.public_id = ${context.sessionPublicId}
            AND session.knowledge_base_id = ${context.knowledgeBaseId}
          FOR UPDATE
        `;
        if (!summaries[0]) throw terminalError("session_missing");
        const expiresAt = new Date(
          Date.parse(context.completedAt) + input.resultRetentionMilliseconds
        ).toISOString();
        await persistResult(transaction, context, summaries[0], expiresAt);
        await enqueueObjectCleanup(transaction, context);
        await releaseLiveObjectOwners(transaction, context);
        await transaction`
          DELETE FROM focowiki.upload_path_reservations
          WHERE upload_session_public_id = ${context.sessionPublicId}
        `;
        await transaction`
          DELETE FROM focowiki.upload_entries
          WHERE upload_session_public_id = ${context.sessionPublicId}
        `;
        await transaction`
          DELETE FROM focowiki.upload_sessions
          WHERE public_id = ${context.sessionPublicId}
            AND knowledge_base_id = ${context.knowledgeBaseId}
        `;
        await transaction`
          DELETE FROM focowiki.operation_work_items
          WHERE operation_public_id = ${context.operationPublicId}
            AND work_kind = 'upload'
        `;
        await transaction`
          UPDATE focowiki.operation_idempotency
          SET expires_at = ${expiresAt}
          WHERE operation_public_id = ${context.operationPublicId}
            AND expires_at < ${expiresAt}
        `;
        return { status: "completed" as const };
      });
    }
  };
}

async function persistAcceptedSummary(
  transaction: TransactionSql,
  context: Parameters<StorageVnextUploadTerminalPort["converge"]>[0],
  summary: SessionSummaryRow,
  expiresAt: string
): Promise<void> {
  const expectedEntryCount = terminalCount(summary.expected_entry_count);
  const receivedEntryCount = terminalCount(summary.received_entry_count);
  const skippedExistingCount = terminalCount(summary.skipped_existing_count);
  if (receivedEntryCount + skippedExistingCount !== expectedEntryCount) {
    throw terminalError("invalid_summary");
  }
  await transaction`
    INSERT INTO focowiki.upload_operation_summaries (
      operation_public_id, knowledge_base_id, session_public_id,
      expected_entry_count, expected_byte_count, received_entry_count,
      received_byte_count, skipped_existing_count, expires_at, created_at
    ) VALUES (
      ${context.operationPublicId}, ${context.knowledgeBaseId},
      ${context.sessionPublicId}, ${expectedEntryCount},
      ${terminalCount(summary.expected_byte_count)}, ${receivedEntryCount},
      ${terminalCount(summary.received_byte_count)}, ${skippedExistingCount},
      ${expiresAt}, ${context.completedAt}
    )
    ON CONFLICT (operation_public_id) DO UPDATE
    SET expires_at = excluded.expires_at
  `;
}

async function persistResult(
  transaction: TransactionSql,
  context: Parameters<StorageVnextUploadTerminalPort["converge"]>[0],
  summary: SessionSummaryRow,
  expiresAt: string
): Promise<void> {
  if (context.outcome === "accepted") throw terminalError("invalid_terminal_outcome");
  const terminalState = context.outcome;
  const expectedEntryCount = terminalCount(summary.expected_entry_count);
  const receivedEntryCount = terminalCount(summary.received_entry_count);
  if (receivedEntryCount > expectedEntryCount) {
    throw terminalError("invalid_summary");
  }
  await transaction`
    UPDATE focowiki.operations
    SET state = ${terminalState}, updated_at = ${context.completedAt},
        completed_at = ${context.completedAt}
    WHERE public_id = ${context.operationPublicId}
      AND knowledge_base_id = ${context.knowledgeBaseId}
      AND state NOT IN ('completed', 'failed', 'cancelled', 'superseded', 'timed_out', 'deleted')
  `;
  await transaction`
    INSERT INTO focowiki.operation_results (
      public_id, knowledge_base_id, operation_kind, terminal_state,
      result_code, safe_message, result_summary, correlation_public_id,
      completed_at, expires_at
    ) VALUES (
      ${context.operationPublicId}, ${context.knowledgeBaseId}, 'upload',
      ${terminalState}, ${context.resultCode}, NULL,
      ${transaction.json({
        sessionPublicId: context.sessionPublicId,
        expectedEntryCount,
        expectedByteCount: terminalCount(summary.expected_byte_count),
        receivedEntryCount,
        receivedByteCount: terminalCount(summary.received_byte_count),
        skippedExistingCount: context.outcome === "completed"
          ? expectedEntryCount - receivedEntryCount
          : terminalCount(summary.skipped_existing_count),
        relatedOperationPublicId: context.relatedOperationPublicId
      })},
      ${context.sessionPublicId}, ${context.completedAt}, ${expiresAt}
    )
  `;
}

async function enqueueObjectCleanup(
  transaction: TransactionSql,
  context: Parameters<StorageVnextUploadTerminalPort["converge"]>[0]
): Promise<void> {
  const objectIds = [...new Set(context.temporaryObjectIds)].sort();
  if (objectIds.length === 0) return;
  await transaction`
    INSERT INTO focowiki.cleanup_actions ${transaction(
      objectIds.map((objectId, ordinal) => ({
        public_id: createStorageVnextUploadIdentity(
          "cleanup",
          context.operationPublicId,
          objectId
        ),
        operation_public_id: context.operationPublicId,
        knowledge_base_id: context.knowledgeBaseId,
        action_kind: "upload_terminal",
        cleanup_plane: "object_storage",
        resource_kind: "temporary_object",
        resource_public_id: objectId,
        required: true,
        sequence_number: 30 + ordinal,
        idempotency_key: `upload-cleanup:${objectId}`,
        request_hash: createStorageVnextUploadRequestHash([
          context.operationPublicId,
          context.resultCode,
          objectId
        ]),
        checkpoint: {},
        state: "queued",
        attempt_count: 0,
        maximum_attempts: 10,
        lease_owner: null,
        lease_expires_at: null,
        safe_error_code: null,
        not_before: context.completedAt,
        updated_at: context.completedAt
      })),
      "public_id", "operation_public_id", "knowledge_base_id", "action_kind",
      "cleanup_plane", "resource_kind", "resource_public_id", "required",
      "sequence_number", "idempotency_key", "request_hash", "checkpoint",
      "state", "attempt_count", "maximum_attempts", "lease_owner", "lease_expires_at",
      "safe_error_code", "not_before", "updated_at"
    )}
    ON CONFLICT ON CONSTRAINT cleanup_actions_idempotency_key DO NOTHING
  `;
}

async function releaseLiveObjectOwners(
  transaction: TransactionSql,
  context: Parameters<StorageVnextUploadTerminalPort["converge"]>[0]
): Promise<void> {
  const released = await transaction<Array<{ object_id: string }>>`
    DELETE FROM focowiki.object_owners
    WHERE knowledge_base_id = ${context.knowledgeBaseId}
      AND owner_kind = 'live_reservation'
      AND operation_public_id = ${context.operationPublicId}
    RETURNING object_id
  `;
  if (released.length === 0) return;
  await transaction`
    UPDATE focowiki.object_registrations registration
    SET zero_owner_since = coalesce(registration.zero_owner_since, ${context.completedAt})
    WHERE registration.object_id = ANY(${released.map((row) => row.object_id)})
      AND registration.state = 'verified'
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.object_owners owner
        WHERE owner.object_id = registration.object_id
      )
  `;
}

function assertMatchingResult(
  existing: ExistingResultRow,
  context: Parameters<StorageVnextUploadTerminalPort["converge"]>[0]
): void {
  if (context.outcome === "accepted") throw terminalError("invalid_terminal_outcome");
  if (
    existing.terminal_state !== context.outcome
    || existing.result_code !== context.resultCode
    || existing.correlation_public_id !== context.sessionPublicId
  ) throw terminalError("terminal_conflict");
}

function assertRetention(milliseconds: number): void {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
    throw terminalError("invalid_input");
  }
}

function terminalCount(value: number | string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw terminalError("invalid_summary");
  }
  return count;
}

function terminalError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Storage vNext upload terminal error: ${code}`), { code });
}
