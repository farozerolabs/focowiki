import type {
  StorageVnextDeletionTarget,
  StorageVnextDeletionTransaction,
  StorageVnextDeletionTransactionResult,
  StorageVnextDeletionVisibilityResult
} from "./postgres-types.js";
import type { StorageVnextNormalizedDeletionRequest } from "./ports.js";
import {
  assertDeletionPriority,
  storageVnextDeletionIdentity,
  supersedeConflictingWork,
  terminateLiveCandidate
} from "./postgres-conflicts.js";
import type { SearchProviderKind } from
  "../../application/ports/search-provider-runtime.js";

export async function acceptStorageVnextDeletion(input: {
  transaction: StorageVnextDeletionTransaction;
  request: StorageVnextNormalizedDeletionRequest;
}): Promise<StorageVnextDeletionTransactionResult> {
  const { transaction, request } = input;
  const knowledgeBase = await transaction<Array<{
    revision: number | string;
    deleted_at: Date | null;
  }>>`
    SELECT revision, deleted_at
    FROM focowiki.knowledge_bases
    WHERE public_id = ${request.knowledgeBaseId}
    FOR UPDATE
  `;
  if (!knowledgeBase[0]) throw repositoryError("resource_missing");
  const replay = await readReplay(transaction, request);
  if (replay) return replay;
  if (knowledgeBase[0].deleted_at) throw repositoryError("resource_missing");
  const target = await lockTarget(transaction, request, knowledgeBase[0].revision);
  if (target.revision !== request.expectedResourceRevision) {
    throw repositoryError("revision_conflict");
  }
  await assertDeletionPriority(transaction, request, target);
  const activeSearch = await transaction<Array<{
    provider_kind: SearchProviderKind;
    provider_index_uid: string;
  }>>`
    SELECT provider_kind, provider_index_uid
    FROM focowiki.search_projections
    WHERE knowledge_base_id = ${request.knowledgeBaseId}
      AND projection_role = 'active'
    FOR UPDATE
  `;
  const candidate = await terminateLiveCandidate(transaction, request);
  const supersededWorkCount = await supersedeConflictingWork({
    transaction,
    request,
    target,
    candidateOperationPublicId: candidate.operationPublicId
  });
  const visibility = await commitVisibility(transaction, request, target);
  await insertDeletionWork(transaction, request, target, visibility, {
    activeSearchProviderKind: activeSearch[0]?.provider_kind ?? null,
    activeSearchProviderIndexUid: activeSearch[0]?.provider_index_uid ?? null,
    candidateSearchProviderKind: candidate.providerKind,
    candidateSearchProviderIndexUid: candidate.providerIndexUid,
    supersededWorkCount
  });
  return {
    outcome: "queued",
    operationPublicId: request.operationPublicId,
    state: "queued",
    visibilityCommitted: true
  };
}

async function readReplay(
  transaction: StorageVnextDeletionTransaction,
  request: StorageVnextNormalizedDeletionRequest
): Promise<StorageVnextDeletionTransactionResult | null> {
  const rows = await transaction<Array<{
    request_hash: string;
    operation_public_id: string;
  }>>`
    SELECT request_hash, operation_public_id
    FROM focowiki.operation_idempotency
    WHERE knowledge_base_id = ${request.knowledgeBaseId}
      AND idempotency_key = ${request.idempotencyKey}
    FOR UPDATE
  `;
  if (!rows[0]) return null;
  if (rows[0].request_hash !== request.requestHash) {
    throw repositoryError("idempotency_conflict");
  }
  return {
    outcome: "replayed",
    operationPublicId: rows[0].operation_public_id,
    state: "queued",
    visibilityCommitted: true
  };
}

async function lockTarget(
  transaction: StorageVnextDeletionTransaction,
  request: StorageVnextNormalizedDeletionRequest,
  knowledgeBaseRevision: number | string
): Promise<StorageVnextDeletionTarget> {
  if (request.targetKind === "knowledge_base") {
    if (request.targetPublicId !== request.knowledgeBaseId) {
      throw repositoryError("scope_conflict");
    }
    return { revision: Number(knowledgeBaseRevision), normalizedPath: null };
  }
  if (request.targetKind === "source_directory") {
    const rows = await transaction<Array<{
      revision: number | string;
      normalized_path: string;
      deleted_at: Date | null;
    }>>`
      SELECT revision, normalized_path, deleted_at
      FROM focowiki.source_directories
      WHERE knowledge_base_id = ${request.knowledgeBaseId}
        AND public_id = ${request.targetPublicId}
      FOR UPDATE
    `;
    if (!rows[0] || rows[0].deleted_at) throw repositoryError("resource_missing");
    return {
      revision: Number(rows[0].revision),
      normalizedPath: rows[0].normalized_path
    };
  }
  const rows = await transaction<Array<{
    revision: number | string;
    normalized_path: string;
    deleted_at: Date | null;
  }>>`
    SELECT revision, normalized_path, deleted_at
    FROM focowiki.source_files
    WHERE knowledge_base_id = ${request.knowledgeBaseId}
      AND public_id = ${request.targetPublicId}
    FOR UPDATE
  `;
  if (!rows[0] || rows[0].deleted_at) throw repositoryError("resource_missing");
  return {
    revision: Number(rows[0].revision),
    normalizedPath: rows[0].normalized_path
  };
}

async function commitVisibility(
  transaction: StorageVnextDeletionTransaction,
  request: StorageVnextNormalizedDeletionRequest,
  target: StorageVnextDeletionTarget
): Promise<StorageVnextDeletionVisibilityResult> {
  if (request.targetKind === "knowledge_base") {
    const rows = await transaction<Array<{ public_id: string }>>`
      UPDATE focowiki.knowledge_bases
      SET deleted_at = ${request.requestedAt}, revision = revision + 1,
          updated_at = ${request.requestedAt}
      WHERE public_id = ${request.knowledgeBaseId}
        AND revision = ${request.expectedResourceRevision}
        AND deleted_at IS NULL
      RETURNING public_id
    `;
    if (!rows[0]) throw repositoryError("revision_conflict");
    return { sourceFileCount: 0, directoryCount: 0 };
  }
  if (request.targetKind === "source_file") {
    const rows = await transaction<Array<{ public_id: string }>>`
      UPDATE focowiki.source_files
      SET deleted_at = ${request.requestedAt}, revision = revision + 1,
          updated_at = ${request.requestedAt}
      WHERE knowledge_base_id = ${request.knowledgeBaseId}
        AND public_id = ${request.targetPublicId}
        AND revision = ${request.expectedResourceRevision}
        AND deleted_at IS NULL
      RETURNING public_id
    `;
    if (!rows[0]) throw repositoryError("revision_conflict");
    return { sourceFileCount: 1, directoryCount: 0 };
  }
  const prefix = target.normalizedPath!;
  const pattern = `${escapeLike(prefix)}/%`;
  const files = await transaction<Array<{ public_id: string }>>`
    UPDATE focowiki.source_files
    SET deleted_at = ${request.requestedAt}, revision = revision + 1,
        updated_at = ${request.requestedAt}
    WHERE knowledge_base_id = ${request.knowledgeBaseId}
      AND normalized_path LIKE ${pattern} ESCAPE '\\'
      AND deleted_at IS NULL
    RETURNING public_id
  `;
  const directories = await transaction<Array<{ public_id: string }>>`
    UPDATE focowiki.source_directories
    SET deleted_at = ${request.requestedAt}, revision = revision + 1,
        updated_at = ${request.requestedAt}
    WHERE knowledge_base_id = ${request.knowledgeBaseId}
      AND (normalized_path = ${prefix} OR normalized_path LIKE ${pattern} ESCAPE '\\')
      AND deleted_at IS NULL
    RETURNING public_id
  `;
  if (!directories.some((item) => item.public_id === request.targetPublicId)) {
    throw repositoryError("revision_conflict");
  }
  return {
    sourceFileCount: files.length,
    directoryCount: directories.length
  };
}

async function insertDeletionWork(
  transaction: StorageVnextDeletionTransaction,
  request: StorageVnextNormalizedDeletionRequest,
  target: StorageVnextDeletionTarget,
  visibility: StorageVnextDeletionVisibilityResult,
  state: {
    activeSearchProviderKind: SearchProviderKind | null;
    activeSearchProviderIndexUid: string | null;
    candidateSearchProviderKind: SearchProviderKind | null;
    candidateSearchProviderIndexUid: string | null;
    supersededWorkCount: number;
  }
): Promise<void> {
  const checkpoint = {
    version: 1,
    phase: "visibility_committed",
    targetKind: request.targetKind,
    targetPublicId: request.targetPublicId,
    normalizedPath: target.normalizedPath,
    sourceFileCount: visibility.sourceFileCount,
    directoryCount: visibility.directoryCount,
    activeSearchProviderKind: state.activeSearchProviderKind,
    activeSearchProviderIndexUid: state.activeSearchProviderIndexUid,
    candidateSearchProviderKind: state.candidateSearchProviderKind,
    candidateSearchProviderIndexUid: state.candidateSearchProviderIndexUid,
    supersededWorkCount: state.supersededWorkCount,
    cursor: null
  };
  await transaction`
    INSERT INTO focowiki.operations (
      public_id, knowledge_base_id, operation_kind, state,
      expected_resource_revision, target_kind, target_public_id,
      created_at, updated_at
    ) VALUES (
      ${request.operationPublicId}, ${request.knowledgeBaseId}, 'deletion', 'accepted',
      ${request.expectedResourceRevision}, ${request.targetKind},
      ${request.targetPublicId}, ${request.requestedAt}, ${request.requestedAt}
    )
  `;
  await transaction`
    INSERT INTO focowiki.operation_idempotency (
      public_id, knowledge_base_id, idempotency_key, request_hash,
      operation_public_id, expires_at, created_at
    ) VALUES (
      ${storageVnextDeletionIdentity(
        "idempotency",
        request.knowledgeBaseId,
        request.idempotencyKey
      )}, ${request.knowledgeBaseId}, ${request.idempotencyKey},
      ${request.requestHash}, ${request.operationPublicId},
      ${request.expiresAt}, ${request.requestedAt}
    )
  `;
  await transaction`
    INSERT INTO focowiki.operation_work_items (
      operation_public_id, knowledge_base_id, work_kind, state,
      operation_revision, settings_revision_public_id, attempt_count,
      lease_owner, lease_expires_at, next_attempt_at, checkpoint, updated_at
    ) VALUES (
      ${request.operationPublicId}, ${request.knowledgeBaseId}, 'deletion', 'queued',
      1, ${request.settingsRevisionPublicId}, 0, NULL, NULL,
      ${request.requestedAt}, ${transaction.json(checkpoint)}, ${request.requestedAt}
    )
  `;
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function repositoryError(code: string): Error {
  return Object.assign(new Error(`Storage vNext deletion repository error: ${code}`), {
    code
  });
}
