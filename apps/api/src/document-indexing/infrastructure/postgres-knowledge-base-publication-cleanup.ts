import type { TransactionSql } from "postgres";

export async function prepareKnowledgeBasePublicationObjectCleanup(input: {
  sql: TransactionSql;
  knowledgeBaseId: string;
  operationPublicId: string;
  queuedAt: string;
}): Promise<void> {
  await input.sql`
    WITH candidate_objects AS (
      SELECT head.object_id
      FROM focowiki.generated_page_heads head
      WHERE head.knowledge_base_id = ${input.knowledgeBaseId}
      UNION
      SELECT base.object_id
      FROM focowiki.generated_page_bases base
      WHERE base.knowledge_base_id = ${input.knowledgeBaseId}
      UNION
      SELECT reference.object_id
      FROM focowiki.projection_scope_generation_object_refs reference
      JOIN focowiki.projection_scope_generations scope
        ON scope.public_id = reference.scope_generation_public_id
      WHERE scope.knowledge_base_id = ${input.knowledgeBaseId}
      UNION
      SELECT page.object_id
      FROM focowiki.projection_scope_generation_pages page
      JOIN focowiki.projection_scope_generations scope
        ON scope.public_id = page.scope_generation_public_id
      WHERE scope.knowledge_base_id = ${input.knowledgeBaseId}
        AND page.action = 'put' AND page.object_id IS NOT NULL
    )
    INSERT INTO focowiki.cleanup_actions (
      public_id, knowledge_base_id,
      action_kind, cleanup_plane, resource_kind, resource_public_id,
      required, priority, sequence_number, idempotency_key, request_hash,
      checkpoint, state, attempt_count, maximum_attempts, not_before,
      created_at, updated_at
    )
    SELECT 'cleanup-knowledge-base-publication-' || md5(
             ${input.operationPublicId} || chr(31) || candidate.object_id
           ), ${input.knowledgeBaseId},
           'zero_owner_object', 'object_storage', 'zero_owner_object',
           candidate.object_id, true, 30,
           row_number() OVER (ORDER BY candidate.object_id COLLATE "C")::integer,
           'knowledge-base-publication:' || ${input.operationPublicId}
             || ':' || candidate.object_id,
           md5(candidate.object_id),
           jsonb_build_object(
             'schemaVersion', 'knowledge-base-publication-cleanup-v1',
             'operationPublicId', ${input.operationPublicId}::text
           ),
           'queued', 0, 8, ${input.queuedAt}, ${input.queuedAt},
           ${input.queuedAt}
    FROM candidate_objects candidate
    JOIN focowiki.object_registrations registration
      ON registration.object_id = candidate.object_id
     AND registration.state = 'verified'
    ON CONFLICT ON CONSTRAINT cleanup_actions_idempotency_key DO NOTHING
  `;
  await input.sql`
    DELETE FROM focowiki.generated_page_heads
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
  `;
}

export async function finalizeKnowledgeBasePublicationObjectCleanup(input: {
  sql: TransactionSql;
  knowledgeBaseId: string;
  operationPublicId: string;
  releasedAt: string;
}): Promise<void> {
  await input.sql`
    UPDATE focowiki.object_registrations registration
    SET zero_owner_since = coalesce(
          registration.zero_owner_since, ${input.releasedAt}
        )
    FROM focowiki.cleanup_actions action
    WHERE action.knowledge_base_id = ${input.knowledgeBaseId}
      AND action.action_kind = 'zero_owner_object'
      AND action.checkpoint ->> 'schemaVersion'
            = 'knowledge-base-publication-cleanup-v1'
      AND action.checkpoint ->> 'operationPublicId'
            = ${input.operationPublicId}
      AND action.resource_public_id = registration.object_id
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
  `;
  await input.sql`
    DELETE FROM focowiki.cleanup_actions action
    WHERE action.knowledge_base_id = ${input.knowledgeBaseId}
      AND action.action_kind = 'zero_owner_object'
      AND action.checkpoint ->> 'schemaVersion'
            = 'knowledge-base-publication-cleanup-v1'
      AND action.checkpoint ->> 'operationPublicId'
            = ${input.operationPublicId}
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.object_registrations registration
        WHERE registration.object_id = action.resource_public_id
          AND registration.state = 'verified'
          AND registration.zero_owner_since IS NOT NULL
      )
  `;
}
