import type { DatabaseClient } from "../../db/client.js";
import type { SearchProviderVectorFamily } from
  "../../application/ports/search-provider-runtime.js";

type ActiveVectorHit = {
  documentId: string;
  ownerPublicId: string;
  family: SearchProviderVectorFamily;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  evidenceTargetPath: string;
};

export function createPostgresActiveVectorHitRepository(sql: DatabaseClient) {
  return {
    async resolveActive(input: {
      knowledgeBaseId: string;
      semanticGenerationPublicId: string;
      documents: readonly ActiveVectorHit[];
      limit: number;
    }): Promise<readonly string[]> {
      assertInput(input);
      if (input.documents.length === 0) return [];
      const rows = await sql<Array<{ public_id: string }>>`
        WITH requested AS (
          SELECT item."documentId", item."ownerPublicId", item.family,
                 item."sourceFilePublicId", item."sourceRevisionPublicId",
                 item."evidenceTargetPath"
          FROM jsonb_to_recordset(${sql.json(input.documents as never)}) AS item(
            "documentId" text, "ownerPublicId" text, family text,
            "sourceFilePublicId" text, "sourceRevisionPublicId" text,
            "evidenceTargetPath" text
          )
        )
        SELECT vector.public_id
        FROM requested
        JOIN focowiki.semantic_vector_documents vector
          ON vector.public_id = requested."documentId"
         AND vector.owner_public_id = requested."ownerPublicId"
         AND vector.vector_family = requested.family
         AND vector.source_file_public_id = requested."sourceFilePublicId"
         AND vector.source_revision_public_id
           = requested."sourceRevisionPublicId"
         AND vector.evidence_target_path = requested."evidenceTargetPath"
         AND vector.state = 'active'
         AND vector.deleted_at IS NULL
        JOIN focowiki.semantic_generations generation
          ON generation.knowledge_base_id = vector.knowledge_base_id
         AND generation.public_id = vector.semantic_generation_public_id
         AND generation.generation_role = 'active'
         AND generation.state = 'active'
         AND generation.deleted_at IS NULL
        JOIN focowiki.knowledge_bases knowledge_base
          ON knowledge_base.public_id = generation.knowledge_base_id
         AND knowledge_base.deleted_at IS NULL
        JOIN focowiki.source_files source
          ON source.knowledge_base_id = vector.knowledge_base_id
         AND source.public_id = vector.source_file_public_id
         AND source.deleted_at IS NULL
        JOIN focowiki.source_file_active_revisions current_revision
          ON current_revision.knowledge_base_id = source.knowledge_base_id
         AND current_revision.source_file_public_id = source.public_id
         AND current_revision.active_source_revision_public_id
           = vector.source_revision_public_id
        JOIN focowiki.source_revision_presentations presentation
          ON presentation.knowledge_base_id = current_revision.knowledge_base_id
         AND presentation.source_file_public_id
           = current_revision.source_file_public_id
         AND presentation.source_revision_public_id
           = current_revision.active_source_revision_public_id
         AND presentation.logical_path = vector.evidence_target_path
        WHERE vector.knowledge_base_id = ${input.knowledgeBaseId}
          AND vector.semantic_generation_public_id
            = ${input.semanticGenerationPublicId}
          AND CASE vector.vector_family
            WHEN 'content' THEN true
            WHEN 'entity' THEN EXISTS (
              SELECT 1
              FROM focowiki.semantic_entities entity
              JOIN focowiki.semantic_entity_observations observation
                ON observation.knowledge_base_id = entity.knowledge_base_id
               AND observation.semantic_generation_public_id
                 = entity.semantic_generation_public_id
               AND observation.entity_public_id = entity.public_id
              JOIN focowiki.source_files evidence_source
                ON evidence_source.knowledge_base_id = observation.knowledge_base_id
               AND evidence_source.public_id = observation.source_file_public_id
               AND evidence_source.deleted_at IS NULL
              JOIN focowiki.source_file_active_revisions evidence_revision
                ON evidence_revision.knowledge_base_id
                  = observation.knowledge_base_id
               AND evidence_revision.source_file_public_id
                  = observation.source_file_public_id
               AND evidence_revision.active_source_revision_public_id
                  = observation.source_revision_public_id
              WHERE entity.knowledge_base_id = vector.knowledge_base_id
                AND entity.semantic_generation_public_id
                  = vector.semantic_generation_public_id
                AND entity.public_id = vector.owner_public_id
                AND entity.deleted_at IS NULL
            )
            WHEN 'relationship' THEN EXISTS (
              SELECT 1
              FROM focowiki.semantic_relationships relationship
              JOIN focowiki.semantic_relationship_observations observation
                ON observation.knowledge_base_id = relationship.knowledge_base_id
               AND observation.semantic_generation_public_id
                 = relationship.semantic_generation_public_id
               AND observation.relationship_public_id = relationship.public_id
              JOIN focowiki.source_files evidence_source
                ON evidence_source.knowledge_base_id = observation.knowledge_base_id
               AND evidence_source.public_id = observation.source_file_public_id
               AND evidence_source.deleted_at IS NULL
              JOIN focowiki.source_file_active_revisions evidence_revision
                ON evidence_revision.knowledge_base_id
                  = observation.knowledge_base_id
               AND evidence_revision.source_file_public_id
                  = observation.source_file_public_id
               AND evidence_revision.active_source_revision_public_id
                  = observation.source_revision_public_id
              WHERE relationship.knowledge_base_id = vector.knowledge_base_id
                AND relationship.semantic_generation_public_id
                  = vector.semantic_generation_public_id
                AND relationship.public_id = vector.owner_public_id
                AND relationship.deleted_at IS NULL
            )
            WHEN 'community' THEN EXISTS (
              SELECT 1
              FROM focowiki.semantic_communities community
              WHERE community.knowledge_base_id = vector.knowledge_base_id
                AND community.semantic_generation_public_id
                  = vector.semantic_generation_public_id
                AND community.public_id = vector.owner_public_id
                AND community.deleted_at IS NULL
                AND NOT EXISTS (
                  SELECT 1
                  FROM focowiki.semantic_dirty_partitions partition
                  WHERE partition.knowledge_base_id = community.knowledge_base_id
                    AND partition.semantic_generation_public_id
                      = community.semantic_generation_public_id
                    AND partition.partition_key = community.source_partition_key
                    AND partition.state <> 'completed'
                )
            )
            ELSE false
          END
        ORDER BY vector.public_id COLLATE "C"
        LIMIT ${input.limit + 1}
      `;
      if (rows.length > input.limit) throw repositoryError("active_hit_limit");
      return rows.map((row) => row.public_id);
    }
  };
}

function assertInput(input: {
  knowledgeBaseId: string;
  semanticGenerationPublicId: string;
  documents: readonly ActiveVectorHit[];
  limit: number;
}): void {
  if (!input.knowledgeBaseId || !input.semanticGenerationPublicId
    || !Number.isSafeInteger(input.limit) || input.limit < 0 || input.limit > 4_000
    || input.documents.length > input.limit
    || new Set(input.documents.map((item) => item.documentId)).size
      !== input.documents.length
    || input.documents.some((item) => !item.documentId || !item.ownerPublicId
      || !item.sourceFilePublicId || !item.sourceRevisionPublicId
      || !item.evidenceTargetPath
      || !["content", "entity", "relationship", "community"].includes(item.family))) {
    throw repositoryError("invalid_active_hit_input");
  }
}

function repositoryError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Active vector hit repository error: ${code}`), {
    code
  });
}
