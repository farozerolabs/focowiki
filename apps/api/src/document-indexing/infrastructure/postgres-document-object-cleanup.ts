import type { TransactionSql } from "postgres";
import type { DocumentResourceDeletionAction } from
  "../application/document-resource-deletion-worker.js";

export async function enqueueExternalArtifactCleanup(
  sql: TransactionSql,
  action: DocumentResourceDeletionAction,
  sourceIds: readonly string[],
  now: string
): Promise<void> {
  await sql`
    INSERT INTO focowiki.cleanup_actions (
      public_id, knowledge_base_id, operation_public_id,
      source_revision_public_id, action_kind, cleanup_plane,
      search_provider_kind, resource_kind, resource_public_id, required, priority,
      sequence_number, idempotency_key, request_hash, checkpoint,
      state, attempt_count, maximum_attempts, not_before, created_at, updated_at
    )
    SELECT 'document-cleanup-' || md5(
             ${action.operationPublicId} || chr(31) || resource.cleanup_plane
             || chr(31) || coalesce(resource.search_provider_kind, '')
             || chr(31) || resource.resource_public_id
           ), ${action.knowledgeBaseId}, ${action.operationPublicId},
           resource.source_revision_public_id, 'document_obsolete_artifact',
           resource.cleanup_plane, resource.search_provider_kind,
           resource.resource_kind,
           resource.resource_public_id, true, 30,
           row_number() OVER (
             ORDER BY resource.cleanup_plane,
                      resource.resource_public_id COLLATE "C"
           )::integer,
           resource.cleanup_plane || ':'
             || coalesce(resource.search_provider_kind, '') || ':'
             || resource.resource_public_id,
           resource.request_hash, jsonb_build_object(
             'schemaVersion', 'document-resource-cleanup-v1'
           ),
           'queued', 0, 8, ${now}, ${now}, ${now}
    FROM (
      SELECT owner.source_revision_public_id,
             'search'::text AS cleanup_plane,
             owner.provider_kind AS search_provider_kind,
             'search_document'::text AS resource_kind,
             owner.provider_document_id AS resource_public_id,
             owner.document_checksum_sha256 AS request_hash
      FROM focowiki.search_document_owners owner
      WHERE owner.knowledge_base_id = ${action.knowledgeBaseId}
        AND owner.source_file_public_id = ANY(${sourceIds}::text[])
        AND owner.state = 'obsolete'
      UNION ALL
      SELECT vector.source_revision_public_id, 'vector'::text,
             contract.search_provider_kind,
             'vector_document'::text, vector.public_id,
             md5(vector.public_id)
      FROM focowiki.semantic_vector_documents vector
      JOIN focowiki.semantic_projection_contracts contract
        ON contract.knowledge_base_id = vector.knowledge_base_id
       AND contract.public_id = vector.projection_contract_public_id
      WHERE vector.knowledge_base_id = ${action.knowledgeBaseId}
        AND vector.source_file_public_id = ANY(${sourceIds}::text[])
        AND vector.state = 'deleted'
    ) resource
    ON CONFLICT ON CONSTRAINT cleanup_actions_idempotency_key DO NOTHING
  `;
}

export async function releaseDeletedSourceObjectOwnership(
  sql: TransactionSql,
  action: DocumentResourceDeletionAction,
  sourceIds: readonly string[],
  now: string
): Promise<void> {
  await sql`
    WITH affected_revisions AS (
      SELECT public_id FROM focowiki.source_revisions
      WHERE knowledge_base_id = ${action.knowledgeBaseId}
        AND source_file_public_id = ANY(${sourceIds}::text[])
    ), affected_receipts AS (
      SELECT receipt.public_id
      FROM focowiki.document_artifact_receipts receipt
      WHERE receipt.knowledge_base_id = ${action.knowledgeBaseId}
        AND receipt.source_revision_public_id IN (SELECT public_id FROM affected_revisions)
    ), affected_pages AS (
      SELECT public_id FROM focowiki.generated_page_candidates
      WHERE knowledge_base_id = ${action.knowledgeBaseId}
        AND source_file_public_id = ANY(${sourceIds}::text[])
    ), removed_upload_entry_objects AS (
      DELETE FROM focowiki.upload_entries entry
      WHERE entry.knowledge_base_id = ${action.knowledgeBaseId}
        AND entry.source_file_public_id = ANY(${sourceIds}::text[])
      RETURNING entry.object_id
    ), removed_owner_objects AS (
      DELETE FROM focowiki.object_owners owner
      WHERE owner.knowledge_base_id = ${action.knowledgeBaseId}
        AND (
          owner.source_revision_public_id IN (SELECT public_id FROM affected_revisions)
          OR owner.source_receipt_public_id IN (SELECT public_id FROM affected_receipts)
          OR owner.generated_page_candidate_public_id IN (SELECT public_id FROM affected_pages)
        )
      RETURNING owner.object_id
    ), removed_objects AS (
      SELECT object_id FROM removed_owner_objects
      UNION
      SELECT object_id FROM removed_upload_entry_objects
      WHERE object_id IS NOT NULL
    ), cleanup_objects AS (
      SELECT removed.object_id
      FROM removed_objects removed
      WHERE NOT EXISTS (
        SELECT 1 FROM focowiki.source_revisions revision
        WHERE revision.object_id = removed.object_id
      )
    )
    INSERT INTO focowiki.cleanup_actions (
      public_id, knowledge_base_id, operation_public_id,
      action_kind, cleanup_plane, resource_kind, resource_public_id,
      required, priority, sequence_number, idempotency_key, request_hash,
      checkpoint, state, attempt_count, maximum_attempts, not_before,
      created_at, updated_at
    )
    SELECT 'cleanup-deleted-object-' || md5(
             ${action.operationPublicId} || chr(31) || removed.object_id
           ), ${action.knowledgeBaseId}, ${action.operationPublicId},
           'zero_owner_object', 'object_storage',
           'zero_owner_object', removed.object_id,
           true, 30, row_number() OVER (ORDER BY removed.object_id COLLATE "C")::integer,
           'deleted-object:' || removed.object_id, md5(removed.object_id),
           '{}'::jsonb, 'queued', 0, 8, ${now}, ${now}, ${now}
    FROM cleanup_objects removed
    ON CONFLICT ON CONSTRAINT cleanup_actions_idempotency_key DO NOTHING
  `;
}

export async function enqueuePurgedSourceObjectCleanup(
  sql: TransactionSql,
  action: DocumentResourceDeletionAction,
  objectIds: readonly string[],
  now: string
): Promise<void> {
  if (objectIds.length === 0) return;
  await sql`
    INSERT INTO focowiki.cleanup_actions (
      public_id, knowledge_base_id, operation_public_id,
      action_kind, cleanup_plane, resource_kind, resource_public_id,
      required, priority, sequence_number, idempotency_key, request_hash,
      checkpoint, state, attempt_count, maximum_attempts, not_before,
      created_at, updated_at
    )
    SELECT 'cleanup-deleted-object-' || md5(
             ${action.operationPublicId} || chr(31) || candidate.object_id
           ), ${action.knowledgeBaseId}, ${action.operationPublicId},
           'zero_owner_object', 'object_storage',
           'zero_owner_object', candidate.object_id,
           true, 30,
           row_number() OVER (ORDER BY candidate.object_id COLLATE "C")::integer,
           'deleted-object:' || candidate.object_id, md5(candidate.object_id),
           '{}'::jsonb, 'queued', 0, 8, ${now}, ${now}, ${now}
    FROM unnest(${objectIds}::text[]) AS candidate(object_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM focowiki.source_revisions revision
      WHERE revision.object_id = candidate.object_id
    )
    ON CONFLICT ON CONSTRAINT cleanup_actions_idempotency_key DO NOTHING
  `;
}
