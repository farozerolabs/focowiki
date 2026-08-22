import type { TransactionSql } from "postgres";
import {
  finalizeKnowledgeBasePublicationObjectCleanup,
  prepareKnowledgeBasePublicationObjectCleanup
} from "./postgres-knowledge-base-publication-cleanup.js";

const OPERATION_TOMBSTONE_RETENTION_MS = 7 * 86_400_000;

export async function preserveDeletionOperationAndRemoveKnowledgeBase(input: {
  sql: TransactionSql;
  actionPublicId: string;
  knowledgeBaseId: string;
  completedAt: string;
}): Promise<boolean> {
  await input.sql`
    INSERT INTO focowiki.operation_tombstones (
      public_id, knowledge_base_id, operation_kind, state,
      expected_resource_revision, target_kind, target_public_id,
      candidate_relative_path, result_summary, result_code,
      created_at, updated_at, completed_at, expires_at
    )
    SELECT operation.public_id, operation.knowledge_base_id,
           operation.operation_kind, operation.state,
           operation.expected_resource_revision,
           operation.target_kind, operation.target_public_id,
           operation.candidate_relative_path,
           coalesce(result.result_summary, '{}'::jsonb),
           result.result_code,
           operation.created_at, operation.updated_at,
           coalesce(operation.completed_at, ${input.completedAt}),
           ${new Date(
             Date.parse(input.completedAt) + OPERATION_TOMBSTONE_RETENTION_MS
           ).toISOString()}
    FROM focowiki.operations operation
    LEFT JOIN focowiki.operation_results result
      ON result.knowledge_base_id = operation.knowledge_base_id
     AND result.public_id = operation.public_id
    WHERE operation.knowledge_base_id = ${input.knowledgeBaseId}
      AND operation.public_id = (
        SELECT action.operation_public_id
        FROM focowiki.cleanup_actions action
        WHERE action.public_id = ${input.actionPublicId}
      )
      AND operation.operation_kind = 'deletion'
      AND operation.target_kind = 'knowledge_base'
      AND operation.state IN ('completed', 'failed')
    ON CONFLICT (public_id) DO NOTHING
  `;
  const operationRows = await input.sql<Array<{ operation_public_id: string }>>`
    SELECT operation_public_id
    FROM focowiki.cleanup_actions
    WHERE public_id = ${input.actionPublicId}
  `;
  const operationPublicId = operationRows[0]?.operation_public_id;
  if (!operationPublicId) return false;
  await prepareKnowledgeBasePublicationObjectCleanup({
    sql: input.sql,
    knowledgeBaseId: input.knowledgeBaseId,
    operationPublicId,
    queuedAt: input.completedAt
  });
  const deleted = await input.sql<Array<{ public_id: string }>>`
    DELETE FROM focowiki.knowledge_bases
    WHERE public_id = ${input.knowledgeBaseId}
      AND deleted_at IS NOT NULL
    RETURNING public_id
  `;
  if (deleted.length !== 1) return false;
  await finalizeKnowledgeBasePublicationObjectCleanup({
    sql: input.sql,
    knowledgeBaseId: input.knowledgeBaseId,
    operationPublicId,
    releasedAt: input.completedAt
  });
  return true;
}
