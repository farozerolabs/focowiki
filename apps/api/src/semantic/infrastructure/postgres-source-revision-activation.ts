import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";

export async function activateSemanticSourceRevision(
  sql: TransactionSql | DatabaseClient,
  input: {
    knowledgeBaseId: string;
    semanticGenerationPublicId: string;
    sourceFilePublicId: string;
    priorSourceRevisionPublicId: string | null;
    currentSourceRevisionPublicId: string;
    activatedAt: string;
  }
): Promise<void> {
  if (input.priorSourceRevisionPublicId === input.currentSourceRevisionPublicId) return;
  const affected = await sql<Array<{
    entity_public_ids: string[];
    relationship_public_ids: string[];
  }>>`
    SELECT coalesce(array_agg(DISTINCT entity_id) FILTER (
             WHERE entity_id IS NOT NULL
           ), '{}'::text[]) AS entity_public_ids,
           coalesce(array_agg(DISTINCT relationship_id) FILTER (
             WHERE relationship_id IS NOT NULL
           ), '{}'::text[]) AS relationship_public_ids
    FROM (
      SELECT observation.entity_public_id AS entity_id,
             NULL::text AS relationship_id
      FROM focowiki.semantic_entity_observations observation
      WHERE observation.knowledge_base_id = ${input.knowledgeBaseId}
        AND observation.semantic_generation_public_id
          = ${input.semanticGenerationPublicId}
        AND observation.source_file_public_id = ${input.sourceFilePublicId}
        AND observation.source_revision_public_id IN (
          ${input.priorSourceRevisionPublicId},
          ${input.currentSourceRevisionPublicId}
        )
      UNION ALL
      SELECT NULL::text, observation.relationship_public_id
      FROM focowiki.semantic_relationship_observations observation
      WHERE observation.knowledge_base_id = ${input.knowledgeBaseId}
        AND observation.semantic_generation_public_id
          = ${input.semanticGenerationPublicId}
        AND observation.source_file_public_id = ${input.sourceFilePublicId}
        AND observation.source_revision_public_id IN (
          ${input.priorSourceRevisionPublicId},
          ${input.currentSourceRevisionPublicId}
        )
    ) impacted
  `;
  const entityPublicIds = affected[0]?.entity_public_ids ?? [];
  const relationshipPublicIds = affected[0]?.relationship_public_ids ?? [];

  await sql`
    UPDATE focowiki.semantic_vector_documents
    SET state = CASE
          WHEN source_revision_public_id = ${input.currentSourceRevisionPublicId}
            THEN 'active'
          ELSE 'deleted'
        END,
        deleted_at = CASE
          WHEN source_revision_public_id = ${input.currentSourceRevisionPublicId}
            THEN NULL::timestamp with time zone
          ELSE ${input.activatedAt}::timestamp with time zone
        END
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.semanticGenerationPublicId}
      AND source_file_public_id = ${input.sourceFilePublicId}
      AND source_revision_public_id IN (
        ${input.priorSourceRevisionPublicId},
        ${input.currentSourceRevisionPublicId}
      )
  `;
  await sql`
    UPDATE focowiki.embedding_artifact_owners owner
    SET retention_kind = 'active'
    FROM focowiki.embedding_artifacts artifact
    WHERE owner.knowledge_base_id = ${input.knowledgeBaseId}
      AND owner.semantic_generation_public_id
        = ${input.semanticGenerationPublicId}
      AND owner.artifact_public_id = artifact.public_id
      AND artifact.source_revision_public_id
        = ${input.currentSourceRevisionPublicId}
  `;
  await sql`
    DELETE FROM focowiki.semantic_embedding_artifact_refs reference
    USING focowiki.embedding_artifacts artifact
    WHERE reference.knowledge_base_id = ${input.knowledgeBaseId}
      AND reference.semantic_generation_public_id
        = ${input.semanticGenerationPublicId}
      AND reference.source_file_public_id = ${input.sourceFilePublicId}
      AND artifact.public_id = reference.artifact_public_id
      AND artifact.source_revision_public_id = ${input.priorSourceRevisionPublicId}
  `;
  await sql`
    DELETE FROM focowiki.embedding_artifact_owners owner
    USING focowiki.embedding_artifacts artifact
    WHERE owner.knowledge_base_id = ${input.knowledgeBaseId}
      AND owner.semantic_generation_public_id
        = ${input.semanticGenerationPublicId}
      AND owner.artifact_public_id = artifact.public_id
      AND artifact.source_revision_public_id = ${input.priorSourceRevisionPublicId}
  `;
  await sql`
    DELETE FROM focowiki.semantic_source_reconciliations
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.semanticGenerationPublicId}
      AND source_file_public_id = ${input.sourceFilePublicId}
      AND source_revision_public_id = ${input.priorSourceRevisionPublicId}
  `;
  await sql`
    DELETE FROM focowiki.semantic_relationship_observations
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.semanticGenerationPublicId}
      AND source_file_public_id = ${input.sourceFilePublicId}
      AND source_revision_public_id = ${input.priorSourceRevisionPublicId}
  `;
  await sql`
    DELETE FROM focowiki.semantic_entity_observations
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.semanticGenerationPublicId}
      AND source_file_public_id = ${input.sourceFilePublicId}
      AND source_revision_public_id = ${input.priorSourceRevisionPublicId}
  `;
  await sql`
    DELETE FROM focowiki.semantic_evidence
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.semanticGenerationPublicId}
      AND source_file_public_id = ${input.sourceFilePublicId}
      AND source_revision_public_id = ${input.priorSourceRevisionPublicId}
  `;

  await rebuildEntityPresentation(sql, input, entityPublicIds);
  await rebuildRelationshipPresentation(sql, input, relationshipPublicIds);
  await sql`
    DELETE FROM focowiki.semantic_relationships relationship
    WHERE relationship.knowledge_base_id = ${input.knowledgeBaseId}
      AND relationship.semantic_generation_public_id
        = ${input.semanticGenerationPublicId}
      AND NOT EXISTS (
        SELECT 1
        FROM focowiki.semantic_relationship_observations observation
        WHERE observation.semantic_generation_public_id
          = relationship.semantic_generation_public_id
          AND observation.relationship_public_id = relationship.public_id
      )
  `;
  await sql`
    DELETE FROM focowiki.semantic_entities entity
    WHERE entity.knowledge_base_id = ${input.knowledgeBaseId}
      AND entity.semantic_generation_public_id = ${input.semanticGenerationPublicId}
      AND NOT EXISTS (
        SELECT 1
        FROM focowiki.semantic_entity_observations observation
        WHERE observation.semantic_generation_public_id
          = entity.semantic_generation_public_id
          AND observation.entity_public_id = entity.public_id
      )
  `;
  await sql`
    UPDATE focowiki.embedding_artifacts artifact
    SET state = 'orphaned', deleted_at = NULL
    WHERE artifact.knowledge_base_id = ${input.knowledgeBaseId}
      AND artifact.source_revision_public_id = ${input.priorSourceRevisionPublicId}
      AND artifact.state IN ('registered', 'verified', 'failed')
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
  `;
}

async function rebuildEntityPresentation(
  sql: TransactionSql | DatabaseClient,
  input: {
    knowledgeBaseId: string;
    semanticGenerationPublicId: string;
  },
  entityPublicIds: readonly string[]
): Promise<void> {
  if (entityPublicIds.length === 0) return;
  await sql`
    WITH aggregate AS (
      SELECT observation.entity_public_id,
             (array_agg(observation.label ORDER BY observation.label COLLATE "C"))[1]
               AS label,
             (array_agg(observation.description ORDER BY observation.description COLLATE "C")
               FILTER (WHERE observation.description IS NOT NULL))[1] AS description,
             (array_agg(observation.extraction_contract_version ORDER BY
               observation.extraction_contract_version COLLATE "C"))[1]
               AS extraction_contract_version,
             max(observation.confidence) AS confidence,
             CASE WHEN bool_or(observation.provenance_kind = 'model')
               THEN 'model' ELSE 'deterministic' END AS provenance_kind
      FROM focowiki.semantic_entity_observations observation
      JOIN focowiki.source_file_active_revisions current_revision
        ON current_revision.knowledge_base_id = observation.knowledge_base_id
       AND current_revision.source_file_public_id = observation.source_file_public_id
       AND current_revision.active_source_revision_public_id
         = observation.source_revision_public_id
      WHERE observation.knowledge_base_id = ${input.knowledgeBaseId}
        AND observation.semantic_generation_public_id
          = ${input.semanticGenerationPublicId}
        AND observation.entity_public_id = ANY(${entityPublicIds})
      GROUP BY observation.entity_public_id
    )
    UPDATE focowiki.semantic_entities entity
    SET label = aggregate.label, description = aggregate.description,
        extraction_contract_version = aggregate.extraction_contract_version,
        confidence = aggregate.confidence,
        provenance_kind = aggregate.provenance_kind,
        revision = entity.revision + 1, deleted_at = NULL
    FROM aggregate
    WHERE entity.knowledge_base_id = ${input.knowledgeBaseId}
      AND entity.semantic_generation_public_id = ${input.semanticGenerationPublicId}
      AND entity.public_id = aggregate.entity_public_id
  `;
  await sql`
    DELETE FROM focowiki.semantic_entity_aliases
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.semanticGenerationPublicId}
      AND entity_public_id = ANY(${entityPublicIds})
  `;
  await sql`
    WITH ranked_aliases AS (
      SELECT observation.entity_public_id,
             alias."normalizedAlias" AS normalized_alias,
             min(alias."displayAlias" COLLATE "C") AS display_alias,
             row_number() OVER (
               PARTITION BY observation.entity_public_id
               ORDER BY alias."normalizedAlias" COLLATE "C"
             ) AS alias_rank
      FROM focowiki.semantic_entity_observations observation
      JOIN focowiki.source_file_active_revisions current_revision
        ON current_revision.knowledge_base_id = observation.knowledge_base_id
       AND current_revision.source_file_public_id = observation.source_file_public_id
       AND current_revision.active_source_revision_public_id
         = observation.source_revision_public_id
      CROSS JOIN LATERAL jsonb_to_recordset(observation.aliases) AS alias(
        "normalizedAlias" text, "displayAlias" text
      )
      WHERE observation.knowledge_base_id = ${input.knowledgeBaseId}
        AND observation.semantic_generation_public_id
          = ${input.semanticGenerationPublicId}
        AND observation.entity_public_id = ANY(${entityPublicIds})
      GROUP BY observation.entity_public_id, alias."normalizedAlias"
    )
    INSERT INTO focowiki.semantic_entity_aliases (
      knowledge_base_id, semantic_generation_public_id, entity_public_id,
      normalized_alias, display_alias
    )
    SELECT ${input.knowledgeBaseId}, ${input.semanticGenerationPublicId},
           entity_public_id, normalized_alias, display_alias
    FROM ranked_aliases
    WHERE alias_rank <= 128
    ON CONFLICT DO NOTHING
  `;
}

async function rebuildRelationshipPresentation(
  sql: TransactionSql | DatabaseClient,
  input: {
    knowledgeBaseId: string;
    semanticGenerationPublicId: string;
  },
  relationshipPublicIds: readonly string[]
): Promise<void> {
  if (relationshipPublicIds.length === 0) return;
  await sql`
    WITH aggregate AS (
      SELECT observation.relationship_public_id,
             (array_agg(observation.description ORDER BY
               observation.description COLLATE "C") FILTER (
                 WHERE observation.description IS NOT NULL
               ))[1] AS description,
             max(observation.confidence) AS confidence,
             CASE WHEN bool_or(observation.provenance_kind = 'model')
               THEN 'model' ELSE 'deterministic' END AS provenance_kind
      FROM focowiki.semantic_relationship_observations observation
      JOIN focowiki.source_file_active_revisions current_revision
        ON current_revision.knowledge_base_id = observation.knowledge_base_id
       AND current_revision.source_file_public_id = observation.source_file_public_id
       AND current_revision.active_source_revision_public_id
         = observation.source_revision_public_id
      WHERE observation.knowledge_base_id = ${input.knowledgeBaseId}
        AND observation.semantic_generation_public_id
          = ${input.semanticGenerationPublicId}
        AND observation.relationship_public_id = ANY(${relationshipPublicIds})
      GROUP BY observation.relationship_public_id
    )
    UPDATE focowiki.semantic_relationships relationship
    SET description = aggregate.description,
        confidence = aggregate.confidence,
        provenance_kind = aggregate.provenance_kind,
        revision = relationship.revision + 1, deleted_at = NULL
    FROM aggregate
    WHERE relationship.knowledge_base_id = ${input.knowledgeBaseId}
      AND relationship.semantic_generation_public_id
        = ${input.semanticGenerationPublicId}
      AND relationship.public_id = aggregate.relationship_public_id
  `;
}
