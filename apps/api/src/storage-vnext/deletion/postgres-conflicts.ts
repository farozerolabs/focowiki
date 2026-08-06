import { createHash } from "node:crypto";
import type {
  StorageVnextDeletionTarget,
  StorageVnextDeletionTransaction,
  StorageVnextTerminatedCandidate
} from "./postgres-types.js";
import type { StorageVnextNormalizedDeletionRequest } from "./ports.js";

type LiveDeletionRow = {
  operation_public_id: string;
  target_kind: string | null;
  target_public_id: string | null;
  normalized_path: string | null;
};

export async function assertDeletionPriority(
  transaction: StorageVnextDeletionTransaction,
  request: StorageVnextNormalizedDeletionRequest,
  target: StorageVnextDeletionTarget
): Promise<void> {
  if (request.targetKind === "knowledge_base") return;
  const live = await transaction<LiveDeletionRow[]>`
    SELECT operation.public_id AS operation_public_id,
           operation.target_kind, operation.target_public_id,
           CASE operation.target_kind
             WHEN 'source_directory' THEN directory.normalized_path
             WHEN 'source_file' THEN source.normalized_path
             ELSE NULL
           END AS normalized_path
    FROM focowiki.operation_work_items work
    JOIN focowiki.operations operation
      ON operation.knowledge_base_id = work.knowledge_base_id
     AND operation.public_id = work.operation_public_id
    LEFT JOIN focowiki.source_directories directory
      ON operation.target_kind = 'source_directory'
     AND directory.knowledge_base_id = operation.knowledge_base_id
     AND directory.public_id = operation.target_public_id
    LEFT JOIN focowiki.source_files source
      ON operation.target_kind = 'source_file'
     AND source.knowledge_base_id = operation.knowledge_base_id
     AND source.public_id = operation.target_public_id
    WHERE work.knowledge_base_id = ${request.knowledgeBaseId}
      AND work.work_kind = 'deletion'
      AND work.state IN ('queued', 'running', 'retry')
      AND operation.public_id <> ${request.operationPublicId}
    ORDER BY operation.public_id
    FOR UPDATE OF work, operation
  `;
  const targetPath = target.normalizedPath;
  for (const item of live) {
    if (item.target_kind === "knowledge_base") throw deletionConflict();
    if (item.target_public_id === request.targetPublicId) throw deletionConflict();
    if (
      request.targetKind === "source_file"
      && item.target_kind === "source_directory"
      && targetPath
      && item.normalized_path
      && targetPath.startsWith(`${item.normalized_path}/`)
    ) throw deletionConflict();
    if (
      request.targetKind === "source_directory"
      && item.target_kind === "source_directory"
      && targetPath
      && item.normalized_path
      && targetPath.startsWith(`${item.normalized_path}/`)
    ) throw deletionConflict();
  }
}

export async function terminateLiveCandidate(
  transaction: StorageVnextDeletionTransaction,
  request: StorageVnextNormalizedDeletionRequest
): Promise<StorageVnextTerminatedCandidate> {
  const candidates = await transaction<Array<{
    public_id: string;
    operation_public_id: string;
    candidate_root_public_id: string;
    provider_index_uid: string | null;
  }>>`
    SELECT candidate.public_id, candidate.operation_public_id,
           candidate.candidate_root_public_id,
           search.provider_index_uid
    FROM focowiki.release_candidates candidate
    LEFT JOIN focowiki.search_projections search
      ON search.knowledge_base_id = candidate.knowledge_base_id
     AND search.projection_role = 'candidate'
    WHERE candidate.knowledge_base_id = ${request.knowledgeBaseId}
      AND candidate.state IN ('building', 'validating', 'ready')
    FOR UPDATE OF candidate
  `;
  const candidate = candidates[0];
  if (!candidate) return { operationPublicId: null, providerIndexUid: null };
  const objectIds = await transaction<Array<{ object_id: string }>>`
    SELECT object_id
    FROM focowiki.object_owners
    WHERE knowledge_base_id = ${request.knowledgeBaseId}
      AND release_root_public_id = ${candidate.candidate_root_public_id}
  `;
  await transaction`
    DELETE FROM focowiki.release_candidates
    WHERE public_id = ${candidate.public_id}
  `;
  await transaction`
    DELETE FROM focowiki.search_projections
    WHERE knowledge_base_id = ${request.knowledgeBaseId}
      AND projection_role = 'candidate'
  `;
  await transaction`
    DELETE FROM focowiki.release_roots
    WHERE knowledge_base_id = ${request.knowledgeBaseId}
      AND public_id = ${candidate.candidate_root_public_id}
      AND root_role = 'candidate'
  `;
  await markZeroOwnerObjects(
    transaction,
    objectIds.map((item) => item.object_id),
    request.requestedAt
  );
  return {
    operationPublicId: candidate.operation_public_id,
    providerIndexUid: candidate.provider_index_uid
  };
}

export async function supersedeConflictingWork(input: {
  transaction: StorageVnextDeletionTransaction;
  request: StorageVnextNormalizedDeletionRequest;
  target: StorageVnextDeletionTarget;
  candidateOperationPublicId: string | null;
}): Promise<number> {
  const { transaction, request, target } = input;
  const scope = conflictScope(transaction, request, target);
  const rows = await transaction<Array<{ public_id: string }>>`
    SELECT operation.public_id
    FROM focowiki.operation_work_items work
    JOIN focowiki.operations operation
      ON operation.knowledge_base_id = work.knowledge_base_id
     AND operation.public_id = work.operation_public_id
    WHERE work.knowledge_base_id = ${request.knowledgeBaseId}
      AND work.state IN ('queued', 'running', 'retry')
      AND work.work_kind <> 'deletion'
      AND operation.public_id <> ${request.operationPublicId}
      AND (
        operation.public_id = ${input.candidateOperationPublicId}
        OR work.work_kind IN ('maintenance', 'reconciliation')
        OR ${scope}
      )
    ORDER BY operation.public_id
    FOR UPDATE OF work, operation
  `;
  const operationPublicIds = rows.map((row) => row.public_id);
  if (operationPublicIds.length === 0) return 0;
  const objectIds = await transaction<Array<{ object_id: string }>>`
    DELETE FROM focowiki.object_owners
    WHERE knowledge_base_id = ${request.knowledgeBaseId}
      AND owner_kind = 'live_reservation'
      AND operation_public_id = ANY(${operationPublicIds})
    RETURNING object_id
  `;
  await transaction`
    DELETE FROM focowiki.upload_sessions
    WHERE knowledge_base_id = ${request.knowledgeBaseId}
      AND operation_public_id = ANY(${operationPublicIds})
  `;
  await transaction`
    DELETE FROM focowiki.mutation_path_reservations
    WHERE knowledge_base_id = ${request.knowledgeBaseId}
      AND operation_public_id = ANY(${operationPublicIds})
  `;
  await transaction`
    DELETE FROM focowiki.cleanup_actions
    WHERE knowledge_base_id = ${request.knowledgeBaseId}
      AND operation_public_id = ANY(${operationPublicIds})
  `;
  await transaction`
    DELETE FROM focowiki.operation_work_items
    WHERE knowledge_base_id = ${request.knowledgeBaseId}
      AND operation_public_id = ANY(${operationPublicIds})
  `;
  await transaction`
    UPDATE focowiki.operations
    SET state = 'superseded', completed_at = ${request.requestedAt},
        updated_at = ${request.requestedAt}
    WHERE knowledge_base_id = ${request.knowledgeBaseId}
      AND public_id = ANY(${operationPublicIds})
      AND state IN ('accepted', 'validating', 'processing', 'publishing')
  `;
  await transaction`
    INSERT INTO focowiki.operation_results (
      public_id, knowledge_base_id, operation_kind, terminal_state,
      result_code, safe_message, result_summary, correlation_public_id,
      completed_at, expires_at
    )
    SELECT operation.public_id, operation.knowledge_base_id,
           operation.operation_kind, 'superseded', 'DELETION_SUPERSEDED',
           NULL, ${transaction.json({
             successorOperationPublicId: request.operationPublicId
           })}, ${request.operationPublicId}, ${request.requestedAt}, ${request.expiresAt}
    FROM focowiki.operations operation
    WHERE operation.knowledge_base_id = ${request.knowledgeBaseId}
      AND operation.public_id = ANY(${operationPublicIds})
    ON CONFLICT (public_id) DO NOTHING
  `;
  await markZeroOwnerObjects(
    transaction,
    objectIds.map((item) => item.object_id),
    request.requestedAt
  );
  return operationPublicIds.length;
}

function conflictScope(
  transaction: StorageVnextDeletionTransaction,
  request: StorageVnextNormalizedDeletionRequest,
  target: StorageVnextDeletionTarget
) {
  if (request.targetKind === "knowledge_base") return transaction`TRUE`;
  if (request.targetKind === "source_file") {
    return transaction`
      operation.target_public_id = ${request.targetPublicId}
      OR EXISTS (
        SELECT 1
        FROM focowiki.upload_entries entry
        JOIN focowiki.upload_sessions session
          ON session.public_id = entry.upload_session_public_id
         AND session.knowledge_base_id = entry.knowledge_base_id
        WHERE session.operation_public_id = operation.public_id
          AND entry.source_file_public_id = ${request.targetPublicId}
      )
    `;
  }
  return transaction`
    operation.target_public_id = ${request.targetPublicId}
    OR EXISTS (
      SELECT 1 FROM focowiki.source_directories directory
      WHERE directory.knowledge_base_id = ${request.knowledgeBaseId}
        AND directory.public_id = operation.target_public_id
        AND (
          directory.normalized_path = ${target.normalizedPath}
          OR directory.normalized_path LIKE ${`${escapeLike(target.normalizedPath!)}/%`} ESCAPE '\\'
        )
    )
    OR EXISTS (
      SELECT 1 FROM focowiki.source_files source
      WHERE source.knowledge_base_id = ${request.knowledgeBaseId}
        AND source.public_id = operation.target_public_id
        AND source.normalized_path LIKE ${`${escapeLike(target.normalizedPath!)}/%`} ESCAPE '\\'
    )
    OR EXISTS (
      SELECT 1
      FROM focowiki.upload_entries entry
      JOIN focowiki.upload_sessions session
        ON session.public_id = entry.upload_session_public_id
       AND session.knowledge_base_id = entry.knowledge_base_id
      WHERE session.operation_public_id = operation.public_id
        AND entry.normalized_path LIKE ${`${escapeLike(target.normalizedPath!)}/%`} ESCAPE '\\'
    )
  `;
}

async function markZeroOwnerObjects(
  transaction: StorageVnextDeletionTransaction,
  objectIds: readonly string[],
  deletedAt: string
): Promise<void> {
  if (objectIds.length === 0) return;
  await transaction`
    UPDATE focowiki.object_registrations object
    SET zero_owner_since = COALESCE(object.zero_owner_since, ${deletedAt})
    WHERE object.object_id = ANY(${[...new Set(objectIds)]})
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.object_owners owner
        WHERE owner.object_id = object.object_id
      )
  `;
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function deletionConflict(): Error {
  return Object.assign(new Error("Storage vNext deletion conflict"), {
    code: "deletion_conflict"
  });
}

export function storageVnextDeletionIdentity(kind: string, ...values: string[]): string {
  return `deletion-${kind}-${createHash("sha256")
    .update(values.join("\0"))
    .digest("hex")}`;
}
