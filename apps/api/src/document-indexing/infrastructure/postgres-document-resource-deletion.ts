import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import type {
  DocumentResourceDeletionAction,
  DocumentResourceDeletionCheckpoint
} from "../application/document-resource-deletion-worker.js";
import {
  documentDeletionError as deletionError,
  documentDeletionResult as result,
  mapDocumentDeletionAction as mapAction,
  markDocumentDeletionOperationFailed as markDeletionOperationFailed,
  transitionDocumentDeletionToRetry as transitionToRetry,
  type DocumentDeletionActionRow
} from "./postgres-document-resource-deletion-support.js";
import { enqueueTerminalDeletionEvent } from
  "./postgres-document-deletion-events.js";
import {
  purgeRetiredEmbeddingArtifacts,
  retireEmbeddingArtifacts
} from "./postgres-document-embedding-deletion.js";
import { obsoleteOrphanRelations } from
  "./postgres-document-relation-deletion.js";
import {
  enqueueExternalArtifactCleanup,
  enqueuePurgedSourceObjectCleanup,
  releaseDeletedSourceObjectOwnership
} from "./postgres-document-object-cleanup.js";
import { terminalizePostgresDocumentWork } from
  "./postgres-document-work-terminalization.js";
import { transferSharedGeneratedPageCandidates } from
  "./postgres-generated-page-owner-transfer.js";
import { convergePostgresUploadDocumentOperation } from
  "./postgres-upload-operation-aggregation.js";
import { preserveDeletionOperationAndRemoveKnowledgeBase } from
  "./postgres-deletion-operation-tombstone.js";

export function createPostgresDocumentResourceDeletion(
  sql: DatabaseClient,
  options: { webhookRetentionMilliseconds?: number } = {}
) {
  return {
    actions: {
      async recoverStale(input: {
        expiredBefore: string;
        notBefore: string;
        safeErrorCode: string;
        limit: number;
      }): Promise<number> {
        const rows = await sql<Array<{ public_id: string }>>`
          WITH stale AS (
            SELECT public_id FROM focowiki.cleanup_actions
            WHERE action_kind = 'document_resource_deletion'
              AND state = 'running' AND lease_expires_at <= ${input.expiredBefore}
            ORDER BY lease_expires_at, public_id COLLATE "C"
            FOR UPDATE SKIP LOCKED
            LIMIT ${input.limit}
          )
          UPDATE focowiki.cleanup_actions action
          SET state = 'retry', lease_owner = NULL, lease_expires_at = NULL,
              not_before = ${input.notBefore},
              safe_error_code = ${input.safeErrorCode}, updated_at = now()
          FROM stale
          WHERE action.public_id = stale.public_id
          RETURNING action.public_id
        `;
        return rows.length;
      },

      async claim(input: {
        owner: string;
        limit: number;
        leaseExpiresAt: string;
      }): Promise<readonly DocumentResourceDeletionAction[]> {
        const rows = await sql<DocumentDeletionActionRow[]>`
          WITH candidates AS (
            SELECT public_id FROM focowiki.cleanup_actions
            WHERE action_kind = 'document_resource_deletion'
              AND state IN ('queued', 'retry') AND not_before <= now()
            ORDER BY priority, not_before, public_id COLLATE "C"
            FOR UPDATE SKIP LOCKED
            LIMIT ${input.limit}
          )
          UPDATE focowiki.cleanup_actions action
          SET state = 'running', attempt_count = action.attempt_count + 1,
              lease_owner = ${input.owner},
              lease_expires_at = ${input.leaseExpiresAt},
              safe_error_code = NULL, updated_at = now()
          FROM candidates
          WHERE action.public_id = candidates.public_id
          RETURNING action.public_id, action.operation_public_id,
                    action.knowledge_base_id, action.resource_kind,
                    action.resource_public_id, action.attempt_count,
                    action.maximum_attempts, action.checkpoint
        `;
        return rows.map(mapAction);
      },

      releaseForRetry(input: {
        publicId: string;
        owner: string;
        notBefore: string;
        safeErrorCode: string;
        checkpoint: DocumentResourceDeletionCheckpoint;
      }) {
        return transitionToRetry(sql, input);
      },

      async complete(input: {
        publicId: string;
        owner: string;
        completedAt: string;
      }): Promise<boolean> {
        return sql.begin(async (transaction) => {
          const rows = await transaction<Array<{
            knowledge_base_id: string;
            resource_kind: string;
          }>>`
            UPDATE focowiki.cleanup_actions
            SET state = 'completed', checkpoint = checkpoint || ${sql.json({
                  phase: "completed",
                  cursor: null
                })},
                lease_owner = NULL, lease_expires_at = NULL,
                completed_at = ${input.completedAt}, updated_at = ${input.completedAt}
            WHERE public_id = ${input.publicId}
              AND action_kind = 'document_resource_deletion'
              AND state = 'running' AND lease_owner = ${input.owner}
            RETURNING knowledge_base_id, resource_kind
          `;
          const completed = rows[0];
          if (!completed) return false;
          if (completed.resource_kind !== "knowledge_base") return true;
          return preserveDeletionOperationAndRemoveKnowledgeBase({
            sql: transaction,
            actionPublicId: input.publicId,
            knowledgeBaseId: completed.knowledge_base_id,
            completedAt: input.completedAt
          });
        });
      },

      async fail(input: {
        publicId: string;
        owner: string;
        failedAt: string;
        safeErrorCode: string;
        checkpoint: DocumentResourceDeletionCheckpoint;
      }): Promise<boolean> {
        const rows = await sql<Array<{ public_id: string }>>`
          UPDATE focowiki.cleanup_actions
          SET state = 'failed', checkpoint = ${sql.json(input.checkpoint)},
              lease_owner = NULL, lease_expires_at = NULL,
              safe_error_code = ${input.safeErrorCode},
              completed_at = ${input.failedAt}, updated_at = ${input.failedAt}
          WHERE public_id = ${input.publicId}
            AND action_kind = 'document_resource_deletion'
            AND state = 'running' AND lease_owner = ${input.owner}
          RETURNING public_id
        `;
        if (rows.length === 1) await markDeletionOperationFailed(sql, {
          actionPublicId: input.publicId,
          safeErrorCode: input.safeErrorCode,
          failedAt: input.failedAt
        });
        return rows.length === 1;
      }
    },

    processor: {
      async processPage(input: {
        action: DocumentResourceDeletionAction;
        pageSize: number;
        now: string;
        signal: AbortSignal;
      }) {
        if (input.signal.aborted) {
          throw input.signal.reason ?? deletionError("cancelled");
        }
        if (input.action.checkpoint.phase === "deactivate") {
          return sql.begin((transaction) => deactivatePage(
            transaction,
            input.action,
            input.pageSize,
            input.now,
            "await_external"
          ));
        }
        if (input.action.checkpoint.phase === "await_external") {
          return awaitExternalCleanup(sql, input.action);
        }
        if (input.action.checkpoint.phase === "purge") {
          return sql.begin((transaction) => purgePage(
            transaction,
            input.action,
            input.pageSize,
            input.now,
            options
          ));
        }
        return {
          done: true,
          processedSourceCount: 0,
          checkpoint: input.action.checkpoint
        };
      }
    }
  };
}

async function deactivatePage(
  sql: TransactionSql,
  action: DocumentResourceDeletionAction,
  pageSize: number,
  now: string,
  nextPhase: "reconcile_projection" | "await_external"
) {
  const sourceIds = await selectSourcePage(sql, action, pageSize, false);
  if (sourceIds.length === 0) {
    await obsoleteOrphanRelations(sql, action.knowledgeBaseId, now);
    return result(action, nextPhase, null, 0, false);
  }
  const ids = sourceIds.map((row) => row.public_id);
  const deletingJobs = await sql<Array<{ public_id: string }>>`
    WITH latest_jobs AS (
      SELECT DISTINCT ON (job.source_file_public_id) job.public_id
      FROM focowiki.document_processing_jobs job
      WHERE job.knowledge_base_id = ${action.knowledgeBaseId}
        AND job.source_file_public_id = ANY(${ids}::text[])
        AND job.state NOT IN ('cancelled', 'superseded')
      ORDER BY job.source_file_public_id,
               job.accepted_at DESC, job.public_id DESC
    )
    UPDATE focowiki.document_processing_jobs job
    SET state = 'deleting', terminal_at = NULL,
        next_attempt_at = NULL,
        safe_error_code = NULL, safe_error_message = NULL, retryable = false,
        active_work_kinds = '{}'::text[], blocking_work_kind = NULL,
        retrying_work_kind = NULL,
        revision = revision + 1, updated_at = GREATEST(updated_at, ${now})
    FROM latest_jobs latest
    WHERE job.public_id = latest.public_id
    RETURNING job.public_id
  `;
  await terminalizePostgresDocumentWork({
    sql,
    documentJobPublicIds: deletingJobs.map((job) => job.public_id),
    state: "cancelled",
    terminalAt: now
  });
  await sql`
    UPDATE focowiki.source_file_active_revisions
    SET active_source_revision_public_id = NULL, updated_at = ${now}
    WHERE knowledge_base_id = ${action.knowledgeBaseId}
      AND source_file_public_id = ANY(${ids}::text[])
  `;
  await sql`
    UPDATE focowiki.document_projection_records
    SET active = false, retired_at = coalesce(retired_at, ${now})
    WHERE knowledge_base_id = ${action.knowledgeBaseId}
      AND source_file_public_id = ANY(${ids}::text[])
      AND active
  `;
  await sql`
    UPDATE focowiki.search_document_owners
    SET state = 'obsolete', updated_at = ${now}
    WHERE knowledge_base_id = ${action.knowledgeBaseId}
      AND source_file_public_id = ANY(${ids}::text[])
      AND state IN ('staged', 'active')
  `;
  await sql`
    UPDATE focowiki.semantic_vector_documents
    SET state = 'deleted', deleted_at = ${now}
    WHERE knowledge_base_id = ${action.knowledgeBaseId}
      AND source_file_public_id = ANY(${ids}::text[])
      AND state <> 'deleted'
  `;
  await enqueueExternalArtifactCleanup(sql, action, ids, now);
  await retireEmbeddingArtifacts(sql, action, ids);
  await sql`
    UPDATE focowiki.relation_directed_evidence
    SET active = false, retired_at = ${now}
    WHERE knowledge_base_id = ${action.knowledgeBaseId}
      AND (source_file_public_id = ANY(${ids}::text[])
        OR target_source_file_public_id = ANY(${ids}::text[]))
      AND active AND retired_at IS NULL
  `;
  await sql`
    UPDATE focowiki.unresolved_file_references
    SET resolution_state = 'obsolete', updated_at = ${now}
    WHERE knowledge_base_id = ${action.knowledgeBaseId}
      AND source_file_public_id = ANY(${ids}::text[])
      AND resolution_state <> 'obsolete'
  `;
  await sql`
    DELETE FROM focowiki.generated_page_heads
    WHERE knowledge_base_id = ${action.knowledgeBaseId}
      AND source_file_public_id = ANY(${ids}::text[])
  `;
  await releaseDeletedSourceObjectOwnership(sql, action, ids, now);
  const cursor = ids.at(-1) ?? null;
  return result(
    action,
    sourceIds.length < pageSize ? nextPhase : "deactivate",
    sourceIds.length < pageSize ? null : cursor,
    sourceIds.length,
    false
  );
}

async function awaitExternalCleanup(
  sql: DatabaseClient,
  action: DocumentResourceDeletionAction
) {
  const rows = await sql<Array<{ live_count: number | string; failed_count: number | string }>>`
    SELECT
      count(*) FILTER (WHERE state IN ('queued', 'running', 'retry')) AS live_count,
      count(*) FILTER (WHERE state = 'failed') AS failed_count
    FROM focowiki.cleanup_actions
    WHERE knowledge_base_id = ${action.knowledgeBaseId}
      AND operation_public_id = ${action.operationPublicId}
      AND action_kind IN ('document_obsolete_artifact', 'zero_owner_object')
  `;
  if (Number(rows[0]?.failed_count ?? 0) > 0) {
    throw deletionError("external_cleanup_failed");
  }
  if (Number(rows[0]?.live_count ?? 0) > 0) {
    return result(action, "await_external", null, 0, false);
  }
  return result(action, "purge", null, 0, false);
}

async function purgePage(
  sql: TransactionSql,
  action: DocumentResourceDeletionAction,
  pageSize: number,
  now: string,
  options: { webhookRetentionMilliseconds?: number }
) {
  const sourceIds = await selectSourcePage(sql, action, pageSize, true);
  if (sourceIds.length > 0) {
    const ids = sourceIds.map((row) => row.public_id);
    const sourceObjects = await sql<Array<{ object_id: string }>>`
      SELECT DISTINCT revision.object_id
      FROM focowiki.source_revisions revision
      WHERE revision.knowledge_base_id = ${action.knowledgeBaseId}
        AND revision.source_file_public_id = ANY(${ids}::text[])
    `;
    await transferSharedGeneratedPageCandidates({
      sql,
      knowledgeBaseId: action.knowledgeBaseId,
      sourceFilePublicIds: ids,
      ownerOperationPublicId: action.operationPublicId
    });
    await terminalizeDeletingJobsAndConvergeUploads(
      sql,
      action.knowledgeBaseId,
      ids,
      now
    );
    await sql`
      DELETE FROM focowiki.source_files
      WHERE knowledge_base_id = ${action.knowledgeBaseId}
        AND public_id = ANY(${ids}::text[])
    `;
    await enqueuePurgedSourceObjectCleanup(
      sql,
      action,
      sourceObjects.map((row) => row.object_id),
      now
    );
    return result(
      action,
      sourceIds.length < pageSize ? "purge" : "purge",
      sourceIds.length < pageSize ? null : ids.at(-1) ?? null,
      sourceIds.length,
      false
    );
  }
  if (action.targetKind === "source_directory") {
    await sql`
      DELETE FROM focowiki.source_directories
      WHERE knowledge_base_id = ${action.knowledgeBaseId}
        AND public_id = ${action.targetPublicId}
    `;
  }
  const retiredEmbeddingObjects = await purgeRetiredEmbeddingArtifacts(
    sql,
    action,
    pageSize,
    now
  );
  if (retiredEmbeddingObjects > 0) {
    return result(action, "await_external", null, 0, false);
  }
  await sql`
    UPDATE focowiki.operations
    SET state = 'completed', completed_at = ${now}, updated_at = ${now}
    WHERE knowledge_base_id = ${action.knowledgeBaseId}
      AND public_id = ${action.operationPublicId}
      AND state = 'processing'
  `;
  await sql`
    INSERT INTO focowiki.operation_results (
      public_id, knowledge_base_id, operation_kind, terminal_state,
      result_code, result_summary, correlation_public_id,
      completed_at, expires_at
    ) VALUES (
      ${action.operationPublicId}, ${action.knowledgeBaseId}, 'deletion',
      'completed', 'DELETION_COMPLETED',
      ${sql.json({
        targetKind: action.targetKind,
        targetPublicId: action.targetPublicId,
        affectedSourceCount: action.checkpoint.affectedSourceCount
      })}, ${action.targetPublicId}, ${now},
      ${new Date(Date.parse(now) + 7 * 86_400_000).toISOString()}
    )
    ON CONFLICT (public_id) DO NOTHING
  `;
  await enqueueTerminalDeletionEvent(sql, action, now, options);
  return result(action, "completed", null, 0, true);
}

async function terminalizeDeletingJobsAndConvergeUploads(
  sql: TransactionSql,
  knowledgeBaseId: string,
  sourceFilePublicIds: readonly string[],
  terminalAt: string
): Promise<void> {
  const rows = await sql<Array<{ operation_public_id: string }>>`
    UPDATE focowiki.document_processing_jobs
    SET state = 'cancelled',
        cancellation_requested_at = coalesce(cancellation_requested_at, ${terminalAt}),
        started_at = coalesce(started_at, accepted_at),
        terminal_at = ${terminalAt}, next_attempt_at = NULL,
        safe_error_code = NULL, safe_error_message = NULL,
        retryable = false, active_work_kinds = '{}'::text[],
        blocking_work_kind = NULL, retrying_work_kind = NULL,
        revision = revision + 1, updated_at = ${terminalAt}
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND source_file_public_id = ANY(${sourceFilePublicIds}::text[])
      AND state = 'deleting'
    RETURNING operation_public_id
  `;
  for (const operationPublicId of new Set(
    rows.map((row) => row.operation_public_id)
  )) {
    await convergePostgresUploadDocumentOperation(sql, {
      knowledgeBaseId,
      operationPublicId,
      completedAt: terminalAt
    });
  }
}

async function selectSourcePage(
  sql: TransactionSql,
  action: DocumentResourceDeletionAction,
  limit: number,
  includeDeleted: boolean
): Promise<Array<{ public_id: string }>> {
  const cursor = action.checkpoint.cursor ?? "";
  if (action.targetKind === "source_file") {
    return sql<Array<{ public_id: string }>>`
      SELECT public_id FROM focowiki.source_files
      WHERE knowledge_base_id = ${action.knowledgeBaseId}
        AND public_id = ${action.targetPublicId}
        AND public_id COLLATE "C" > ${cursor} COLLATE "C"
        AND (${includeDeleted} OR deleted_at IS NOT NULL)
      ORDER BY public_id COLLATE "C" LIMIT ${limit}
      FOR UPDATE
    `;
  }
  if (action.targetKind === "source_directory") {
    return sql<Array<{ public_id: string }>>`
      SELECT source.public_id FROM focowiki.source_files source
      JOIN focowiki.source_directories root
        ON root.knowledge_base_id = source.knowledge_base_id
       AND root.public_id = ${action.targetPublicId}
      WHERE source.knowledge_base_id = ${action.knowledgeBaseId}
        AND source.normalized_path LIKE root.normalized_path || '/%'
        AND source.public_id COLLATE "C" > ${cursor} COLLATE "C"
        AND (${includeDeleted} OR source.deleted_at IS NOT NULL)
      ORDER BY source.public_id COLLATE "C" LIMIT ${limit}
      FOR UPDATE OF source
    `;
  }
  return sql<Array<{ public_id: string }>>`
    SELECT public_id FROM focowiki.source_files
    WHERE knowledge_base_id = ${action.knowledgeBaseId}
      AND public_id COLLATE "C" > ${cursor} COLLATE "C"
      AND (${includeDeleted} OR deleted_at IS NOT NULL)
    ORDER BY public_id COLLATE "C" LIMIT ${limit}
    FOR UPDATE
  `;
}
