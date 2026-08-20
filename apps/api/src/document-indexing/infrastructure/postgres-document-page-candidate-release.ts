import type { DatabaseClient } from "../../db/client.js";

export type ReleasedDocumentPageCandidates = {
  releasedCandidateCount: number;
  queuedObjectCount: number;
};

export async function releasePostgresDocumentPageCandidates(input: {
  transaction: DatabaseClient;
  knowledgeBaseId: string;
  documentJobPublicId: string;
  operationPublicId: string;
  retainedCandidatePublicIds: readonly string[];
  releasedAt: string;
}): Promise<ReleasedDocumentPageCandidates> {
  const sql = input.transaction;
  const retainedCandidatePublicIds = [...new Set(
    input.retainedCandidatePublicIds
  )];
  const releasable = await sql<Array<{
    public_id: string;
    object_id: string;
  }>>`
    WITH job_work AS (
      SELECT work.public_id
      FROM focowiki.document_artifact_work work
      WHERE work.knowledge_base_id = ${input.knowledgeBaseId}
        AND work.document_job_public_id = ${input.documentJobPublicId}
    ), releasable AS (
      SELECT candidate.public_id, candidate.object_id
      FROM job_work
      JOIN focowiki.generated_page_candidates candidate
        ON candidate.knowledge_base_id = ${input.knowledgeBaseId}
       AND candidate.source_work_public_id = job_work.public_id
      WHERE candidate.public_id <> ALL(${retainedCandidatePublicIds}::text[])
        AND NOT EXISTS (
          SELECT 1
          FROM focowiki.generated_page_heads head
          WHERE head.knowledge_base_id = candidate.knowledge_base_id
            AND head.page_candidate_public_id = candidate.public_id
        )
      UNION
      SELECT candidate.public_id, candidate.object_id
      FROM focowiki.generated_page_candidates candidate
      WHERE candidate.knowledge_base_id = ${input.knowledgeBaseId}
        AND candidate.state = 'active'
        AND candidate.public_id <> ALL(${retainedCandidatePublicIds}::text[])
        AND NOT EXISTS (
          SELECT 1
          FROM focowiki.generated_page_heads head
          WHERE head.knowledge_base_id = candidate.knowledge_base_id
            AND head.page_candidate_public_id = candidate.public_id
        )
    )
    SELECT public_id, object_id
    FROM releasable
    ORDER BY public_id COLLATE "C"
  `;
  if (releasable.length === 0) {
    return { releasedCandidateCount: 0, queuedObjectCount: 0 };
  }
  const candidatePublicIds = releasable.map((candidate) => candidate.public_id);
  const deleted = await sql<Array<{ public_id: string; object_id: string }>>`
    DELETE FROM focowiki.generated_page_candidates candidate
    WHERE candidate.knowledge_base_id = ${input.knowledgeBaseId}
      AND candidate.public_id = ANY(${candidatePublicIds}::text[])
      AND NOT EXISTS (
        SELECT 1
        FROM focowiki.generated_page_heads head
        WHERE head.knowledge_base_id = candidate.knowledge_base_id
          AND head.page_candidate_public_id = candidate.public_id
      )
    RETURNING candidate.public_id, candidate.object_id
  `;
  if (deleted.length === 0) {
    return { releasedCandidateCount: 0, queuedObjectCount: 0 };
  }
  const deletedCandidatePublicIds = deleted.map((candidate) => candidate.public_id);
  const objectIds = [...new Set(deleted.map((candidate) => candidate.object_id))];
  await sql`
    UPDATE focowiki.scoped_activation_owners owner
    SET active_page_candidate_public_id = NULL,
        updated_at = ${input.releasedAt}
    WHERE owner.knowledge_base_id = ${input.knowledgeBaseId}
      AND owner.active_page_candidate_public_id
        = ANY(${deletedCandidatePublicIds}::text[])
  `;

  const zeroOwnerObjects = await sql<Array<{ object_id: string }>>`
    UPDATE focowiki.object_registrations registration
    SET zero_owner_since = coalesce(registration.zero_owner_since, ${input.releasedAt})
    WHERE registration.object_id = ANY(${objectIds}::text[])
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
  if (zeroOwnerObjects.length > 0) {
    const queuedObjectIds = zeroOwnerObjects.map((object) => object.object_id);
    await sql`
      INSERT INTO focowiki.cleanup_actions (
        public_id, knowledge_base_id, operation_public_id,
        document_job_public_id, action_kind, cleanup_plane, resource_kind,
        resource_public_id, required, priority, sequence_number,
        idempotency_key, request_hash, checkpoint, state, attempt_count,
        maximum_attempts, not_before, created_at, updated_at
      )
      SELECT 'cleanup-page-candidate-' || md5(
               ${input.documentJobPublicId} || chr(31) || object_id
             ),
             ${input.knowledgeBaseId}, ${input.operationPublicId},
             ${input.documentJobPublicId}, 'zero_owner_object',
             'object_storage', 'zero_owner_object', object_id, true, 40,
             row_number() OVER (ORDER BY object_id COLLATE "C")::integer,
             'page-candidate-release:' || ${input.documentJobPublicId}
               || ':' || object_id,
             md5(object_id),
             jsonb_build_object(
               'schemaVersion', 'document-page-candidate-release-v1'
             ),
             'queued', 0, 8, ${input.releasedAt}, ${input.releasedAt},
             ${input.releasedAt}
      FROM unnest(${queuedObjectIds}::text[]) AS released(object_id)
      ON CONFLICT ON CONSTRAINT cleanup_actions_idempotency_key DO NOTHING
    `;
  }
  return {
    releasedCandidateCount: deleted.length,
    queuedObjectCount: zeroOwnerObjects.length
  };
}
