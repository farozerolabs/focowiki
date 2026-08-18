import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import type { TransactionSql } from "postgres";
import { enqueuePostgresDocumentWebhookEvent } from
  "./postgres-document-webhook-event.js";
import { terminalizePostgresDocumentWork } from
  "./postgres-document-work-terminalization.js";

export type DocumentDeletionTargetKind =
  "source_file" | "source_directory" | "knowledge_base";

export function createPostgresDocumentDeletionAcceptance(sql: DatabaseClient) {
  return async (input: {
    knowledgeBaseId: string;
    targetKind: DocumentDeletionTargetKind;
    targetPublicId: string;
    expectedResourceRevision: number;
    operationPublicId: string;
    idempotencyKey: string;
    maximumAttempts: number;
    requestedAt: string;
    expiresAt: string;
  }): Promise<{
    operationPublicId: string;
    affectedSourceCount: number;
    replayed: boolean;
  }> => {
    validateInput(input);
    const requestHash = deletionRequestHash(input);
    return sql.begin(async (transaction) => {
      const replay = await transaction<Array<{
        request_hash: string;
        operation_public_id: string;
        result_summary: Record<string, unknown> | null;
      }>>`
        SELECT idempotency.request_hash, idempotency.operation_public_id,
        cleanup.checkpoint AS result_summary
        FROM focowiki.operation_idempotency idempotency
        LEFT JOIN focowiki.cleanup_actions cleanup
          ON cleanup.knowledge_base_id = idempotency.knowledge_base_id
         AND cleanup.operation_public_id = idempotency.operation_public_id
         AND cleanup.action_kind = 'document_resource_deletion'
        WHERE idempotency.knowledge_base_id = ${input.knowledgeBaseId}
          AND idempotency.idempotency_key = ${input.idempotencyKey}
        FOR UPDATE OF idempotency
      `;
      if (replay[0]) {
        if (replay[0].request_hash !== requestHash) {
          throw deletionAcceptanceError("idempotency_conflict");
        }
        return {
          operationPublicId: replay[0].operation_public_id,
          affectedSourceCount: numberField(
            replay[0].result_summary,
            "affectedSourceCount"
          ),
          replayed: true
        };
      }
      const target = await lockTarget(transaction, input);
      if (!target) throw deletionAcceptanceError("resource_missing");
      if (target.revision !== input.expectedResourceRevision) {
        throw deletionAcceptanceError("revision_conflict");
      }
      const affectedSourceCount = await stageAffectedSources(
        transaction,
        input,
        target.normalizedPath
      );
      await transaction`
        INSERT INTO focowiki.operations (
          public_id, knowledge_base_id, operation_kind, state,
          expected_resource_revision, target_kind, target_public_id,
          created_at, updated_at
        ) VALUES (
          ${input.operationPublicId}, ${input.knowledgeBaseId}, 'deletion',
          'processing', ${input.expectedResourceRevision}, ${input.targetKind},
          ${input.targetPublicId}, ${input.requestedAt}, ${input.requestedAt}
        )
      `;
      await transaction`
        INSERT INTO focowiki.operation_idempotency (
          public_id, knowledge_base_id, idempotency_key, request_hash,
          operation_public_id, expires_at, created_at
        ) VALUES (
          ${`idempotency-document-deletion-${requestHash}`},
          ${input.knowledgeBaseId}, ${input.idempotencyKey}, ${requestHash},
          ${input.operationPublicId}, ${input.expiresAt}, ${input.requestedAt}
        )
      `;
      await commitAuthoritativeVisibility(transaction, input);
      if (affectedSourceCount > 0) {
        const deletingJobs = await transaction<Array<{
          public_id: string;
          revision: number | string;
          knowledge_base_id: string;
          operation_public_id: string;
          source_file_public_id: string;
        }>>`
          WITH latest_jobs AS (
            SELECT DISTINCT ON (job.source_file_public_id) job.public_id
            FROM focowiki.document_processing_jobs job
            WHERE job.knowledge_base_id = ${input.knowledgeBaseId}
              AND job.source_file_public_id IN (
                SELECT public_id FROM document_deletion_sources
              )
              AND job.state NOT IN ('cancelled', 'superseded')
            ORDER BY job.source_file_public_id,
                     job.accepted_at DESC, job.public_id DESC
          )
          UPDATE focowiki.document_processing_jobs job
          SET state = 'deleting', terminal_at = NULL,
              next_attempt_at = NULL,
              safe_error_code = NULL, safe_error_message = NULL,
              retryable = false, active_work_kinds = '{}'::text[],
              blocking_work_kind = NULL, retrying_work_kind = NULL,
              revision = revision + 1,
              updated_at = GREATEST(updated_at, ${input.requestedAt})
          FROM latest_jobs latest
          WHERE job.public_id = latest.public_id
          RETURNING job.public_id, job.revision, job.knowledge_base_id,
                    job.operation_public_id, job.source_file_public_id
        `;
        await terminalizePostgresDocumentWork({
          sql: transaction,
          documentJobPublicIds: deletingJobs.map((job) => job.public_id),
          state: "cancelled",
          terminalAt: input.requestedAt
        });
        for (const job of deletingJobs) {
          await enqueuePostgresDocumentWebhookEvent(transaction, {
            documentJobPublicId: job.public_id,
            documentJobRevision: Number(job.revision),
            knowledgeBaseId: job.knowledge_base_id,
            operationPublicId: job.operation_public_id,
            sourceFilePublicId: job.source_file_public_id,
            eventType: "document.deleting",
            state: "deleting",
            occurredAt: input.requestedAt,
            expiresAt: input.expiresAt
          });
        }
        await transaction`
          UPDATE focowiki.source_file_active_revisions
          SET active_source_revision_public_id = NULL,
              updated_at = ${input.requestedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND source_file_public_id IN (
              SELECT public_id FROM document_deletion_sources
            )
        `;
        await transaction`
          UPDATE focowiki.search_document_owners
          SET state = 'obsolete', updated_at = ${input.requestedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND source_file_public_id IN (
              SELECT public_id FROM document_deletion_sources
            )
            AND state IN ('staged', 'active')
        `;
        await transaction`
          UPDATE focowiki.relation_directed_evidence
          SET active = false, retired_at = ${input.requestedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND (source_file_public_id IN (
              SELECT public_id FROM document_deletion_sources
            ) OR target_source_file_public_id IN (
              SELECT public_id FROM document_deletion_sources
            ))
            AND active AND retired_at IS NULL
        `;
        await transaction`
          UPDATE focowiki.canonical_file_relations relation
          SET active = false, retired_at = ${input.requestedAt}
          WHERE relation.knowledge_base_id = ${input.knowledgeBaseId}
            AND relation.active AND relation.retired_at IS NULL
            AND ((relation.first_source_file_public_id IN (
              SELECT public_id FROM document_deletion_sources
            ) OR relation.second_source_file_public_id IN (
              SELECT public_id FROM document_deletion_sources
            )) OR NOT EXISTS (
              SELECT 1 FROM focowiki.relation_directed_evidence evidence
              WHERE evidence.knowledge_base_id = relation.knowledge_base_id
                AND evidence.pair_public_id = relation.pair_public_id
                AND evidence.active AND evidence.retired_at IS NULL
            ))
        `;
        await transaction`
          UPDATE focowiki.unresolved_file_references
          SET resolution_state = 'obsolete', updated_at = ${input.requestedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND source_file_public_id IN (
              SELECT public_id FROM document_deletion_sources
            )
            AND resolution_state <> 'obsolete'
        `;
        await transaction`
          DELETE FROM focowiki.generated_page_heads
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND source_file_public_id IN (
              SELECT public_id FROM document_deletion_sources
            )
        `;
      }
      await enqueueDeletionCleanup(
        transaction,
        input,
        affectedSourceCount,
        requestHash
      );
      return {
        operationPublicId: input.operationPublicId,
        affectedSourceCount,
        replayed: false
      };
    });
  };
}

async function lockTarget(sql: TransactionSql, input: {
  knowledgeBaseId: string;
  targetKind: DocumentDeletionTargetKind;
  targetPublicId: string;
}): Promise<{ revision: number; normalizedPath: string | null } | null> {
  const rows = input.targetKind === "knowledge_base"
    ? await sql<Array<{ revision: number | string }>>`
        SELECT revision FROM focowiki.knowledge_bases
        WHERE public_id = ${input.knowledgeBaseId} AND deleted_at IS NULL
        FOR UPDATE
      `
    : input.targetKind === "source_directory"
      ? await sql<Array<{ revision: number | string; normalized_path: string }>>`
          SELECT revision, normalized_path FROM focowiki.source_directories
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND public_id = ${input.targetPublicId} AND deleted_at IS NULL
          FOR UPDATE
        `
      : await sql<Array<{ revision: number | string; normalized_path: string }>>`
          SELECT revision, normalized_path FROM focowiki.source_files
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND public_id = ${input.targetPublicId} AND deleted_at IS NULL
          FOR UPDATE
        `;
  return rows[0] ? {
    revision: Number(rows[0].revision),
    normalizedPath: "normalized_path" in rows[0] ? rows[0].normalized_path : null
  } : null;
}

async function stageAffectedSources(
  sql: TransactionSql,
  input: { knowledgeBaseId: string; targetKind: DocumentDeletionTargetKind; targetPublicId: string },
  normalizedPath: string | null
): Promise<number> {
  await sql`
    CREATE TEMPORARY TABLE document_deletion_sources (
      public_id text PRIMARY KEY
    ) ON COMMIT DROP
  `;
  await sql`
    INSERT INTO document_deletion_sources (public_id)
    SELECT public_id FROM focowiki.source_files
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND deleted_at IS NULL
      AND (
        ${input.targetKind} = 'knowledge_base'
        OR ${input.targetKind} = 'source_file' AND public_id = ${input.targetPublicId}
        OR ${input.targetKind} = 'source_directory' AND (
          normalized_path LIKE ${normalizedPath ?? ""} || '/%'
        )
      )
    ORDER BY public_id COLLATE "C"
  `;
  const rows = await sql<Array<{ affected_source_count: number | string }>>`
    SELECT count(*) AS affected_source_count
    FROM document_deletion_sources
  `;
  return Number(rows[0]?.affected_source_count ?? 0);
}

async function commitAuthoritativeVisibility(
  sql: TransactionSql,
  input: { knowledgeBaseId: string; targetKind: DocumentDeletionTargetKind; targetPublicId: string; requestedAt: string; expectedResourceRevision: number }
): Promise<void> {
  if (input.targetKind === "knowledge_base") {
    await sql`
      UPDATE focowiki.knowledge_bases
      SET deleted_at = ${input.requestedAt}, revision = revision + 1,
          updated_at = ${input.requestedAt}
      WHERE public_id = ${input.knowledgeBaseId}
        AND revision = ${input.expectedResourceRevision}
    `;
  } else if (input.targetKind === "source_directory") {
    await sql`
      UPDATE focowiki.source_directories
      SET deleted_at = ${input.requestedAt}, revision = revision + 1,
          updated_at = ${input.requestedAt}
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND (public_id = ${input.targetPublicId} OR public_id IN (
          SELECT child.public_id FROM focowiki.source_directories root
          JOIN focowiki.source_directories child
            ON child.knowledge_base_id = root.knowledge_base_id
           AND child.normalized_path LIKE root.normalized_path || '/%'
          WHERE root.public_id = ${input.targetPublicId}
        ))
        AND deleted_at IS NULL
    `;
  }
  await sql`
    UPDATE focowiki.source_files
    SET deleted_at = ${input.requestedAt}, revision = revision + 1,
        updated_at = ${input.requestedAt}
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND public_id IN (SELECT public_id FROM document_deletion_sources)
      AND deleted_at IS NULL
  `;
}

async function enqueueDeletionCleanup(
  sql: TransactionSql,
  input: { knowledgeBaseId: string; operationPublicId: string; targetKind: DocumentDeletionTargetKind; targetPublicId: string; requestedAt: string; maximumAttempts: number },
  affectedSourceCount: number,
  requestHash: string
): Promise<void> {
  await sql`
    INSERT INTO focowiki.cleanup_actions (
      public_id, knowledge_base_id, operation_public_id,
      action_kind, cleanup_plane, resource_kind, resource_public_id,
      required, priority, sequence_number, idempotency_key, request_hash,
      checkpoint, state, attempt_count, maximum_attempts, not_before,
      created_at, updated_at
    ) VALUES (
      ${`cleanup-document-deletion-${requestHash}`}, ${input.knowledgeBaseId},
      ${input.operationPublicId}, 'document_resource_deletion', 'postgres',
      ${input.targetKind}, ${input.targetPublicId}, true, 10, 0,
      ${`document-deletion-${requestHash}`}, ${requestHash},
      ${sql.json({ affectedSourceCount, cursor: null })}, 'queued', 0,
      ${input.maximumAttempts},
      ${input.requestedAt}, ${input.requestedAt}, ${input.requestedAt}
    )
  `;
}

function deletionRequestHash(input: {
  knowledgeBaseId: string;
  targetKind: DocumentDeletionTargetKind;
  targetPublicId: string;
  expectedResourceRevision: number;
  maximumAttempts: number;
}): string {
  return createHash("sha256").update(JSON.stringify({
    knowledgeBaseId: input.knowledgeBaseId,
    targetKind: input.targetKind,
    targetPublicId: input.targetPublicId,
    expectedResourceRevision: input.expectedResourceRevision,
    maximumAttempts: input.maximumAttempts
  })).digest("hex");
}

function validateInput(input: {
  knowledgeBaseId: string; targetKind: string; targetPublicId: string;
  expectedResourceRevision: number; operationPublicId: string;
  idempotencyKey: string; maximumAttempts: number;
  requestedAt: string; expiresAt: string;
}): void {
  if (!["source_file", "source_directory", "knowledge_base"].includes(input.targetKind)
    || [input.knowledgeBaseId, input.targetPublicId, input.operationPublicId,
      input.idempotencyKey].some((value) => !value || value.length > 255)
    || !Number.isSafeInteger(input.expectedResourceRevision)
    || input.expectedResourceRevision < 0
    || !Number.isSafeInteger(input.maximumAttempts)
    || input.maximumAttempts < 1 || input.maximumAttempts > 20
    || !Number.isFinite(Date.parse(input.requestedAt))
    || Date.parse(input.expiresAt) <= Date.parse(input.requestedAt)) {
    throw deletionAcceptanceError("input_invalid");
  }
}

function numberField(value: Record<string, unknown> | null, key: string): number {
  const field = value?.[key];
  return typeof field === "number" && Number.isSafeInteger(field) ? field : 0;
}

function deletionAcceptanceError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document deletion acceptance error: ${code}`), { code });
}
