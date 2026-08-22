import type { DatabaseClient } from "../../db/client.js";

export async function releaseSupersededPublicationGenerationReferences(
  input: Readonly<{
    transaction: DatabaseClient;
    knowledgeBaseId: string;
    releaseGenerationPublicId: string;
    retainedGenerationPublicId: string | null;
    releasedAt: string;
  }>
): Promise<number> {
  const rows = await input.transaction<Array<{
    released_object_count: number | string;
  }>>`
    WITH superseded_generations AS (
      UPDATE focowiki.projection_generation_retention retention
      SET retention_state = 'eligible', retain_until = ${input.releasedAt},
          reason = 'superseded-rollback-generation',
          updated_at = ${input.releasedAt}
      FROM focowiki.projection_publication_generations generation
      WHERE generation.public_id = retention.generation_public_id
        AND generation.knowledge_base_id = ${input.knowledgeBaseId}
        AND generation.state = 'obsolete'
        AND retention.retention_state = 'retained'
        AND generation.public_id
              IS DISTINCT FROM ${input.retainedGenerationPublicId}
      RETURNING retention.generation_public_id
    ), released_objects AS (
      DELETE FROM focowiki.projection_scope_generation_object_refs reference
      USING focowiki.projection_scope_generations scope,
            superseded_generations superseded
      WHERE reference.scope_generation_public_id = scope.public_id
        AND scope.publication_generation_public_id
              = superseded.generation_public_id
      RETURNING reference.object_id
    ), released_object_candidates AS (
      SELECT released.object_id
      FROM released_objects released
      UNION
      SELECT page.object_id
      FROM focowiki.projection_scope_generation_pages page
      JOIN superseded_generations superseded
        ON superseded.generation_public_id
             = page.publication_generation_public_id
      WHERE page.action = 'put' AND page.object_id IS NOT NULL
    ), marked_objects AS (
      UPDATE focowiki.object_registrations registration
      SET zero_owner_since = coalesce(
            registration.zero_owner_since, ${input.releasedAt}
          )
      WHERE registration.object_id IN (
          SELECT candidate.object_id
          FROM released_object_candidates candidate
        )
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
          JOIN focowiki.projection_scope_generations scope
            ON scope.public_id = reference.scope_generation_public_id
          WHERE reference.object_id = registration.object_id
            AND NOT EXISTS (
              SELECT 1 FROM superseded_generations superseded
              WHERE superseded.generation_public_id
                    = scope.publication_generation_public_id
            )
        )
        AND NOT focowiki.legacy_projection_object_is_referenced(
          registration.object_id
        )
      RETURNING registration.object_id
    ), queued_cleanup_actions AS (
      INSERT INTO focowiki.cleanup_actions (
        public_id, knowledge_base_id, action_kind, cleanup_plane,
        resource_kind, resource_public_id, required, priority,
        sequence_number, idempotency_key, request_hash, checkpoint,
        state, attempt_count, maximum_attempts, not_before,
        created_at, updated_at
      )
      SELECT 'cleanup-publication-retention-' || md5(
               ${input.releaseGenerationPublicId} || chr(31) || object_id
             ),
             ${input.knowledgeBaseId}, 'zero_owner_object',
             'object_storage', 'zero_owner_object', object_id, true, 40,
             row_number() OVER (ORDER BY object_id COLLATE "C")::integer,
             'publication-retention:' || ${input.releaseGenerationPublicId}
               || ':' || object_id,
             md5(object_id),
             jsonb_build_object(
               'schemaVersion', 'publication-generation-retention-v1',
               'releaseGenerationPublicId',
               ${input.releaseGenerationPublicId}::text
             ),
             'queued', 0, 8, ${input.releasedAt}, ${input.releasedAt},
             ${input.releasedAt}
      FROM marked_objects
      WHERE NOT EXISTS (
        SELECT 1 FROM focowiki.cleanup_actions existing
        WHERE existing.action_kind = 'zero_owner_object'
          AND existing.resource_public_id = marked_objects.object_id
          AND existing.state IN ('queued', 'running', 'retry')
      )
      ON CONFLICT ON CONSTRAINT cleanup_actions_idempotency_key DO NOTHING
      RETURNING resource_public_id
    )
    SELECT count(DISTINCT released.object_id) AS released_object_count
    FROM released_objects released
  `;
  return Number(rows[0]?.released_object_count ?? 0);
}
