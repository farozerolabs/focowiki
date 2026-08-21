import type { DatabaseClient } from "../../db/client.js";

const TERMINAL_JOB_STATES = [
  "available", "error", "cancelled", "superseded"
] as const;

export async function releasePostgresProjectionScopeOutputsForDocument(input: {
  transaction: DatabaseClient;
  knowledgeBaseId: string;
  documentJobPublicId: string;
  releasedAt: string;
}): Promise<{ releasedOutputCount: number; queuedObjectCount: number }> {
  const sql = input.transaction;
  const rows = await sql<Array<{
    scope_public_id: string;
    rendered_sequence: number | string;
    object_ids: string[];
  }>>`
    SELECT DISTINCT output.scope_public_id, output.rendered_sequence,
           coalesce(objects.object_ids, '{}'::text[]) AS object_ids
    FROM focowiki.projection_scope_contributions contribution
    JOIN focowiki.projection_scope_receipts receipt
      ON receipt.contribution_public_id = contribution.public_id
    JOIN focowiki.projection_scope_outputs output
      ON output.scope_public_id = receipt.scope_public_id
     AND output.rendered_sequence = receipt.rendered_sequence
    CROSS JOIN LATERAL (
      SELECT array_agg(DISTINCT page->>'objectId')
        FILTER (WHERE page->>'objectId' IS NOT NULL) AS object_ids
      FROM jsonb_array_elements(output.pages) page
    ) objects
    WHERE contribution.knowledge_base_id = ${input.knowledgeBaseId}
      AND contribution.document_job_public_id = ${input.documentJobPublicId}
      AND NOT EXISTS (
        SELECT 1
        FROM focowiki.projection_scope_receipts active_receipt
        JOIN focowiki.projection_scope_contributions active_contribution
          ON active_contribution.public_id
               = active_receipt.contribution_public_id
        JOIN focowiki.document_processing_jobs active_job
          ON active_job.knowledge_base_id
               = active_contribution.knowledge_base_id
         AND active_job.public_id
               = active_contribution.document_job_public_id
        WHERE active_receipt.scope_public_id = output.scope_public_id
          AND active_receipt.rendered_sequence = output.rendered_sequence
          AND active_job.state <> ALL(${[...TERMINAL_JOB_STATES]}::text[])
      )
  `;
  if (rows.length === 0) {
    return { releasedOutputCount: 0, queuedObjectCount: 0 };
  }
  const outputs = rows.map((row) => ({
    scope_public_id: row.scope_public_id,
    rendered_sequence: Number(row.rendered_sequence)
  }));
  const objectIds = [...new Set(rows.flatMap((row) => row.object_ids))];
  const deleted = await sql<Array<{ scope_public_id: string }>>`
    DELETE FROM focowiki.projection_scope_outputs output
    USING jsonb_to_recordset(${sql.json(outputs as never)}::jsonb) desired(
      scope_public_id text, rendered_sequence bigint
    )
    WHERE output.scope_public_id = desired.scope_public_id
      AND output.rendered_sequence = desired.rendered_sequence
    RETURNING output.scope_public_id
  `;
  if (objectIds.length === 0) {
    return { releasedOutputCount: deleted.length, queuedObjectCount: 0 };
  }
  const zeroOwnerObjects = await sql<Array<{ object_id: string }>>`
    UPDATE focowiki.object_registrations registration
    SET zero_owner_since = coalesce(registration.zero_owner_since,
                                    ${input.releasedAt})
    WHERE registration.object_id IN ${sql(objectIds)}
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
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.projection_scope_object_refs reference
        WHERE reference.object_id = registration.object_id
      )
    RETURNING registration.object_id
  `;
  if (zeroOwnerObjects.length > 0) {
    const operationRows = await sql<Array<{ operation_public_id: string }>>`
      SELECT operation_public_id
      FROM focowiki.document_processing_jobs
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND public_id = ${input.documentJobPublicId}
      LIMIT 1
    `;
    const operationPublicId = operationRows[0]?.operation_public_id;
    if (!operationPublicId) {
      throw projectionOutputReleaseError("document_job_missing");
    }
    const releasedObjectIds = zeroOwnerObjects.map((row) => row.object_id);
    await sql`
      INSERT INTO focowiki.cleanup_actions (
        public_id, knowledge_base_id, operation_public_id,
        document_job_public_id, action_kind, cleanup_plane, resource_kind,
        resource_public_id, required, priority, sequence_number,
        idempotency_key, request_hash, checkpoint, state, attempt_count,
        maximum_attempts, not_before, created_at, updated_at
      )
      SELECT 'cleanup-projection-output-' || md5(
               ${input.documentJobPublicId} || chr(31) || object_id
             ),
             ${input.knowledgeBaseId}, ${operationPublicId},
             ${input.documentJobPublicId}, 'zero_owner_object',
             'object_storage', 'zero_owner_object', object_id, true, 40,
             row_number() OVER (ORDER BY object_id COLLATE "C")::integer,
             'projection-output-release:' || ${input.documentJobPublicId}
               || ':' || object_id,
             md5(object_id),
             jsonb_build_object(
               'schemaVersion', 'projection-scope-output-release-v1'
             ),
             'queued', 0, 8, ${input.releasedAt}, ${input.releasedAt},
             ${input.releasedAt}
      FROM unnest(${releasedObjectIds}::text[]) AS released(object_id)
      ON CONFLICT ON CONSTRAINT cleanup_actions_idempotency_key DO NOTHING
    `;
  }
  return {
    releasedOutputCount: deleted.length,
    queuedObjectCount: zeroOwnerObjects.length
  };
}

function projectionOutputReleaseError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Projection output release error: ${code}`), {
    code
  });
}
