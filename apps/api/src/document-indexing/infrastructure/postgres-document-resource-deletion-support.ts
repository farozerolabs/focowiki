import type { DatabaseClient } from "../../db/client.js";
import type {
  DocumentResourceDeletionAction,
  DocumentResourceDeletionCheckpoint
} from "../application/document-resource-deletion-worker.js";

export type DocumentDeletionActionRow = {
  public_id: string;
  operation_public_id: string;
  knowledge_base_id: string;
  resource_kind: string;
  resource_public_id: string;
  attempt_count: number | string;
  maximum_attempts: number | string;
  checkpoint: Record<string, unknown>;
};

export async function transitionDocumentDeletionToRetry(
  sql: DatabaseClient,
  input: {
    publicId: string;
    owner: string;
    notBefore: string;
    safeErrorCode: string;
    checkpoint: DocumentResourceDeletionCheckpoint;
  }
): Promise<boolean> {
  const rows = await sql<Array<{ public_id: string }>>`
    UPDATE focowiki.cleanup_actions
    SET state = 'retry', checkpoint = ${sql.json(input.checkpoint)},
        attempt_count = CASE
          WHEN ${input.safeErrorCode} = 'DOCUMENT_DELETION_PAGE_REMAINING'
            THEN GREATEST(attempt_count - 1, 0)
          ELSE attempt_count
        END,
        lease_owner = NULL, lease_expires_at = NULL,
        not_before = ${input.notBefore}, safe_error_code = ${input.safeErrorCode},
        updated_at = now()
    WHERE public_id = ${input.publicId}
      AND action_kind = 'document_resource_deletion'
      AND state = 'running' AND lease_owner = ${input.owner}
    RETURNING public_id
  `;
  return rows.length === 1;
}

export async function markDocumentDeletionOperationFailed(
  sql: DatabaseClient,
  input: {
    actionPublicId: string;
    safeErrorCode: string;
    failedAt: string;
  }
): Promise<void> {
  await sql`
    UPDATE focowiki.operations operation
    SET state = 'failed', completed_at = ${input.failedAt},
        updated_at = ${input.failedAt}
    FROM focowiki.cleanup_actions action
    WHERE action.public_id = ${input.actionPublicId}
      AND operation.knowledge_base_id = action.knowledge_base_id
      AND operation.public_id = action.operation_public_id
      AND operation.state = 'processing'
  `;
  await sql`
    INSERT INTO focowiki.operation_results (
      public_id, knowledge_base_id, operation_kind, terminal_state,
      result_code, result_summary, correlation_public_id,
      completed_at, expires_at
    )
    SELECT operation.public_id, operation.knowledge_base_id, 'deletion',
           'failed', ${input.safeErrorCode}, '{}'::jsonb,
           action.resource_public_id, ${input.failedAt},
           ${new Date(Date.parse(input.failedAt) + 7 * 86_400_000).toISOString()}
    FROM focowiki.operations operation
    JOIN focowiki.cleanup_actions action
      ON action.knowledge_base_id = operation.knowledge_base_id
     AND action.operation_public_id = operation.public_id
    WHERE action.public_id = ${input.actionPublicId}
    ON CONFLICT (public_id) DO NOTHING
  `;
}

export function mapDocumentDeletionAction(
  row: DocumentDeletionActionRow
): DocumentResourceDeletionAction {
  const targetKind = row.resource_kind;
  if (!["source_file", "source_directory", "knowledge_base"].includes(
    targetKind
  )) {
    throw documentDeletionError("stored_action_invalid");
  }
  const checkpoint = row.checkpoint;
  return {
    publicId: row.public_id,
    operationPublicId: row.operation_public_id,
    knowledgeBaseId: row.knowledge_base_id,
    targetKind: targetKind as DocumentResourceDeletionAction["targetKind"],
    targetPublicId: row.resource_public_id,
    attempt: Number(row.attempt_count),
    maximumAttempts: Number(row.maximum_attempts),
    checkpoint: {
      phase: typeof checkpoint.phase === "string"
        ? checkpoint.phase as DocumentResourceDeletionCheckpoint["phase"]
        : "deactivate",
      cursor: typeof checkpoint.cursor === "string" ? checkpoint.cursor : null,
      affectedSourceCount: Number(checkpoint.affectedSourceCount ?? 0)
    }
  };
}

export function documentDeletionResult(
  action: DocumentResourceDeletionAction,
  phase: DocumentResourceDeletionCheckpoint["phase"],
  cursor: string | null,
  processedSourceCount: number,
  done: boolean
) {
  return {
    done,
    processedSourceCount,
    checkpoint: {
      phase,
      cursor,
      affectedSourceCount: action.checkpoint.affectedSourceCount
    }
  };
}

export function documentDeletionError(code: string): Error & { code: string } {
  return Object.assign(new Error(`PostgreSQL document deletion error: ${code}`), {
    code
  });
}
