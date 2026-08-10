import type { TransactionSql } from "postgres";
import type { StorageVnextReleaseLifecycleHooks } from
  "../release/postgres-repository.js";
import type { StorageVnextStructuredMetadata } from "../shared/types.js";
import {
  planSemanticSourceStages,
  type SemanticStageWorkItem
} from "../../semantic/application/stage-orchestration.js";
import type { SemanticSourceStageTarget } from
  "../../semantic/application/source-handoff.js";
import { selectSemanticCrudStages } from
  "../../semantic/application/crud-planner.js";
import { enqueueSemanticStagesInTransaction } from
  "../../semantic/infrastructure/postgres-stage-repository.js";
import { activateSemanticSourceRevision } from
  "../../semantic/infrastructure/postgres-source-revision-activation.js";
import { createOkfSearchSignals } from "../search/okf-signals.js";

type MutationOperationRow = {
  operation_kind: string;
  expected_resource_revision: number | string | null;
  target_public_id: string | null;
  checkpoint: MutationCheckpoint;
};

export type MutationCheckpoint = {
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
  semanticState?: "disabled" | "blocked" | "ready";
  semanticGenerationPublicId?: string | null;
  semanticSafeCode?: string | null;
  semanticStageTargetJson?: string;
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
  await assertMutationSemanticStagesComplete(transaction, input);
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

async function assertMutationSemanticStagesComplete(
  transaction: TransactionSql,
  input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    checkpoint: MutationCheckpoint;
  }
): Promise<void> {
  if (input.checkpoint.semanticState !== "ready" || ![
    "source_replace", "source_file_metadata"
  ].includes(input.checkpoint.kind)) return;
  const rows = await transaction<Array<{
    total_count: number | string;
    incomplete_count: number | string;
  }>>`
    SELECT count(*) AS total_count,
           count(*) FILTER (WHERE state <> 'completed') AS incomplete_count
    FROM focowiki.semantic_stage_work_items
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND operation_public_id = ${input.operationPublicId}
  `;
  if (Number(rows[0]?.total_count ?? 0) === 0
    || Number(rows[0]?.incomplete_count ?? 0) > 0) {
    throw mutationActivationError("semantic_publication_barrier_incomplete");
  }
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
  await transaction`
    UPDATE focowiki.semantic_evidence
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
  await transaction`
    UPDATE focowiki.semantic_vector_documents
    SET evidence_target_path = CASE
          WHEN evidence_target_path LIKE
            ${`pages/${escapeLike(currentLogicalPath)}/%`} ESCAPE '\\'
            THEN overlay(
              evidence_target_path PLACING ${`pages/${candidateLogicalPath}`}
              FROM 1 FOR ${`pages/${currentLogicalPath}`.length}
            )
          ELSE overlay(
            evidence_target_path PLACING ${candidateLogicalPath}
            FROM 1 FOR ${currentLogicalPath.length}
          )
        END
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND (
        evidence_target_path LIKE
          ${`${escapeLike(currentLogicalPath)}/%`} ESCAPE '\\'
        OR evidence_target_path LIKE
          ${`pages/${escapeLike(currentLogicalPath)}/%`} ESCAPE '\\'
      )
  `;
}

async function activateSourceReplacement(
  transaction: TransactionSql,
  input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    checkpoint: MutationCheckpoint;
    completedAt: string;
    resultExpiresAt: string;
  }
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
  await recordReplacementModelInvocation(transaction, {
    knowledgeBaseId: input.knowledgeBaseId,
    operationPublicId: input.operationPublicId,
    sourceFilePublicId: input.checkpoint.targetPublicId,
    sourceRevisionPublicId: candidateRevisionPublicId
  });
  if (input.checkpoint.semanticState === "ready"
    && input.checkpoint.currentRevisionPublicId
    && input.checkpoint.currentRevisionPublicId !== candidateRevisionPublicId) {
    await activateSemanticSourceRevision(transaction, {
      knowledgeBaseId: input.knowledgeBaseId,
      semanticGenerationPublicId: requiredString(
        input.checkpoint.semanticGenerationPublicId
      ),
      sourceFilePublicId: input.checkpoint.targetPublicId,
      priorSourceRevisionPublicId: input.checkpoint.currentRevisionPublicId,
      currentSourceRevisionPublicId: candidateRevisionPublicId,
      activatedAt: input.completedAt
    });
  }
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
    const retained = await transaction<Array<{ public_id: string }>>`
      UPDATE focowiki.source_revisions
      SET revision_role = 'rollback', expires_at = ${input.resultExpiresAt}
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND source_file_public_id = ${input.checkpoint.targetPublicId}
        AND public_id = ${input.checkpoint.currentRevisionPublicId}
        AND revision_role = 'current'
      RETURNING public_id
    `;
    requireOne(retained);
  }
}

async function recordReplacementModelInvocation(
  transaction: TransactionSql,
  input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
  }
): Promise<void> {
  await transaction`
    WITH invocation AS MATERIALIZED (
      SELECT model.model AS model_name,
             stage.created_at AS started_at,
             stage.completed_at AS ended_at
      FROM focowiki.semantic_stage_work_items stage
      JOIN focowiki.model_configs model
        ON model.public_id = stage.settings_snapshot
             ->> 'generationModelConfigurationPublicId'
       AND model.revision::text = stage.settings_snapshot
             ->> 'generationModelConfigurationRevision'
      WHERE stage.knowledge_base_id = ${input.knowledgeBaseId}
        AND stage.operation_public_id = ${input.operationPublicId}
        AND stage.source_file_public_id = ${input.sourceFilePublicId}
        AND stage.source_revision_public_id = ${input.sourceRevisionPublicId}
        AND stage.stage_kind = 'extraction'
        AND stage.state = 'completed'
        AND stage.checkpoint ->> 'reconciliationState' = 'created'
        AND stage.completed_at IS NOT NULL
      LIMIT 1
    )
    UPDATE focowiki.source_files source
    SET model_invocation_source_revision_public_id = ${input.sourceRevisionPublicId},
        model_invocation_status = 'completed',
        model_invocation_model_name = invocation.model_name,
        model_invocation_started_at = invocation.started_at,
        model_invocation_ended_at = invocation.ended_at,
        model_invocation_warning_count = 0,
        model_invocation_error_code = NULL
    FROM invocation
    WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
      AND source.public_id = ${input.sourceFilePublicId}
      AND source.deleted_at IS NULL
  `;
}

async function cancelStaleSemanticWork(
  transaction: TransactionSql,
  input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    checkpoint: MutationCheckpoint;
    completedAt: string;
  }
): Promise<void> {
  if (input.checkpoint.kind !== "source_replace") return;
  if (input.checkpoint.kind === "source_replace") {
    await transaction`
      UPDATE focowiki.semantic_dirty_partitions partition
      SET state = 'superseded', lease_owner = NULL,
          lease_expires_at = NULL,
          safe_error_code = 'semantic_partition_superseded',
          revision = partition.revision + 1,
          updated_at = ${input.completedAt}
      WHERE partition.knowledge_base_id = ${input.knowledgeBaseId}
        AND partition.state IN ('dirty', 'processing', 'failed')
        AND EXISTS (
          SELECT 1
          FROM focowiki.semantic_entity_partitions assignment
          JOIN focowiki.semantic_entity_observations observation
            ON observation.knowledge_base_id = assignment.knowledge_base_id
           AND observation.semantic_generation_public_id
             = assignment.semantic_generation_public_id
           AND observation.entity_public_id = assignment.entity_public_id
          WHERE assignment.knowledge_base_id = partition.knowledge_base_id
            AND assignment.semantic_generation_public_id
              = partition.semantic_generation_public_id
            AND assignment.partition_key = partition.partition_key
            AND observation.source_file_public_id
              = ${input.checkpoint.targetPublicId}
        )
    `;
  }
  await transaction`
    UPDATE focowiki.semantic_stage_work_items
    SET cancellation_requested_at = COALESCE(
          cancellation_requested_at, ${input.completedAt}
        ),
        state = CASE WHEN state IN ('queued', 'retry')
          THEN 'cancelled' ELSE state END,
        completed_at = CASE WHEN state IN ('queued', 'retry')
          THEN ${input.completedAt} ELSE completed_at END,
        revision = revision + 1,
        updated_at = ${input.completedAt}
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND source_file_public_id = ${input.checkpoint.targetPublicId}
      AND operation_public_id <> ${input.operationPublicId}
      AND state IN ('queued', 'running', 'retry')
  `;
}

export async function prepareMutationSemanticStagesInTransaction(
  transaction: TransactionSql,
  input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    checkpoint: MutationCheckpoint;
    completedAt: string;
  }
): Promise<void> {
  if (input.checkpoint.semanticState !== "ready") return;
  if (!["source_replace", "source_file_metadata"].includes(
    input.checkpoint.kind
  )) return;
  await cancelStaleSemanticWork(transaction, input);
  const target = parseSemanticTarget(input.checkpoint.semanticStageTargetJson);
  if (target.semanticGenerationPublicId
    !== input.checkpoint.semanticGenerationPublicId) {
    throw mutationActivationError("semantic_target_invalid");
  }
  const projectionContractPublicId = target.settingsSnapshot
    .projectionContractPublicId;
  if (typeof projectionContractPublicId !== "string") {
    throw mutationActivationError("semantic_target_invalid");
  }
  const generation = await transaction<Array<{ public_id: string }>>`
    SELECT generation.public_id
    FROM focowiki.semantic_generations generation
    JOIN focowiki.semantic_projection_contracts contract
      ON contract.knowledge_base_id = generation.knowledge_base_id
     AND contract.semantic_generation_public_id = generation.public_id
     AND contract.public_id = ${projectionContractPublicId}
    WHERE generation.knowledge_base_id = ${input.knowledgeBaseId}
      AND generation.public_id = ${target.semanticGenerationPublicId}
      AND generation.generation_role = 'active'
      AND generation.state = 'active'
      AND generation.deleted_at IS NULL
    FOR UPDATE OF generation
  `;
  if (!generation[0]) throw mutationActivationError("semantic_target_stale");
  let cursor: string | null = null;
  while (true) {
    const rows = await readSemanticStageSourcePage(transaction, {
      knowledgeBaseId: input.knowledgeBaseId,
      targetPublicId: input.checkpoint.targetPublicId,
      candidateRevisionPublicId: input.checkpoint.kind === "source_replace"
        ? requiredString(input.checkpoint.candidateRevisionPublicId)
        : null,
      directoryNormalizedPath: null,
      cursor
    });
    if (rows.length === 0) break;
    const items = rows.flatMap((row) => planSemanticMutationStages({
      knowledgeBaseId: input.knowledgeBaseId,
      operationPublicId: input.operationPublicId,
      sourceFilePublicId: row.public_id,
      sourceRevisionPublicId: row.source_revision_public_id,
      target,
      mutationKind: input.checkpoint.kind === "source_replace"
        ? "body_replacement"
        : "source_file_metadata",
      ...(input.checkpoint.candidateMetadata
        ? { candidateMetadata: input.checkpoint.candidateMetadata }
        : {})
    }));
    for (const batch of chunk(items, 1_000)) {
      await enqueueSemanticStagesInTransaction(transaction, {
        items: batch,
        enqueuedAt: input.completedAt
      });
    }
    break;
  }
}

async function readSemanticStageSourcePage(
  transaction: TransactionSql,
  input: {
    knowledgeBaseId: string;
    targetPublicId: string;
    candidateRevisionPublicId: string | null;
    directoryNormalizedPath: string | null;
    cursor: string | null;
  }
): Promise<Array<{ public_id: string; source_revision_public_id: string }>> {
  if (input.directoryNormalizedPath === null) {
    return transaction<Array<{
      public_id: string;
      source_revision_public_id: string;
    }>>`
      SELECT source.public_id,
             coalesce(
               ${input.candidateRevisionPublicId}::text,
               current.source_revision_public_id
             ) AS source_revision_public_id
      FROM focowiki.source_files source
      JOIN focowiki.source_file_current_revisions current
        ON current.knowledge_base_id = source.knowledge_base_id
       AND current.source_file_public_id = source.public_id
      WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
        AND source.public_id = ${input.targetPublicId}
        AND source.deleted_at IS NULL
      LIMIT 1
    `;
  }
  return transaction<Array<{
    public_id: string;
    source_revision_public_id: string;
  }>>`
    SELECT source.public_id, current.source_revision_public_id
    FROM focowiki.source_files source
    JOIN focowiki.source_file_current_revisions current
      ON current.knowledge_base_id = source.knowledge_base_id
     AND current.source_file_public_id = source.public_id
    WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
      AND source.deleted_at IS NULL
      AND source.normalized_path LIKE
        ${`${escapeLike(input.directoryNormalizedPath)}/%`} ESCAPE '\\'
      AND (${input.cursor}::text IS NULL
        OR source.public_id COLLATE "C" > ${input.cursor}::text COLLATE "C")
    ORDER BY source.public_id COLLATE "C"
    LIMIT 200
  `;
}

export function planSemanticMutationStages(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  target: SemanticSourceStageTarget;
  mutationKind:
    | "body_replacement" | "file_move" | "directory_move"
    | "source_file_metadata";
  candidateMetadata?: StorageVnextStructuredMetadata;
}): SemanticStageWorkItem[] {
  const signals = input.mutationKind === "source_file_metadata"
    ? createOkfSearchSignals(input.candidateMetadata ?? {})
    : null;
  const stages = planSemanticSourceStages({
    knowledgeBaseId: input.knowledgeBaseId,
    operationPublicId: input.operationPublicId,
    semanticGenerationPublicId: input.target.semanticGenerationPublicId,
    sourceFilePublicId: input.sourceFilePublicId,
    sourceRevisionPublicId: input.sourceRevisionPublicId,
    extractionContractVersion: input.target.extractionContractVersion,
    embeddingConfigurationRevisionPublicId:
      input.target.embeddingConfigurationRevisionPublicId,
    settingsSnapshot: signals === null ? input.target.settingsSnapshot : {
      ...input.target.settingsSnapshot,
      sourceFilterProjectionOverride: true,
      sourceOkfStatusOverride: signals.status,
      sourceOkfTrustTierOverride: signals.trustTier,
      sourceOkfStaleAfterEpochDayOverride: signals.staleAfterEpochDay
    },
    dirtyCommunityPartitionKeys: [],
    includeValidation: false,
    maximumAttempts: input.target.maximumAttempts
  });
  return selectSemanticCrudStages(input.mutationKind, stages);
}

function parseSemanticTarget(value: string | undefined): SemanticSourceStageTarget {
  try {
    const target = JSON.parse(requiredString(value)) as SemanticSourceStageTarget;
    if (!target || typeof target !== "object"
      || typeof target.semanticGenerationPublicId !== "string"
      || typeof target.extractionContractVersion !== "string"
      || typeof target.embeddingConfigurationRevisionPublicId !== "string"
      || !Number.isSafeInteger(target.maximumAttempts)
      || target.maximumAttempts < 1 || target.maximumAttempts > 100
      || !target.settingsSnapshot
      || typeof target.settingsSnapshot !== "object"
      || Buffer.byteLength(JSON.stringify(target.settingsSnapshot)) > 32_768) {
      throw new Error("invalid");
    }
    return target;
  } catch {
    throw mutationActivationError("semantic_target_invalid");
  }
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
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
  await transaction`
    UPDATE focowiki.semantic_evidence
    SET logical_path = CASE
          WHEN logical_path = ${`pages/${input.currentLogicalPath}`}
            THEN ${`pages/${input.candidateLogicalPath}`}
          ELSE ${input.candidateLogicalPath}
        END
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND source_file_public_id = ${input.sourceFilePublicId}
  `;
  await transaction`
    UPDATE focowiki.semantic_vector_documents
    SET evidence_target_path = CASE
          WHEN evidence_target_path = ${`pages/${input.currentLogicalPath}`}
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
    if (input.checkpoint.semanticState === "ready"
      && input.checkpoint.currentRevisionPublicId
      && input.checkpoint.currentRevisionPublicId
        !== input.checkpoint.candidateRevisionPublicId) {
      await activateSemanticSourceRevision(transaction, {
        knowledgeBaseId: input.knowledgeBaseId,
        semanticGenerationPublicId: requiredString(
          input.checkpoint.semanticGenerationPublicId
        ),
        sourceFilePublicId: input.checkpoint.targetPublicId,
        priorSourceRevisionPublicId:
          input.checkpoint.candidateRevisionPublicId,
        currentSourceRevisionPublicId:
          input.checkpoint.currentRevisionPublicId,
        activatedAt: input.completedAt
      });
    }
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
        targetPublicId: input.checkpoint.targetPublicId,
        ...(input.checkpoint.semanticState ? {
          semanticState: input.terminalState === "completed"
            ? input.checkpoint.semanticState === "ready"
              ? "completed"
              : "degraded"
            : "failed",
          semanticGenerationPublicId:
            input.checkpoint.semanticGenerationPublicId ?? null,
          semanticSafeCode: input.terminalState === "completed"
            ? input.checkpoint.semanticSafeCode ?? null
            : input.resultCode
        } : {})
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
