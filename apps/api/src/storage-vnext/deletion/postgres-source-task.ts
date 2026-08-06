import { createGeneratedFileId } from "../../domain/generated-file-id.js";
import { createStorageVnextDeletionRequestHash } from "./identity.js";
import { acceptStorageVnextDeletion } from "./postgres-acceptance.js";
import { storageVnextDeletionIdentity } from "./postgres-conflicts.js";
import type { StorageVnextDeletionTransaction } from "./postgres-types.js";
import type {
  StorageVnextNormalizedDeletionRequest,
  StorageVnextSourceTaskDeletionInput,
  StorageVnextSourceTaskDeletionResult
} from "./ports.js";

type SourceTaskRow = {
  public_id: string;
  knowledge_base_id: string;
  revision: number | string;
  status: string;
  deleted_at: Date | null;
  operation_public_id: string | null;
  operation_state: string | null;
  work_state: string | null;
  lease_owner: string | null;
};

export async function deleteStorageVnextSourceTasks(input: {
  transaction: StorageVnextDeletionTransaction;
  request: StorageVnextSourceTaskDeletionInput;
}): Promise<readonly StorageVnextSourceTaskDeletionResult[]> {
  const { transaction, request } = input;
  const knowledgeBases = await transaction<Array<{ public_id: string }>>`
    SELECT public_id
    FROM focowiki.knowledge_bases
    WHERE public_id = ${request.knowledgeBaseId}
      AND deleted_at IS NULL
    FOR UPDATE
  `;
  if (!knowledgeBases[0]) return request.sourceFilePublicIds.map((sourceFilePublicId) => ({
    sourceFilePublicId,
    outcome: "skipped" as const,
    reason: "wrong_knowledge_base" as const
  }));
  const results: StorageVnextSourceTaskDeletionResult[] = [];
  for (const sourceFilePublicId of request.sourceFilePublicIds) {
    const source = await lockSourceTask(transaction, request.knowledgeBaseId, sourceFilePublicId);
    if (!source) {
      const anyScope = await transaction<Array<{ knowledge_base_id: string }>>`
        SELECT knowledge_base_id FROM focowiki.source_files
        WHERE public_id = ${sourceFilePublicId}
        LIMIT 1
      `;
      results.push({
        sourceFilePublicId,
        outcome: "skipped",
        reason: anyScope[0] ? "wrong_knowledge_base" : "missing"
      });
      continue;
    }
    if (source.deleted_at || source.operation_state === "deleted") {
      results.push({ sourceFilePublicId, outcome: "skipped", reason: "already_removed" });
      continue;
    }
    if (source.status === "processing") {
      results.push({ sourceFilePublicId, outcome: "skipped", reason: "running" });
      continue;
    }
    if (source.work_state === "running" && source.lease_owner) {
      results.push({
        sourceFilePublicId,
        outcome: "skipped",
        reason: "job_already_claimed"
      });
      continue;
    }
    const active = await readActiveGeneratedPage(
      transaction,
      request.knowledgeBaseId,
      sourceFilePublicId
    );
    if (active) {
      await hideSourceTask(transaction, {
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFilePublicId,
        operationPublicId: source.operation_public_id,
        deletedAt: request.deletedAt,
        resultExpiresAt: request.resultExpiresAt
      });
      results.push({
        sourceFilePublicId,
        outcome: "hidden",
        generatedFilePublicId: createGeneratedFileId({
          refKind: "page",
          refKey: sourceFilePublicId,
          sourceFileId: sourceFilePublicId
        }),
        generatedFilePath: active.logical_path
      });
      continue;
    }
    const deletion = sourceTaskDeletionRequest(request, source);
    await acceptStorageVnextDeletion({ transaction, request: deletion });
    results.push({ sourceFilePublicId, outcome: "deleted" });
  }
  return results;
}

async function lockSourceTask(
  transaction: StorageVnextDeletionTransaction,
  knowledgeBaseId: string,
  sourceFilePublicId: string
): Promise<SourceTaskRow | null> {
  const sources = await transaction<Array<{
    public_id: string;
    knowledge_base_id: string;
    revision: number | string;
    status: string;
    deleted_at: Date | null;
  }>>`
    SELECT source.public_id, source.knowledge_base_id, source.revision,
           source.status, source.deleted_at
    FROM focowiki.source_files source
    WHERE source.knowledge_base_id = ${knowledgeBaseId}
      AND source.public_id = ${sourceFilePublicId}
    FOR UPDATE OF source
  `;
  const source = sources[0];
  if (!source) return null;
  const operations = await transaction<Array<{
    public_id: string;
    state: string;
  }>>`
    SELECT public_id, state
    FROM focowiki.operations
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND target_kind = 'source_file'
      AND target_public_id = ${sourceFilePublicId}
      AND operation_kind = 'source_processing'
    ORDER BY created_at DESC, public_id DESC
    LIMIT 1
    FOR UPDATE
  `;
  const operation = operations[0];
  const work = operation
    ? (await transaction<Array<{
        state: string;
        lease_owner: string | null;
      }>>`
        SELECT state, lease_owner
        FROM focowiki.operation_work_items
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND operation_public_id = ${operation.public_id}
          AND work_kind = 'source'
        FOR UPDATE
      `)[0] ?? null
    : null;
  return {
    ...source,
    operation_public_id: operation?.public_id ?? null,
    operation_state: operation?.state ?? null,
    work_state: work?.state ?? null,
    lease_owner: work?.lease_owner ?? null
  };
}

async function readActiveGeneratedPage(
  transaction: StorageVnextDeletionTransaction,
  knowledgeBaseId: string,
  sourceFilePublicId: string
): Promise<{ logical_path: string } | null> {
  const rows = await transaction<Array<{ logical_path: string }>>`
    SELECT entry.logical_path
    FROM focowiki.active_snapshots snapshot
    CROSS JOIN LATERAL focowiki.resolve_release_catalog(
      snapshot.release_root_public_id
    ) entry
    WHERE snapshot.knowledge_base_id = ${knowledgeBaseId}
      AND entry.entry_kind = 'source'
      AND entry.source_file_public_id = ${sourceFilePublicId}
    ORDER BY entry.ordinal
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function hideSourceTask(
  transaction: StorageVnextDeletionTransaction,
  input: {
    knowledgeBaseId: string;
    sourceFilePublicId: string;
    operationPublicId: string | null;
    deletedAt: string;
    resultExpiresAt: string;
  }
): Promise<void> {
  if (!input.operationPublicId) return;
  await transaction`
    DELETE FROM focowiki.operation_work_items
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND operation_public_id = ${input.operationPublicId}
      AND work_kind = 'source'
  `;
  await transaction`
    UPDATE focowiki.operations
    SET state = 'deleted', completed_at = COALESCE(completed_at, ${input.deletedAt}),
        updated_at = ${input.deletedAt}
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND public_id = ${input.operationPublicId}
  `;
  await transaction`
    INSERT INTO focowiki.operation_results (
      public_id, knowledge_base_id, operation_kind, terminal_state,
      result_code, safe_message, result_summary, correlation_public_id,
      completed_at, expires_at
    ) VALUES (
      ${input.operationPublicId}, ${input.knowledgeBaseId}, 'source_processing',
      'deleted', 'SOURCE_TASK_HIDDEN', NULL,
      ${transaction.json({ sourceFilePublicId: input.sourceFilePublicId })},
      ${input.sourceFilePublicId}, ${input.deletedAt}, ${input.resultExpiresAt}
    )
    ON CONFLICT (public_id) DO UPDATE
    SET terminal_state = 'deleted', result_code = 'SOURCE_TASK_HIDDEN',
        safe_message = NULL,
        result_summary = EXCLUDED.result_summary,
        correlation_public_id = EXCLUDED.correlation_public_id,
        completed_at = EXCLUDED.completed_at,
        expires_at = EXCLUDED.expires_at
  `;
}

function sourceTaskDeletionRequest(
  request: StorageVnextSourceTaskDeletionInput,
  source: SourceTaskRow
): StorageVnextNormalizedDeletionRequest {
  const operationPublicId = storageVnextDeletionIdentity(
    "source-task-operation",
    request.knowledgeBaseId,
    source.public_id
  );
  const idempotencyKey = `source-task-delete:${source.public_id}`;
  const base = {
    kind: "source_file" as const,
    knowledgeBaseId: request.knowledgeBaseId,
    operationPublicId,
    targetPublicId: source.public_id,
    expectedResourceRevision: Number(source.revision),
    idempotencyKey,
    settingsRevisionPublicId: request.settingsRevisionPublicId,
    requestedAt: request.deletedAt,
    expiresAt: request.resultExpiresAt
  };
  return {
    ...base,
    targetKind: "source_file",
    requestHash: createStorageVnextDeletionRequestHash(base)
  };
}
