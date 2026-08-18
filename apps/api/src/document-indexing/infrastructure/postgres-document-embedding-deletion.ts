import type { TransactionSql } from "postgres";
import type { DocumentResourceDeletionAction } from
  "../application/document-resource-deletion-worker.js";

export async function retireEmbeddingArtifacts(
  sql: TransactionSql,
  action: DocumentResourceDeletionAction,
  sourceIds: readonly string[]
): Promise<void> {
  const allKnowledgeBaseArtifacts = action.targetKind === "knowledge_base";
  await sql`
    WITH affected_revisions AS (
      SELECT public_id FROM focowiki.source_revisions
      WHERE knowledge_base_id = ${action.knowledgeBaseId}
        AND source_file_public_id = ANY(${sourceIds}::text[])
    )
    DELETE FROM focowiki.embedding_artifact_owners owner
    USING focowiki.embedding_artifacts artifact
    WHERE owner.knowledge_base_id = ${action.knowledgeBaseId}
      AND owner.artifact_public_id = artifact.public_id
      AND (
        ${allKnowledgeBaseArtifacts}
        OR artifact.source_revision_public_id IN (
          SELECT public_id FROM affected_revisions
        )
      )
  `;
  await sql`
    WITH affected_revisions AS (
      SELECT public_id FROM focowiki.source_revisions
      WHERE knowledge_base_id = ${action.knowledgeBaseId}
        AND source_file_public_id = ANY(${sourceIds}::text[])
    )
    UPDATE focowiki.embedding_artifacts artifact
    SET state = 'orphaned', deleted_at = NULL
    WHERE artifact.knowledge_base_id = ${action.knowledgeBaseId}
      AND (
        ${allKnowledgeBaseArtifacts}
        OR artifact.source_revision_public_id IN (
          SELECT public_id FROM affected_revisions
        )
      )
  `;
}

export async function purgeRetiredEmbeddingArtifacts(
  sql: TransactionSql,
  action: DocumentResourceDeletionAction,
  pageSize: number,
  now: string
): Promise<number> {
  const allKnowledgeBaseArtifacts = action.targetKind === "knowledge_base";
  const rows = await sql<Array<{ resource_public_id: string }>>`
    WITH candidates AS (
      SELECT artifact.public_id
      FROM focowiki.embedding_artifacts artifact
      WHERE artifact.knowledge_base_id = ${action.knowledgeBaseId}
        AND artifact.state = 'orphaned'
        AND (
          ${allKnowledgeBaseArtifacts}
          OR artifact.source_revision_public_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM focowiki.source_revisions revision
              WHERE revision.knowledge_base_id = artifact.knowledge_base_id
                AND revision.public_id = artifact.source_revision_public_id
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM focowiki.embedding_artifact_owners owner
          WHERE owner.artifact_public_id = artifact.public_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM focowiki.semantic_embedding_artifact_refs reference
          WHERE reference.artifact_public_id = artifact.public_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM focowiki.semantic_vector_documents vector
          WHERE vector.artifact_public_id = artifact.public_id
            AND vector.deleted_at IS NULL
            AND vector.state <> 'deleted'
        )
      ORDER BY artifact.public_id COLLATE "C"
      FOR UPDATE
      LIMIT ${pageSize}
    ), removed AS (
      DELETE FROM focowiki.embedding_artifacts artifact
      USING candidates
      WHERE artifact.public_id = candidates.public_id
      RETURNING artifact.object_id
    )
    INSERT INTO focowiki.cleanup_actions (
      public_id, knowledge_base_id, operation_public_id,
      action_kind, cleanup_plane, resource_kind, resource_public_id,
      required, priority, sequence_number, idempotency_key, request_hash,
      checkpoint, state, attempt_count, maximum_attempts, not_before,
      created_at, updated_at
    )
    SELECT 'cleanup-retired-embedding-' || md5(
             ${action.operationPublicId} || chr(31) || removed.object_id
           ), ${action.knowledgeBaseId}, ${action.operationPublicId},
           'zero_owner_object', 'object_storage',
           'zero_owner_object', removed.object_id,
           true, 30, row_number() OVER (
             ORDER BY removed.object_id COLLATE "C"
           )::integer,
           'retired-embedding:' || removed.object_id, md5(removed.object_id),
           '{}'::jsonb, 'queued', 0, 8, ${now}, ${now}, ${now}
    FROM (SELECT DISTINCT object_id FROM removed) removed
    ON CONFLICT ON CONSTRAINT cleanup_actions_idempotency_key DO NOTHING
    RETURNING resource_public_id
  `;
  return rows.length;
}
