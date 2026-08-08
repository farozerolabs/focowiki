import type { TransactionSql } from "postgres";
import type { StorageVnextReleaseLifecycleHooks } from
  "../release/postgres-repository.js";
import type { StorageVnextStructuredMetadata } from "../shared/types.js";

type MutationOperationRow = {
  operation_kind: string;
  expected_resource_revision: number | string | null;
  target_public_id: string | null;
  checkpoint: MutationCheckpoint;
};

type MutationCheckpoint = {
  version: number;
  kind: string;
  targetKind: string;
  targetPublicId: string;
  expectedResourceRevision: number;
  currentLogicalPath?: string;
  currentNormalizedPath?: string;
  currentDirectoryPublicId?: string | null;
  currentParentPublicId?: string | null;
  currentRevisionPublicId?: string | null;
  currentName?: string;
  currentDescription?: string | null;
  currentTitle?: string;
  currentMetadata?: StorageVnextStructuredMetadata;
  candidateLogicalPath?: string | null;
  normalizedCandidatePath?: string | null;
  candidateDirectoryPublicId?: string | null;
  candidateParentPublicId?: string | null;
  candidateRevisionPublicId?: string;
  candidateName?: string;
  candidateDescription?: string | null;
  candidateTitle?: string;
  candidateMetadata?: StorageVnextStructuredMetadata;
};

const MUTATION_KINDS = new Set([
  "knowledge_base_metadata",
  "source_file_metadata",
  "source_file_move",
  "source_directory_move",
  "source_replace"
]);

export function createPostgresStorageVnextMutationReleaseHooks():
StorageVnextReleaseLifecycleHooks {
  return {
    async beforeActivate(input) {
      const operation = await readMutationOperation(
        input.transaction,
        input.knowledgeBaseId,
        input.operationPublicId
      );
      if (!operation) return;
      await applyCandidate(input.transaction, {
        knowledgeBaseId: input.knowledgeBaseId,
        operationPublicId: input.operationPublicId,
        checkpoint: operation.checkpoint,
        completedAt: input.activatedAt,
        resultExpiresAt: input.eventExpiresAt,
        candidatePublicId: input.candidatePublicId
      });
    },

    async beforeTerminate(input) {
      const operation = await readMutationOperation(
        input.transaction,
        input.knowledgeBaseId,
        input.operationPublicId
      );
      if (!operation) return;
      await discardCandidate(input.transaction, {
        knowledgeBaseId: input.knowledgeBaseId,
        operationPublicId: input.operationPublicId,
        checkpoint: operation.checkpoint,
        terminalState: input.outcome,
        resultCode: input.reasonCode,
        completedAt: input.terminatedAt,
        resultExpiresAt: input.eventExpiresAt,
        candidatePublicId: input.candidatePublicId
      });
    }
  };
}

async function readMutationOperation(
  transaction: TransactionSql,
  knowledgeBaseId: string,
  operationPublicId: string
): Promise<MutationOperationRow | null> {
  const rows = await transaction<MutationOperationRow[]>`
    SELECT operation.operation_kind, operation.expected_resource_revision,
           operation.target_public_id, work.checkpoint
    FROM focowiki.operations operation
    JOIN focowiki.operation_work_items work
      ON work.knowledge_base_id = operation.knowledge_base_id
     AND work.operation_public_id = operation.public_id
    WHERE operation.knowledge_base_id = ${knowledgeBaseId}
      AND operation.public_id = ${operationPublicId}
      AND work.work_kind = 'mutation'
      AND work.state IN ('queued', 'running', 'retry')
    FOR UPDATE OF operation, work
  `;
  const operation = rows[0];
  if (!operation) return null;
  if (!MUTATION_KINDS.has(operation.operation_kind)
    || operation.target_public_id !== operation.checkpoint.targetPublicId
    || Number(operation.expected_resource_revision)
      !== operation.checkpoint.expectedResourceRevision
    || operation.checkpoint.version !== 1
    || operation.checkpoint.kind !== operation.operation_kind) {
    throw mutationActivationError("candidate_state_invalid");
  }
  return operation;
}

async function applyCandidate(
  transaction: TransactionSql,
  input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    checkpoint: MutationCheckpoint;
    completedAt: string;
    resultExpiresAt: string;
    candidatePublicId: string;
  }
): Promise<void> {
  switch (input.checkpoint.kind) {
    case "knowledge_base_metadata":
      await activateKnowledgeBaseMetadata(transaction, input);
      break;
    case "source_file_metadata":
      await activateSourceFileMetadata(transaction, input);
      break;
    case "source_file_move":
      await activateSourceFileMove(transaction, input);
      break;
    case "source_directory_move":
      await activateSourceDirectoryMove(transaction, input);
      break;
    case "source_replace":
      await activateSourceReplacement(transaction, input);
      break;
    default:
      throw mutationActivationError("candidate_state_invalid");
  }
  await activateCandidateGraph(transaction, input);
  await completeMutation(transaction, input);
}

async function activateCandidateGraph(
  transaction: TransactionSql,
  input: {
    knowledgeBaseId: string;
    candidatePublicId: string;
  }
): Promise<void> {
  const stagedNodes = await transaction<Array<{ public_id: string }>>`
    SELECT public_id
    FROM focowiki.release_candidate_graph_nodes
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND candidate_public_id = ${input.candidatePublicId}
    ORDER BY public_id COLLATE "C"
    FOR UPDATE
  `;
  if (stagedNodes.length === 0) return;
  const nodePublicIds = stagedNodes.map((node) => node.public_id);
  await transaction`
    DELETE FROM focowiki.graph_edges
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND from_node_public_id = ANY(${nodePublicIds})
  `;
  await transaction`
    DELETE FROM focowiki.graph_evidence_refs
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND node_public_id = ANY(${nodePublicIds})
  `;
  await transaction`
    INSERT INTO focowiki.graph_nodes (
      public_id, knowledge_base_id, source_file_public_id,
      source_revision_public_id, logical_path, label, node_kind,
      metadata, revision
    )
    SELECT public_id, knowledge_base_id, source_file_public_id,
           source_revision_public_id, logical_path, label, node_kind,
           metadata, revision
    FROM focowiki.release_candidate_graph_nodes
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND candidate_public_id = ${input.candidatePublicId}
    ON CONFLICT (public_id) DO UPDATE SET
      source_revision_public_id = excluded.source_revision_public_id,
      logical_path = excluded.logical_path,
      label = excluded.label,
      node_kind = excluded.node_kind,
      metadata = excluded.metadata,
      revision = excluded.revision
    WHERE focowiki.graph_nodes.knowledge_base_id = excluded.knowledge_base_id
      AND focowiki.graph_nodes.source_file_public_id = excluded.source_file_public_id
  `;
  await transaction`
    INSERT INTO focowiki.graph_evidence_refs (
      public_id, knowledge_base_id, node_public_id, edge_public_id,
      source_file_public_id, source_revision_public_id, logical_path,
      start_offset, end_offset, checksum_sha256
    )
    SELECT public_id, knowledge_base_id, node_public_id, NULL,
           source_file_public_id, source_revision_public_id, logical_path,
           start_offset, end_offset, checksum_sha256
    FROM focowiki.release_candidate_graph_evidence
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND candidate_public_id = ${input.candidatePublicId}
      AND node_public_id IS NOT NULL
  `;
  await transaction`
    INSERT INTO focowiki.graph_edges (
      public_id, knowledge_base_id, from_node_public_id, to_node_public_id,
      relation, weight, reason, edge_source, metadata, revision
    )
    SELECT public_id, knowledge_base_id, from_node_public_id,
           to_node_public_id, relation, weight, reason, edge_source,
           metadata, revision
    FROM focowiki.release_candidate_graph_edges
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND candidate_public_id = ${input.candidatePublicId}
  `;
  await transaction`
    INSERT INTO focowiki.graph_evidence_refs (
      public_id, knowledge_base_id, node_public_id, edge_public_id,
      source_file_public_id, source_revision_public_id, logical_path,
      start_offset, end_offset, checksum_sha256
    )
    SELECT public_id, knowledge_base_id, NULL, edge_public_id,
           source_file_public_id, source_revision_public_id, logical_path,
           start_offset, end_offset, checksum_sha256
    FROM focowiki.release_candidate_graph_evidence
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND candidate_public_id = ${input.candidatePublicId}
      AND edge_public_id IS NOT NULL
  `;
}

async function activateKnowledgeBaseMetadata(
  transaction: TransactionSql,
  input: { knowledgeBaseId: string; checkpoint: MutationCheckpoint; completedAt: string }
): Promise<void> {
  const rows = await transaction<Array<{ public_id: string }>>`
    UPDATE focowiki.knowledge_bases
    SET name = ${requiredString(input.checkpoint.candidateName)},
        description = ${input.checkpoint.candidateDescription ?? null},
        revision = revision + 1,
        updated_at = ${input.completedAt}
    WHERE public_id = ${input.knowledgeBaseId}
      AND revision = ${input.checkpoint.expectedResourceRevision}
      AND deleted_at IS NULL
    RETURNING public_id
  `;
  requireOne(rows);
}

async function activateSourceFileMetadata(
  transaction: TransactionSql,
  input: { knowledgeBaseId: string; checkpoint: MutationCheckpoint; completedAt: string }
): Promise<void> {
  const rows = await transaction<Array<{ public_id: string }>>`
    UPDATE focowiki.source_files
    SET title = ${requiredString(input.checkpoint.candidateTitle)},
        metadata = ${transaction.json(input.checkpoint.candidateMetadata as never)},
        revision = revision + 1,
        updated_at = ${input.completedAt}
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND public_id = ${input.checkpoint.targetPublicId}
      AND revision = ${input.checkpoint.expectedResourceRevision}
      AND deleted_at IS NULL
    RETURNING public_id
  `;
  requireOne(rows);
}

async function activateSourceFileMove(
  transaction: TransactionSql,
  input: { knowledgeBaseId: string; checkpoint: MutationCheckpoint; completedAt: string }
): Promise<void> {
  const candidateLogicalPath = requiredString(input.checkpoint.candidateLogicalPath);
  const rows = await transaction<Array<{ public_id: string }>>`
    UPDATE focowiki.source_files
    SET directory_public_id = ${input.checkpoint.candidateDirectoryPublicId ?? null},
        logical_path = ${candidateLogicalPath},
        normalized_path = ${requiredString(input.checkpoint.normalizedCandidatePath)},
        revision = revision + 1,
        updated_at = ${input.completedAt}
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND public_id = ${input.checkpoint.targetPublicId}
      AND revision = ${input.checkpoint.expectedResourceRevision}
      AND logical_path = ${requiredString(input.checkpoint.currentLogicalPath)}
      AND deleted_at IS NULL
    RETURNING public_id
  `;
  requireOne(rows);
  await updateGraphPath(transaction, {
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFilePublicId: input.checkpoint.targetPublicId,
    currentLogicalPath: requiredString(input.checkpoint.currentLogicalPath),
    candidateLogicalPath
  });
}

async function activateSourceDirectoryMove(
  transaction: TransactionSql,
  input: { knowledgeBaseId: string; checkpoint: MutationCheckpoint; completedAt: string }
): Promise<void> {
  const currentLogicalPath = requiredString(input.checkpoint.currentLogicalPath);
  const currentNormalizedPath = requiredString(input.checkpoint.currentNormalizedPath);
  const candidateLogicalPath = requiredString(input.checkpoint.candidateLogicalPath);
  const candidateNormalizedPath = requiredString(input.checkpoint.normalizedCandidatePath);
  const root = await transaction<Array<{ public_id: string }>>`
    UPDATE focowiki.source_directories
    SET parent_public_id = ${input.checkpoint.candidateParentPublicId ?? null},
        logical_path = ${candidateLogicalPath},
        normalized_path = ${candidateNormalizedPath},
        title = ${requiredString(input.checkpoint.candidateTitle)},
        revision = revision + 1,
        updated_at = ${input.completedAt}
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND public_id = ${input.checkpoint.targetPublicId}
      AND revision = ${input.checkpoint.expectedResourceRevision}
      AND logical_path = ${currentLogicalPath}
      AND deleted_at IS NULL
    RETURNING public_id
  `;
  requireOne(root);
  await transaction`
    UPDATE focowiki.source_directories
    SET logical_path = overlay(
          logical_path PLACING ${candidateLogicalPath}
          FROM 1 FOR ${currentLogicalPath.length}
        ),
        normalized_path = overlay(
          normalized_path PLACING ${candidateNormalizedPath}
          FROM 1 FOR ${currentNormalizedPath.length}
        ),
        revision = revision + 1,
        updated_at = ${input.completedAt}
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND public_id <> ${input.checkpoint.targetPublicId}
      AND normalized_path LIKE ${`${escapeLike(currentNormalizedPath)}/%`} ESCAPE '\\'
      AND deleted_at IS NULL
  `;
  await transaction`
    UPDATE focowiki.source_files
    SET logical_path = overlay(
          logical_path PLACING ${candidateLogicalPath}
          FROM 1 FOR ${currentLogicalPath.length}
        ),
        normalized_path = overlay(
          normalized_path PLACING ${candidateNormalizedPath}
          FROM 1 FOR ${currentNormalizedPath.length}
        ),
        revision = revision + 1,
        updated_at = ${input.completedAt}
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND normalized_path LIKE ${`${escapeLike(currentNormalizedPath)}/%`} ESCAPE '\\'
      AND deleted_at IS NULL
  `;
  await transaction`
    UPDATE focowiki.graph_nodes
    SET logical_path = CASE
          WHEN logical_path LIKE ${`pages/${escapeLike(currentLogicalPath)}/%`} ESCAPE '\\'
            THEN overlay(
              logical_path PLACING ${`pages/${candidateLogicalPath}`}
              FROM 1 FOR ${`pages/${currentLogicalPath}`.length}
            )
          ELSE overlay(
            logical_path PLACING ${candidateLogicalPath}
            FROM 1 FOR ${currentLogicalPath.length}
          )
        END,
        revision = revision + 1
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND (
        logical_path LIKE ${`${escapeLike(currentLogicalPath)}/%`} ESCAPE '\\'
        OR logical_path LIKE ${`pages/${escapeLike(currentLogicalPath)}/%`} ESCAPE '\\'
      )
  `;
  await transaction`
    UPDATE focowiki.graph_evidence_refs
    SET logical_path = CASE
          WHEN logical_path LIKE ${`pages/${escapeLike(currentLogicalPath)}/%`} ESCAPE '\\'
            THEN overlay(
              logical_path PLACING ${`pages/${candidateLogicalPath}`}
              FROM 1 FOR ${`pages/${currentLogicalPath}`.length}
            )
          ELSE overlay(
            logical_path PLACING ${candidateLogicalPath}
            FROM 1 FOR ${currentLogicalPath.length}
          )
        END
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND (
        logical_path LIKE ${`${escapeLike(currentLogicalPath)}/%`} ESCAPE '\\'
        OR logical_path LIKE ${`pages/${escapeLike(currentLogicalPath)}/%`} ESCAPE '\\'
      )
  `;
}

async function activateSourceReplacement(
  transaction: TransactionSql,
  input: { knowledgeBaseId: string; checkpoint: MutationCheckpoint; completedAt: string }
): Promise<void> {
  const candidateRevisionPublicId = requiredString(
    input.checkpoint.candidateRevisionPublicId
  );
  if (input.checkpoint.candidateLogicalPath) {
    await activateSourceFileMove(transaction, input);
  } else {
    const rows = await transaction<Array<{ public_id: string }>>`
      UPDATE focowiki.source_files
      SET revision = revision + 1, updated_at = ${input.completedAt}
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND public_id = ${input.checkpoint.targetPublicId}
        AND revision = ${input.checkpoint.expectedResourceRevision}
        AND deleted_at IS NULL
      RETURNING public_id
    `;
    requireOne(rows);
  }
  const metadataRows = await transaction<Array<{ public_id: string }>>`
    UPDATE focowiki.source_files
    SET title = ${requiredString(input.checkpoint.candidateTitle)},
        metadata = ${transaction.json(input.checkpoint.candidateMetadata as never)},
        updated_at = ${input.completedAt}
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND public_id = ${input.checkpoint.targetPublicId}
      AND revision = ${input.checkpoint.expectedResourceRevision + 1}
      AND deleted_at IS NULL
    RETURNING public_id
  `;
  requireOne(metadataRows);
  const revisions = await transaction<Array<{ public_id: string }>>`
    UPDATE focowiki.source_revisions
    SET revision_role = 'current', expires_at = NULL
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND source_file_public_id = ${input.checkpoint.targetPublicId}
      AND public_id = ${candidateRevisionPublicId}
      AND revision_role = 'candidate'
    RETURNING public_id
  `;
  requireOne(revisions);
  const pointers = await transaction<Array<{ source_file_public_id: string }>>`
    UPDATE focowiki.source_file_current_revisions
    SET source_revision_public_id = ${candidateRevisionPublicId},
        revision = revision + 1
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND source_file_public_id = ${input.checkpoint.targetPublicId}
      AND source_revision_public_id IS NOT DISTINCT FROM
          ${input.checkpoint.currentRevisionPublicId ?? null}
    RETURNING source_file_public_id
  `;
  requireOne(pointers);
  await transaction`
    UPDATE focowiki.graph_nodes
    SET source_revision_public_id = ${candidateRevisionPublicId},
        revision = revision + 1
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND source_file_public_id = ${input.checkpoint.targetPublicId}
  `;
  await transaction`
    UPDATE focowiki.graph_evidence_refs
    SET source_revision_public_id = ${candidateRevisionPublicId}
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND source_file_public_id = ${input.checkpoint.targetPublicId}
  `;
  if (input.checkpoint.currentRevisionPublicId
    && input.checkpoint.currentRevisionPublicId !== candidateRevisionPublicId) {
    const released = await transaction<Array<{ object_id: string }>>`
      DELETE FROM focowiki.source_revisions
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND source_file_public_id = ${input.checkpoint.targetPublicId}
        AND public_id = ${input.checkpoint.currentRevisionPublicId}
      RETURNING object_id
    `;
    await markZeroOwnerObjects(
      transaction,
      released.map((row) => row.object_id),
      input.completedAt
    );
  }
}

async function updateGraphPath(
  transaction: TransactionSql,
  input: {
    knowledgeBaseId: string;
    sourceFilePublicId: string;
    currentLogicalPath: string;
    candidateLogicalPath: string;
  }
): Promise<void> {
  await transaction`
    UPDATE focowiki.graph_nodes
    SET logical_path = CASE
          WHEN logical_path = ${`pages/${input.currentLogicalPath}`}
            THEN ${`pages/${input.candidateLogicalPath}`}
          ELSE ${input.candidateLogicalPath}
        END,
        revision = revision + 1
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND source_file_public_id = ${input.sourceFilePublicId}
  `;
  await transaction`
    UPDATE focowiki.graph_evidence_refs
    SET logical_path = CASE
          WHEN logical_path = ${`pages/${input.currentLogicalPath}`}
            THEN ${`pages/${input.candidateLogicalPath}`}
          ELSE ${input.candidateLogicalPath}
        END
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND source_file_public_id = ${input.sourceFilePublicId}
  `;
}

async function completeMutation(
  transaction: TransactionSql,
  input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    checkpoint: MutationCheckpoint;
    completedAt: string;
    resultExpiresAt: string;
    candidatePublicId: string;
  }
): Promise<void> {
  await transaction`
    DELETE FROM focowiki.mutation_path_reservations
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND operation_public_id = ${input.operationPublicId}
  `;
  await transaction`
    DELETE FROM focowiki.operation_work_items
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND operation_public_id = ${input.operationPublicId}
      AND work_kind = 'mutation'
  `;
  await transaction`
    UPDATE focowiki.operations
    SET state = 'completed', completed_at = ${input.completedAt},
        updated_at = ${input.completedAt}
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND public_id = ${input.operationPublicId}
  `;
  await insertResult(transaction, {
    knowledgeBaseId: input.knowledgeBaseId,
    operationPublicId: input.operationPublicId,
    terminalState: "completed",
    resultCode: "MUTATION_ACTIVATED",
    completedAt: input.completedAt,
    resultExpiresAt: input.resultExpiresAt,
    candidatePublicId: input.candidatePublicId,
    checkpoint: input.checkpoint
  });
}

async function discardCandidate(
  transaction: TransactionSql,
  input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    checkpoint: MutationCheckpoint;
    terminalState: "failed" | "cancelled" | "superseded" | "timed_out";
    resultCode: string;
    completedAt: string;
    resultExpiresAt: string;
    candidatePublicId: string;
  }
): Promise<void> {
  if (input.checkpoint.candidateRevisionPublicId) {
    const released = await transaction<Array<{ object_id: string }>>`
      DELETE FROM focowiki.source_revisions
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND public_id = ${input.checkpoint.candidateRevisionPublicId}
        AND revision_role = 'candidate'
      RETURNING object_id
    `;
    await markZeroOwnerObjects(
      transaction,
      released.map((row) => row.object_id),
      input.completedAt
    );
  }
  await transaction`
    DELETE FROM focowiki.mutation_path_reservations
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND operation_public_id = ${input.operationPublicId}
  `;
  await transaction`
    DELETE FROM focowiki.operation_work_items
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND operation_public_id = ${input.operationPublicId}
      AND work_kind = 'mutation'
  `;
  await transaction`
    UPDATE focowiki.operations
    SET state = ${input.terminalState}, completed_at = ${input.completedAt},
        updated_at = ${input.completedAt}
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND public_id = ${input.operationPublicId}
  `;
  await insertResult(transaction, {
    ...input,
    terminalState: input.terminalState
  });
}

async function insertResult(
  transaction: TransactionSql,
  input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    terminalState: "completed" | "failed" | "cancelled" | "superseded" | "timed_out";
    resultCode: string;
    completedAt: string;
    resultExpiresAt: string;
    candidatePublicId: string;
    checkpoint: MutationCheckpoint;
  }
): Promise<void> {
  await transaction`
    INSERT INTO focowiki.operation_results (
      public_id, knowledge_base_id, operation_kind, terminal_state,
      result_code, safe_message, result_summary, correlation_public_id,
      completed_at, expires_at
    ) VALUES (
      ${input.operationPublicId}, ${input.knowledgeBaseId}, 'mutation',
      ${input.terminalState}, ${input.resultCode}, NULL,
      ${transaction.json({
        kind: input.checkpoint.kind,
        targetPublicId: input.checkpoint.targetPublicId
      })},
      ${input.candidatePublicId}, ${input.completedAt}, ${input.resultExpiresAt}
    )
    ON CONFLICT (public_id) DO NOTHING
  `;
}

function requiredString(value: string | null | undefined): string {
  if (!value) throw mutationActivationError("candidate_state_invalid");
  return value;
}

function requireOne(rows: readonly unknown[]): void {
  if (rows.length !== 1) throw mutationActivationError("revision_conflict");
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

async function markZeroOwnerObjects(
  transaction: TransactionSql,
  objectIds: readonly string[],
  zeroOwnerSince: string
): Promise<void> {
  if (objectIds.length === 0) return;
  await transaction`
    UPDATE focowiki.object_registrations object
    SET zero_owner_since = COALESCE(object.zero_owner_since, ${zeroOwnerSince})
    WHERE object.object_id = ANY(${[...new Set(objectIds)]})
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.object_owners owner
        WHERE owner.object_id = object.object_id
      )
  `;
}

function mutationActivationError(code: string): Error {
  return Object.assign(new Error(`Storage vNext mutation activation error: ${code}`), {
    code
  });
}
