import type { DatabaseClient } from "../../db/client.js";
import type { DocumentDirectoryNavigationMutation } from
  "../application/document-directory-navigation-mutation.js";
import { applyPostgresDocumentPublicationNavigationManifest } from
  "./postgres-document-publication-navigation-manifest.js";

export async function activatePostgresDocumentPublicationPages(input: {
  transaction: DatabaseClient;
  jobPublicId: string;
  knowledgeBaseId: string;
  targetReadinessSequence: number;
  activatedAt: string;
}): Promise<Readonly<{
  putCount: number;
  deleteCount: number;
  directoryCount: number;
}>> {
  const sql = input.transaction;
  const pages = await sql<Array<{
    logical_path: string;
    normalized_path: string;
    action: "put" | "delete";
    entry_kind: string | null;
    source_file_public_id: string | null;
    source_revision_public_id: string | null;
    object_id: string | null;
    checksum_sha256: string | null;
    byte_count: number | string | null;
    navigation_mutations: unknown;
  }>>`
    SELECT logical_path, normalized_path, action, entry_kind,
           source_file_public_id, source_revision_public_id, object_id,
           checksum_sha256, byte_count, navigation_mutations
    FROM focowiki.publication_job_outputs
    WHERE job_public_id = ${input.jobPublicId}
    ORDER BY output_order
  `;
  const puts = pages.filter((page) => page.action === "put");
  const deletes = pages.filter((page) => page.action === "delete");
  if (puts.some((page) => page.object_id === null
    || page.checksum_sha256 === null || page.byte_count === null
    || page.entry_kind === null)) {
    throw activationError("publication_output_manifest_invalid");
  }
  const affectedPaths = [...new Set(pages.map((page) => page.normalized_path))];
  const displacedHeads: Array<{ object_id: string }> = [];
  for (const paths of batches(affectedPaths, 500)) {
    displacedHeads.push(...await sql<Array<{ object_id: string }>>`
        SELECT object_id FROM focowiki.generated_page_heads
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND normalized_path IN ${sql(paths)}
        ORDER BY normalized_path COLLATE "C"
        FOR UPDATE
      `);
  }
  let activatedPutCount = 0;
  for (const batch of batches(puts, 500)) {
    const activated = await sql<Array<{ normalized_path: string }>>`
      INSERT INTO focowiki.generated_page_heads (
        knowledge_base_id, logical_path, normalized_path, entry_kind,
        source_file_public_id, source_revision_public_id,
        page_candidate_public_id, object_id, checksum_sha256, byte_count,
        activation_revision, updated_at
      )
      SELECT ${input.knowledgeBaseId}, desired.logical_path,
             desired.normalized_path, desired.entry_kind,
             desired.source_file_public_id, desired.source_revision_public_id,
             NULL, desired.object_id, desired.checksum_sha256,
             desired.byte_count, ${input.targetReadinessSequence},
             ${input.activatedAt}
      FROM jsonb_to_recordset(${sql.json(batch as never)}::jsonb) desired(
        logical_path text, normalized_path text, entry_kind text,
        source_file_public_id text, source_revision_public_id text,
        object_id text, checksum_sha256 text, byte_count bigint
      )
      ON CONFLICT (knowledge_base_id, normalized_path) DO UPDATE
      SET logical_path = excluded.logical_path,
          entry_kind = excluded.entry_kind,
          source_file_public_id = excluded.source_file_public_id,
          source_revision_public_id = excluded.source_revision_public_id,
          page_candidate_public_id = NULL,
          object_id = excluded.object_id,
          checksum_sha256 = excluded.checksum_sha256,
          byte_count = excluded.byte_count,
          activation_revision = excluded.activation_revision,
          updated_at = excluded.updated_at
      WHERE generated_page_heads.activation_revision
              <= excluded.activation_revision
      RETURNING normalized_path
    `;
    if (activated.length !== batch.length) {
      throw activationError("publication_page_owner_revision_stale");
    }
    activatedPutCount += activated.length;
  }
  for (const batch of batches(deletes, 500)) {
    await sql`
      DELETE FROM focowiki.generated_page_heads head
      USING unnest(${batch.map((page) => page.normalized_path)}::text[])
        desired(normalized_path)
      WHERE head.knowledge_base_id = ${input.knowledgeBaseId}
        AND head.normalized_path = desired.normalized_path
        AND head.activation_revision <= ${input.targetReadinessSequence}
    `;
  }
  const legacyMutations = pages.flatMap((page) =>
    Array.isArray(page.navigation_mutations)
      ? page.navigation_mutations as DocumentDirectoryNavigationMutation[] : []);
  const directoryCount =
    await applyPostgresDocumentPublicationNavigationManifest({
    transaction: sql,
    jobPublicId: input.jobPublicId,
    knowledgeBaseId: input.knowledgeBaseId,
    activationRevision: input.targetReadinessSequence,
    activatedAt: input.activatedAt,
    legacyMutations
  });
  await enqueueDisplacedHeadObjectCleanup({
    sql,
    knowledgeBaseId: input.knowledgeBaseId,
    jobPublicId: input.jobPublicId,
    objectIds: [...new Set(displacedHeads.map((head) => head.object_id))],
    activatedAt: input.activatedAt
  });
  return {
    putCount: activatedPutCount,
    deleteCount: deletes.length,
    directoryCount
  };
}

function batches<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function enqueueDisplacedHeadObjectCleanup(input: Readonly<{
  sql: DatabaseClient;
  knowledgeBaseId: string;
  jobPublicId: string;
  objectIds: readonly string[];
  activatedAt: string;
}>): Promise<void> {
  if (input.objectIds.length === 0) return;
  for (const objectIds of batches(input.objectIds, 500)) {
    await input.sql`
    WITH marked_objects AS (
      UPDATE focowiki.object_registrations registration
      SET zero_owner_since = coalesce(
            registration.zero_owner_since, ${input.activatedAt}
          )
      WHERE registration.object_id IN ${input.sql(objectIds)}
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
          SELECT 1 FROM focowiki.generated_page_heads head
          WHERE head.object_id = registration.object_id
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
    )
    INSERT INTO focowiki.cleanup_actions (
      public_id, knowledge_base_id, action_kind, cleanup_plane,
      resource_kind, resource_public_id, required, priority,
      sequence_number, idempotency_key, request_hash, checkpoint,
      state, attempt_count, maximum_attempts, not_before,
      created_at, updated_at
    )
    SELECT 'cleanup-publication-head-' || md5(
             ${input.jobPublicId} || chr(31) || object_id
           ),
           ${input.knowledgeBaseId}, 'zero_owner_object',
           'object_storage', 'zero_owner_object', object_id, true, 40,
           row_number() OVER (ORDER BY object_id COLLATE "C")::integer,
           'publication-head:' || ${input.jobPublicId} || ':' || object_id,
           md5(object_id),
           jsonb_build_object(
             'schemaVersion', 'publication-head-displacement-v2',
             'publicationJobPublicId', ${input.jobPublicId}::text
           ),
           'queued', 0, 8, ${input.activatedAt}, ${input.activatedAt},
           ${input.activatedAt}
    FROM marked_objects
    WHERE NOT EXISTS (
      SELECT 1 FROM focowiki.cleanup_actions existing
      WHERE existing.action_kind = 'zero_owner_object'
        AND existing.resource_public_id = marked_objects.object_id
        AND existing.state IN ('queued', 'running', 'retry')
    )
    ON CONFLICT ON CONSTRAINT cleanup_actions_idempotency_key DO NOTHING
    `;
  }
}

function activationError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Publication page activation error: ${code}`), {
    code
  });
}
