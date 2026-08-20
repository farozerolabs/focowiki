import type { DatabaseClient } from "../../db/client.js";

export async function readPostgresDocumentRevisionObjectIds(input: {
  transaction: DatabaseClient;
  knowledgeBaseId: string;
  sourceRevisionPublicId: string;
}): Promise<string[]> {
  const rows = await input.transaction<Array<{ object_id: string }>>`
    SELECT object_id
    FROM (
      SELECT revision.object_id
      FROM focowiki.source_revisions revision
      WHERE revision.knowledge_base_id = ${input.knowledgeBaseId}
        AND revision.public_id = ${input.sourceRevisionPublicId}
      UNION
      SELECT artifact.object_id
      FROM focowiki.embedding_artifacts artifact
      WHERE artifact.knowledge_base_id = ${input.knowledgeBaseId}
        AND artifact.source_revision_public_id = ${input.sourceRevisionPublicId}
      UNION
      SELECT candidate.object_id
      FROM focowiki.generated_page_candidates candidate
      WHERE candidate.knowledge_base_id = ${input.knowledgeBaseId}
        AND candidate.source_revision_public_id = ${input.sourceRevisionPublicId}
      UNION
      SELECT owner.object_id
      FROM focowiki.object_owners owner
      WHERE owner.knowledge_base_id = ${input.knowledgeBaseId}
        AND (
          owner.source_revision_public_id = ${input.sourceRevisionPublicId}
          OR owner.source_receipt_public_id IN (
            SELECT receipt.public_id
            FROM focowiki.document_artifact_receipts receipt
            JOIN focowiki.document_artifact_work work
              ON work.public_id = receipt.work_public_id
            WHERE work.knowledge_base_id = ${input.knowledgeBaseId}
              AND work.source_revision_public_id = ${input.sourceRevisionPublicId}
          )
          OR owner.generated_page_candidate_public_id IN (
            SELECT candidate.public_id
            FROM focowiki.generated_page_candidates candidate
            WHERE candidate.knowledge_base_id = ${input.knowledgeBaseId}
              AND candidate.source_revision_public_id
                = ${input.sourceRevisionPublicId}
          )
          OR owner.embedding_artifact_public_id IN (
            SELECT artifact.public_id
            FROM focowiki.embedding_artifacts artifact
            WHERE artifact.knowledge_base_id = ${input.knowledgeBaseId}
              AND artifact.source_revision_public_id
                = ${input.sourceRevisionPublicId}
          )
        )
    ) released
    ORDER BY object_id COLLATE "C"
  `;
  return rows.map((row) => row.object_id);
}

export async function queuePostgresReleasedDocumentRevisionObjects(input: {
  transaction: DatabaseClient;
  knowledgeBaseId: string;
  operationPublicId: string | null;
  purgeActionPublicId: string;
  objectIds: readonly string[];
  queuedAt: string;
}): Promise<void> {
  if (input.objectIds.length === 0) return;
  const zeroOwnerObjects = await input.transaction<Array<{ object_id: string }>>`
    UPDATE focowiki.object_registrations registration
    SET zero_owner_since = coalesce(registration.zero_owner_since, ${input.queuedAt})
    WHERE registration.object_id = ANY(${input.objectIds}::text[])
      AND registration.state = 'verified'
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.object_owners owner
        WHERE owner.object_id = registration.object_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.source_revisions revision
        WHERE revision.object_id = registration.object_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.generated_page_candidates candidate
        WHERE candidate.object_id = registration.object_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.upload_entries entry
        WHERE entry.object_id = registration.object_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.embedding_artifacts artifact
        WHERE artifact.object_id = registration.object_id
      )
    RETURNING registration.object_id
  `;
  if (zeroOwnerObjects.length === 0) return;
  const queuedObjectIds = zeroOwnerObjects.map((row) => row.object_id);
  await input.transaction`
    INSERT INTO focowiki.cleanup_actions (
      public_id, knowledge_base_id, operation_public_id,
      document_job_public_id, action_kind, cleanup_plane, resource_kind,
      resource_public_id, required, priority, sequence_number,
      idempotency_key, request_hash, checkpoint, state, attempt_count,
      maximum_attempts, not_before, created_at, updated_at
    )
    SELECT 'cleanup-replaced-revision-object-' || md5(
             ${input.purgeActionPublicId} || chr(31) || object_id
           ),
           ${input.knowledgeBaseId}, ${input.operationPublicId}, NULL,
           'zero_owner_object', 'object_storage', 'zero_owner_object',
           object_id, true, 40,
           row_number() OVER (ORDER BY object_id COLLATE "C")::integer,
           'replaced-revision-object:' || ${input.purgeActionPublicId}
             || ':' || object_id,
           md5(object_id),
           jsonb_build_object(
             'schemaVersion', 'replaced-document-revision-object-release-v1'
           ),
           'queued', 0, 8, ${input.queuedAt}, ${input.queuedAt},
           ${input.queuedAt}
    FROM unnest(${queuedObjectIds}::text[]) AS released(object_id)
    ON CONFLICT ON CONSTRAINT cleanup_actions_idempotency_key DO NOTHING
  `;
}
