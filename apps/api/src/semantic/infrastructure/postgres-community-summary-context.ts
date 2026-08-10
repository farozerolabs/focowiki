import type { DatabaseClient } from "../../db/client.js";
import type { SemanticCommunitySummaryContextPort } from
  "../application/community-summary-context.js";

export function createPostgresSemanticCommunitySummaryContext(
  sql: DatabaseClient
): SemanticCommunitySummaryContextPort {
  return {
    async load(input) {
      assertLimit(input.entityPublicIds.length, input.maximumEntities, 100);
      assertLimit(input.maximumRelationships, input.maximumRelationships, 1_000);
      const entityIds = [...new Set(input.entityPublicIds)].sort();
      const entities = await sql<Array<{
        public_id: string;
        label: string;
        entity_kind: string;
        description: string | null;
      }>>`
        SELECT entity.public_id, entity.label, entity.entity_kind,
               entity.description
        FROM focowiki.semantic_entities entity
        JOIN focowiki.semantic_generations generation
          ON generation.knowledge_base_id = entity.knowledge_base_id
         AND generation.public_id = entity.semantic_generation_public_id
         AND generation.deleted_at IS NULL
        WHERE entity.knowledge_base_id = ${input.knowledgeBaseId}
          AND entity.semantic_generation_public_id
            = ${input.semanticGenerationPublicId}
          AND entity.public_id = ANY(${entityIds})
          AND entity.deleted_at IS NULL
          AND (
            generation.generation_role = 'candidate'
              AND generation.state IN ('building', 'validating')
            OR generation.generation_role = 'active'
              AND generation.state = 'active'
          )
        ORDER BY entity.public_id COLLATE "C"
        LIMIT ${input.maximumEntities + 1}
      `;
      if (entities.length !== entityIds.length
        || entities.length > input.maximumEntities) {
        throw contextError("semantic_community_entity_scope_invalid");
      }
      const relationships = entityIds.length === 0 ? [] : await sql<Array<{
        public_id: string;
        from_entity_public_id: string;
        to_entity_public_id: string;
        relationship_kind: string;
        description: string | null;
      }>>`
        SELECT relationship.public_id, relationship.from_entity_public_id,
               relationship.to_entity_public_id,
               relationship.relationship_kind, relationship.description
        FROM focowiki.semantic_relationships relationship
        WHERE relationship.knowledge_base_id = ${input.knowledgeBaseId}
          AND relationship.semantic_generation_public_id
            = ${input.semanticGenerationPublicId}
          AND relationship.from_entity_public_id = ANY(${entityIds})
          AND relationship.to_entity_public_id = ANY(${entityIds})
          AND relationship.deleted_at IS NULL
        ORDER BY relationship.public_id COLLATE "C"
        LIMIT ${input.maximumRelationships + 1}
      `;
      if (relationships.length > input.maximumRelationships) {
        throw contextError("semantic_community_relationship_limit");
      }
      return {
        entities: entities.map((entity) => ({
          publicId: entity.public_id,
          label: entity.label,
          kind: entity.entity_kind,
          description: entity.description
        })),
        relationships: relationships.map((relationship) => ({
          publicId: relationship.public_id,
          sourceEntityPublicId: relationship.from_entity_public_id,
          targetEntityPublicId: relationship.to_entity_public_id,
          kind: relationship.relationship_kind,
          description: relationship.description
        }))
      };
    }
  };
}

function assertLimit(value: number, maximum: number, hardMaximum: number): void {
  if (!Number.isSafeInteger(value) || value < 0
    || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > hardMaximum
    || value > maximum) {
    throw contextError("semantic_community_context_bound_invalid");
  }
}

function contextError(code: string): Error & { code: string; retryable: false } {
  return Object.assign(new Error(`Semantic community context failed: ${code}`), {
    code,
    retryable: false as const
  });
}
