import type { DatabaseClient } from "../../db/client.js";

export async function ensurePostgresDocumentCleanupIntent(input: {
  transaction: DatabaseClient;
  knowledgeBaseId: string;
  documentJobPublicId: string;
  operationPublicId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  affectedSourceFilePublicIds: readonly string[];
  createdAt: string;
}): Promise<readonly string[]> {
  const sql = input.transaction;
  const affectedSourceFilePublicIds = [...new Set([
    input.sourceFilePublicId,
    ...input.affectedSourceFilePublicIds
  ])].sort();
  const rows = await sql<Array<{ public_id: string }>>`
    WITH obsolete_resources AS (
      SELECT owner.source_revision_public_id,
             'search'::text AS cleanup_plane,
             owner.provider_kind AS search_provider_kind,
             'search_document'::text AS resource_kind,
             owner.provider_document_id AS resource_public_id,
             owner.document_checksum_sha256 AS request_hash
      FROM focowiki.search_document_owners owner
      WHERE owner.knowledge_base_id = ${input.knowledgeBaseId}
        AND owner.source_file_public_id = ANY(${affectedSourceFilePublicIds}::text[])
        AND owner.state = 'obsolete'
      UNION ALL
      SELECT vector.source_revision_public_id,
             'vector'::text,
             contract.search_provider_kind,
             'vector_document'::text,
             vector.public_id,
             md5(vector.public_id)
      FROM focowiki.semantic_vector_documents vector
      JOIN focowiki.semantic_projection_contracts contract
        ON contract.knowledge_base_id = vector.knowledge_base_id
       AND contract.public_id = vector.projection_contract_public_id
      WHERE vector.knowledge_base_id = ${input.knowledgeBaseId}
        AND vector.source_file_public_id = ANY(${affectedSourceFilePublicIds}::text[])
        AND vector.state = 'deleted'
    ), distinct_resources AS (
      SELECT DISTINCT ON (
        cleanup_plane, search_provider_kind, resource_kind,
        resource_public_id
      ) source_revision_public_id, cleanup_plane, search_provider_kind,
        resource_kind, resource_public_id, request_hash
      FROM obsolete_resources
      ORDER BY cleanup_plane, search_provider_kind, resource_kind,
               resource_public_id, source_revision_public_id
    ), inserted AS (
      INSERT INTO focowiki.cleanup_actions (
        public_id, knowledge_base_id, operation_public_id,
        document_job_public_id, source_revision_public_id,
        action_kind, cleanup_plane, search_provider_kind,
        resource_kind, resource_public_id, required, priority,
        sequence_number, idempotency_key, request_hash, checkpoint,
        state, attempt_count, maximum_attempts, not_before,
        created_at, updated_at
      )
      SELECT 'document-cleanup-' || md5(
               ${input.knowledgeBaseId} || chr(31) || cleanup_plane
               || chr(31) || coalesce(search_provider_kind, '')
               || chr(31) || resource_kind || chr(31) || resource_public_id
             ),
             ${input.knowledgeBaseId}, ${input.operationPublicId},
             ${input.documentJobPublicId}, source_revision_public_id,
             'document_obsolete_artifact', cleanup_plane,
             search_provider_kind, resource_kind, resource_public_id,
             true, 200,
             row_number() OVER (
               ORDER BY cleanup_plane, resource_kind,
                        resource_public_id COLLATE "C"
             )::integer,
             'fixed-dag:' || cleanup_plane || ':' || resource_kind
               || ':' || resource_public_id,
             request_hash,
             jsonb_build_object(
               'schemaVersion', 'document-cleanup-intent-v1',
               'activatingSourceRevisionPublicId',
                 ${input.sourceRevisionPublicId}::text
             ),
             'queued', 0, 8, ${input.createdAt},
             ${input.createdAt}, ${input.createdAt}
      FROM distinct_resources
      ON CONFLICT DO NOTHING
      RETURNING public_id
    )
    SELECT public_id FROM inserted
    UNION
    SELECT action.public_id
    FROM focowiki.cleanup_actions action
    JOIN distinct_resources resource
      ON action.cleanup_plane = resource.cleanup_plane
     AND action.search_provider_kind IS NOT DISTINCT FROM resource.search_provider_kind
     AND action.resource_kind = resource.resource_kind
     AND action.resource_public_id = resource.resource_public_id
    WHERE action.knowledge_base_id = ${input.knowledgeBaseId}
      AND action.action_kind = 'document_obsolete_artifact'
    ORDER BY public_id
  `;
  return rows.map((row) => row.public_id);
}
