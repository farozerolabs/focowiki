import type { DatabaseClient } from "../../db/client.js";
import type { DocumentDirectoryNavigationMutation } from
  "../application/document-directory-navigation-mutation.js";
import { applyPostgresDocumentDirectoryNavigation } from
  "./postgres-document-directory-navigation.js";

export async function activatePostgresDocumentPublicationPages(input: {
  transaction: DatabaseClient;
  generationPublicId: string;
  knowledgeBaseId: string;
  targetFactEpoch: number;
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
    object_id: string | null;
    checksum_sha256: string | null;
    byte_count: number | string | null;
    scope_identity: string;
    scope_kind: string;
    scope_key: string;
    source_revision_public_id: string | null;
  }>>`
    SELECT page.logical_path, page.normalized_path, page.action,
           page.entry_kind, page.object_id, page.checksum_sha256,
           page.byte_count, scope.scope_identity, scope.scope_kind,
           scope.scope_key, member.source_revision_public_id
    FROM focowiki.projection_scope_generation_pages page
    JOIN focowiki.projection_scope_generations scope
      ON scope.public_id = page.scope_generation_public_id
    LEFT JOIN LATERAL (
      SELECT snapshot.member_public_id AS source_revision_public_id
      FROM focowiki.projection_scope_snapshot_members snapshot
      JOIN focowiki.source_revisions revision
        ON revision.knowledge_base_id = ${input.knowledgeBaseId}
       AND revision.source_file_public_id = scope.scope_key
       AND revision.public_id = snapshot.member_public_id
      WHERE snapshot.scope_generation_public_id = scope.public_id
        AND snapshot.member_kind = 'source_revision'
      ORDER BY snapshot.member_order DESC
      LIMIT 1
    ) member ON true
    WHERE page.publication_generation_public_id = ${input.generationPublicId}
    ORDER BY page.normalized_path COLLATE "C"
  `;
  const puts = pages.filter((page) => page.action === "put");
  const deletes = pages.filter((page) => page.action === "delete");
  if (puts.some((page) => page.scope_kind === "source"
    && page.source_revision_public_id === null)) {
    throw activationError("publication_source_page_revision_missing");
  }
  const affectedPaths = [...new Set(pages.map((page) => page.normalized_path))];
  const displacedHeads = affectedPaths.length === 0 ? []
    : await sql<Array<{ object_id: string }>>`
      SELECT head.object_id
      FROM focowiki.generated_page_heads head
      WHERE head.knowledge_base_id = ${input.knowledgeBaseId}
        AND head.normalized_path IN ${sql(affectedPaths)}
      ORDER BY head.normalized_path COLLATE "C"
      FOR UPDATE
    `;
  if (puts.length > 0) {
    const desired = puts.map((page) => ({
      logical_path: page.logical_path,
      normalized_path: page.normalized_path,
      entry_kind: page.entry_kind,
      source_file_public_id: page.scope_kind === "source"
        ? page.scope_key : null,
      source_revision_public_id: page.scope_kind === "source"
        ? page.source_revision_public_id : null,
      object_id: page.object_id,
      checksum_sha256: page.checksum_sha256,
      byte_count: page.byte_count
    }));
    const activated = await sql<Array<{ normalized_path: string }>>`
      INSERT INTO focowiki.generated_page_heads (
        knowledge_base_id, logical_path, normalized_path, entry_kind,
        source_file_public_id, source_revision_public_id,
        page_candidate_public_id, object_id, checksum_sha256, byte_count,
        activation_revision, updated_at, projection_generation_public_id
      )
      SELECT ${input.knowledgeBaseId}, desired.logical_path,
             desired.normalized_path, desired.entry_kind,
             desired.source_file_public_id,
             desired.source_revision_public_id, NULL,
             desired.object_id, desired.checksum_sha256, desired.byte_count,
             ${input.targetFactEpoch}, ${input.activatedAt},
             ${input.generationPublicId}
      FROM jsonb_to_recordset(${sql.json(desired as never)}::jsonb) desired(
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
          updated_at = excluded.updated_at,
          projection_generation_public_id
            = excluded.projection_generation_public_id
      WHERE generated_page_heads.activation_revision
              <= excluded.activation_revision
      RETURNING normalized_path
    `;
    if (activated.length !== puts.length) {
      throw activationError("publication_page_owner_epoch_stale");
    }
  }
  if (deletes.length > 0) {
    await sql`
      DELETE FROM focowiki.generated_page_heads head
      USING unnest(${deletes.map((page) => page.normalized_path)}::text[])
        desired(normalized_path)
      WHERE head.knowledge_base_id = ${input.knowledgeBaseId}
        AND head.normalized_path = desired.normalized_path
        AND head.activation_revision <= ${input.targetFactEpoch}
    `;
  }
  await enqueueDisplacedHeadObjectCleanup({
    sql,
    knowledgeBaseId: input.knowledgeBaseId,
    generationPublicId: input.generationPublicId,
    objectIds: [...new Set(displacedHeads.map((head) => head.object_id))],
    activatedAt: input.activatedAt
  });
  await transferArtifactOwners(sql, input, pages);
  const directoryClaims = await sql<Array<{
    directory_path: string;
    owner_scope_identity: string;
  }>>`
    SELECT directory_path, owner_scope_identity
    FROM focowiki.projection_generation_directory_claims
    WHERE publication_generation_public_id = ${input.generationPublicId}
    ORDER BY directory_path COLLATE "C"
  `;
  if (directoryClaims.length > 0) {
    const transferred = await sql<Array<{ directory_path: string }>>`
      INSERT INTO focowiki.projection_directory_owners (
        knowledge_base_id, directory_path, owner_scope_identity,
        ownership_epoch, generation_public_id, updated_at
      )
      SELECT ${input.knowledgeBaseId}, claim.directory_path,
             claim.owner_scope_identity, ${input.targetFactEpoch},
             ${input.generationPublicId}, ${input.activatedAt}
      FROM jsonb_to_recordset(${sql.json(directoryClaims as never)}::jsonb)
        claim(directory_path text, owner_scope_identity text)
      ON CONFLICT (knowledge_base_id, directory_path) DO UPDATE
      SET owner_scope_identity = excluded.owner_scope_identity,
          ownership_epoch = excluded.ownership_epoch,
          generation_public_id = excluded.generation_public_id,
          updated_at = excluded.updated_at
      WHERE projection_directory_owners.ownership_epoch
              <= excluded.ownership_epoch
      RETURNING directory_path
    `;
    if (transferred.length !== directoryClaims.length) {
      throw activationError("publication_directory_owner_epoch_stale");
    }
  }
  const mutations = await sql<Array<{ mutation: unknown }>>`
    SELECT mutation
    FROM focowiki.projection_scope_navigation_mutations
    WHERE publication_generation_public_id = ${input.generationPublicId}
    ORDER BY directory_path COLLATE "C", mutation_order
  `;
  await applyPostgresDocumentDirectoryNavigation({
    transaction: sql,
    knowledgeBaseId: input.knowledgeBaseId,
    activationRevision: input.targetFactEpoch,
    mutations: mutations.map((row) =>
      row.mutation as DocumentDirectoryNavigationMutation),
    activatedAt: input.activatedAt
  });
  return {
    putCount: puts.length,
    deleteCount: deletes.length,
    directoryCount: directoryClaims.length
  };
}

async function enqueueDisplacedHeadObjectCleanup(input: Readonly<{
  sql: DatabaseClient;
  knowledgeBaseId: string;
  generationPublicId: string;
  objectIds: readonly string[];
  activatedAt: string;
}>): Promise<void> {
  if (input.objectIds.length === 0) return;
  await input.sql`
    WITH marked_objects AS (
      UPDATE focowiki.object_registrations registration
      SET zero_owner_since = coalesce(
            registration.zero_owner_since, ${input.activatedAt}
          )
      WHERE registration.object_id IN ${input.sql(input.objectIds)}
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
          SELECT 1
          FROM focowiki.projection_scope_generation_object_refs reference
          WHERE reference.object_id = registration.object_id
        )
        AND NOT focowiki.legacy_projection_object_is_referenced(
          registration.object_id
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
             ${input.generationPublicId} || chr(31) || object_id
           ),
           ${input.knowledgeBaseId}, 'zero_owner_object',
           'object_storage', 'zero_owner_object', object_id, true, 40,
           row_number() OVER (ORDER BY object_id COLLATE "C")::integer,
           'publication-head:' || ${input.generationPublicId}
             || ':' || object_id,
           md5(object_id),
           jsonb_build_object(
             'schemaVersion', 'publication-head-displacement-v1',
             'generationPublicId', ${input.generationPublicId}::text
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

async function transferArtifactOwners(
  sql: DatabaseClient,
  input: Readonly<{
    generationPublicId: string;
    knowledgeBaseId: string;
    targetFactEpoch: number;
    activatedAt: string;
  }>,
  pages: readonly Readonly<{
    normalized_path: string;
    scope_identity: string;
    scope_kind: string;
    scope_key: string;
  }>[]
): Promise<void> {
  if (pages.length === 0) return;
  const owners = pages.map((page) => ({
    normalized_path: page.normalized_path,
    owner_scope_identity: page.scope_identity,
    artifact_family: artifactFamily(page.scope_kind, page.scope_key)
  }));
  const transferred = await sql<Array<{ normalized_path: string }>>`
    INSERT INTO focowiki.projection_artifact_owners (
      knowledge_base_id, normalized_path, owner_scope_identity,
      artifact_family, ownership_epoch, generation_public_id, updated_at
    )
    SELECT ${input.knowledgeBaseId}, owner.normalized_path,
           owner.owner_scope_identity, owner.artifact_family,
           ${input.targetFactEpoch}, ${input.generationPublicId},
           ${input.activatedAt}
    FROM jsonb_to_recordset(${sql.json(owners as never)}::jsonb) owner(
      normalized_path text, owner_scope_identity text, artifact_family text
    )
    ON CONFLICT (knowledge_base_id, normalized_path) DO UPDATE
    SET owner_scope_identity = excluded.owner_scope_identity,
        artifact_family = excluded.artifact_family,
        ownership_epoch = excluded.ownership_epoch,
        generation_public_id = excluded.generation_public_id,
        updated_at = excluded.updated_at
    WHERE projection_artifact_owners.ownership_epoch
            <= excluded.ownership_epoch
    RETURNING normalized_path
  `;
  if (transferred.length !== owners.length) {
    throw activationError("publication_artifact_owner_epoch_stale");
  }
}

function artifactFamily(kind: string, key: string): string {
  if (kind === "source") return "source";
  if (kind === "directory") return "page_directory";
  if (kind === "_index") return key.startsWith("term:") ? "term" : "machine_index";
  if (kind === "_graph") return key === "catalog" ? "graph_catalog" : "graph";
  return "root";
}

function activationError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Publication page activation error: ${code}`), {
    code
  });
}
