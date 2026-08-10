import type { DatabaseClient } from "../../db/client.js";
import type { SemanticEmbeddingEvidenceTarget } from "./input-builder.js";

export type SemanticSourceEntityEmbeddingInput = {
  ownerPublicId: string;
  label: string;
  kind: string;
  description: string | null;
  evidenceTargets: readonly SemanticEmbeddingEvidenceTarget[];
};

export type SemanticSourceRelationshipEmbeddingInput = {
  ownerPublicId: string;
  sourceLabel: string;
  targetLabel: string;
  description: string;
  evidenceTargets: readonly SemanticEmbeddingEvidenceTarget[];
};

export type SemanticSourceCommunityEmbeddingInput = {
  ownerPublicId: string;
  summary: string;
  evidenceTargets: readonly SemanticEmbeddingEvidenceTarget[];
};

export type SemanticSourceEmbeddingInputRepositoryPort = {
  listSourceInputs(input: {
    knowledgeBaseId: string;
    semanticGenerationPublicId: string;
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
    maximumEntities: number;
    maximumRelationships: number;
    maximumEvidenceTargets: number;
  }): Promise<{
    entities: readonly SemanticSourceEntityEmbeddingInput[];
    relationships: readonly SemanticSourceRelationshipEmbeddingInput[];
    communities: readonly SemanticSourceCommunityEmbeddingInput[];
  }>;
};

type EntityRow = {
  public_id: string;
  label: string;
  entity_kind: string;
  description: string | null;
};

type RelationshipRow = {
  public_id: string;
  source_label: string;
  target_label: string;
  description: string | null;
};

type CommunityRow = {
  public_id: string;
  summary: string;
};

type EvidenceRow = {
  owner_public_id: string;
  source_file_public_id: string;
  source_revision_public_id: string;
  evidence_public_id: string;
  logical_path: string;
};

export function createPostgresSemanticSourceEmbeddingInputRepository(
  sql: DatabaseClient
): SemanticSourceEmbeddingInputRepositoryPort {
  return {
    async listSourceInputs(input) {
      assertLimit(input.maximumEntities, 2_000);
      assertLimit(input.maximumRelationships, 4_000);
      assertLimit(input.maximumEvidenceTargets, 64);
      const entities = await sql<EntityRow[]>`
        SELECT entity.public_id, entity.label, entity.entity_kind,
               entity.description
        FROM focowiki.semantic_entity_observations observation
        JOIN focowiki.semantic_entities entity
          ON entity.knowledge_base_id = observation.knowledge_base_id
         AND entity.semantic_generation_public_id
           = observation.semantic_generation_public_id
         AND entity.public_id = observation.entity_public_id
         AND entity.deleted_at IS NULL
        WHERE observation.knowledge_base_id = ${input.knowledgeBaseId}
          AND observation.semantic_generation_public_id
            = ${input.semanticGenerationPublicId}
          AND observation.source_file_public_id = ${input.sourceFilePublicId}
          AND observation.source_revision_public_id
            = ${input.sourceRevisionPublicId}
        ORDER BY entity.public_id COLLATE "C"
        LIMIT ${input.maximumEntities + 1}
      `;
      const relationships = await sql<RelationshipRow[]>`
        SELECT relationship.public_id,
               source_entity.label AS source_label,
               target_entity.label AS target_label,
               relationship.description
        FROM focowiki.semantic_relationship_observations observation
        JOIN focowiki.semantic_relationships relationship
          ON relationship.knowledge_base_id = observation.knowledge_base_id
         AND relationship.semantic_generation_public_id
           = observation.semantic_generation_public_id
         AND relationship.public_id = observation.relationship_public_id
         AND relationship.deleted_at IS NULL
        JOIN focowiki.semantic_entities source_entity
          ON source_entity.semantic_generation_public_id
            = relationship.semantic_generation_public_id
         AND source_entity.public_id = relationship.from_entity_public_id
         AND source_entity.deleted_at IS NULL
        JOIN focowiki.semantic_entities target_entity
          ON target_entity.semantic_generation_public_id
            = relationship.semantic_generation_public_id
         AND target_entity.public_id = relationship.to_entity_public_id
         AND target_entity.deleted_at IS NULL
        WHERE observation.knowledge_base_id = ${input.knowledgeBaseId}
          AND observation.semantic_generation_public_id
            = ${input.semanticGenerationPublicId}
          AND observation.source_file_public_id = ${input.sourceFilePublicId}
          AND observation.source_revision_public_id
            = ${input.sourceRevisionPublicId}
        ORDER BY relationship.public_id COLLATE "C"
        LIMIT ${input.maximumRelationships + 1}
      `;
      const communities = await sql<CommunityRow[]>`
        SELECT DISTINCT community.public_id COLLATE "C" AS public_id, report.summary
        FROM focowiki.semantic_community_memberships membership
        JOIN focowiki.semantic_communities community
          ON community.knowledge_base_id = membership.knowledge_base_id
         AND community.semantic_generation_public_id
           = membership.semantic_generation_public_id
         AND community.public_id = membership.community_public_id
         AND community.deleted_at IS NULL
        JOIN focowiki.semantic_community_reports report
          ON report.knowledge_base_id = community.knowledge_base_id
         AND report.semantic_generation_public_id
           = community.semantic_generation_public_id
         AND report.community_public_id = community.public_id
        JOIN focowiki.semantic_entity_observations observation
          ON observation.knowledge_base_id = membership.knowledge_base_id
         AND observation.semantic_generation_public_id
           = membership.semantic_generation_public_id
         AND observation.entity_public_id = membership.entity_public_id
        WHERE membership.knowledge_base_id = ${input.knowledgeBaseId}
          AND membership.semantic_generation_public_id
            = ${input.semanticGenerationPublicId}
          AND observation.source_file_public_id = ${input.sourceFilePublicId}
          AND observation.source_revision_public_id
            = ${input.sourceRevisionPublicId}
        ORDER BY public_id
        LIMIT ${input.maximumEntities + 1}
      `;
      if (entities.length > input.maximumEntities
        || relationships.length > input.maximumRelationships
        || communities.length > input.maximumEntities) {
        throw sourceInputError("semantic_source_fact_limit");
      }
      const [entityEvidence, relationshipEvidence, communityEvidence] = await Promise.all([
        listEntityEvidence(sql, input),
        listRelationshipEvidence(sql, input),
        listCommunityEvidence(sql, input)
      ]);
      return {
        entities: entities.map((entity) => ({
          ownerPublicId: entity.public_id,
          label: entity.label,
          kind: entity.entity_kind,
          description: entity.description,
          evidenceTargets: boundedTargets(
            entityEvidence,
            entity.public_id,
            input.maximumEvidenceTargets
          )
        })),
        relationships: relationships.map((relationship) => ({
          ownerPublicId: relationship.public_id,
          sourceLabel: relationship.source_label,
          targetLabel: relationship.target_label,
          description: relationship.description
            ?? `${relationship.source_label} is related to ${relationship.target_label}`,
          evidenceTargets: boundedTargets(
            relationshipEvidence,
            relationship.public_id,
            input.maximumEvidenceTargets
          )
        })),
        communities: communities.map((community) => ({
          ownerPublicId: community.public_id,
          summary: community.summary,
          evidenceTargets: boundedTargets(
            communityEvidence,
            community.public_id,
            input.maximumEvidenceTargets
          )
        }))
      };
    }
  };
}

async function listEntityEvidence(
  sql: DatabaseClient,
  input: Parameters<SemanticSourceEmbeddingInputRepositoryPort["listSourceInputs"]>[0]
) {
  return sql<EvidenceRow[]>`
    SELECT mention.entity_public_id AS owner_public_id,
           evidence.source_file_public_id, evidence.source_revision_public_id,
           evidence.public_id AS evidence_public_id, evidence.logical_path
    FROM focowiki.semantic_mentions mention
    JOIN focowiki.semantic_evidence evidence
      ON evidence.knowledge_base_id = mention.knowledge_base_id
     AND evidence.semantic_generation_public_id
       = mention.semantic_generation_public_id
     AND evidence.public_id = mention.evidence_public_id
    WHERE mention.knowledge_base_id = ${input.knowledgeBaseId}
      AND mention.semantic_generation_public_id
        = ${input.semanticGenerationPublicId}
      AND mention.source_file_public_id = ${input.sourceFilePublicId}
      AND mention.source_revision_public_id = ${input.sourceRevisionPublicId}
    ORDER BY mention.entity_public_id COLLATE "C", evidence.public_id COLLATE "C"
  `;
}

async function listRelationshipEvidence(
  sql: DatabaseClient,
  input: Parameters<SemanticSourceEmbeddingInputRepositoryPort["listSourceInputs"]>[0]
) {
  return sql<EvidenceRow[]>`
    SELECT relationship_evidence.relationship_public_id AS owner_public_id,
           evidence.source_file_public_id, evidence.source_revision_public_id,
           evidence.public_id AS evidence_public_id, evidence.logical_path
    FROM focowiki.semantic_relationship_observations observation
    JOIN focowiki.semantic_relationship_evidence relationship_evidence
      ON relationship_evidence.knowledge_base_id = observation.knowledge_base_id
     AND relationship_evidence.semantic_generation_public_id
       = observation.semantic_generation_public_id
     AND relationship_evidence.relationship_public_id
       = observation.relationship_public_id
    JOIN focowiki.semantic_evidence evidence
      ON evidence.knowledge_base_id = relationship_evidence.knowledge_base_id
     AND evidence.semantic_generation_public_id
       = relationship_evidence.semantic_generation_public_id
     AND evidence.public_id = relationship_evidence.evidence_public_id
     AND evidence.source_file_public_id = ${input.sourceFilePublicId}
     AND evidence.source_revision_public_id = ${input.sourceRevisionPublicId}
    WHERE observation.knowledge_base_id = ${input.knowledgeBaseId}
      AND observation.semantic_generation_public_id
        = ${input.semanticGenerationPublicId}
      AND observation.source_file_public_id = ${input.sourceFilePublicId}
      AND observation.source_revision_public_id = ${input.sourceRevisionPublicId}
    ORDER BY relationship_evidence.relationship_public_id COLLATE "C",
             evidence.public_id COLLATE "C"
  `;
}

async function listCommunityEvidence(
  sql: DatabaseClient,
  input: Parameters<SemanticSourceEmbeddingInputRepositoryPort["listSourceInputs"]>[0]
) {
  return sql<EvidenceRow[]>`
    SELECT DISTINCT membership.community_public_id COLLATE "C" AS owner_public_id,
           evidence.source_file_public_id, evidence.source_revision_public_id,
           evidence.public_id COLLATE "C" AS evidence_public_id,
           evidence.logical_path
    FROM focowiki.semantic_community_memberships membership
    JOIN focowiki.semantic_mentions mention
      ON mention.knowledge_base_id = membership.knowledge_base_id
     AND mention.semantic_generation_public_id
       = membership.semantic_generation_public_id
     AND mention.entity_public_id = membership.entity_public_id
    JOIN focowiki.semantic_evidence evidence
      ON evidence.knowledge_base_id = mention.knowledge_base_id
     AND evidence.semantic_generation_public_id
       = mention.semantic_generation_public_id
     AND evidence.public_id = mention.evidence_public_id
    WHERE membership.knowledge_base_id = ${input.knowledgeBaseId}
      AND membership.semantic_generation_public_id
        = ${input.semanticGenerationPublicId}
      AND evidence.source_file_public_id = ${input.sourceFilePublicId}
      AND evidence.source_revision_public_id = ${input.sourceRevisionPublicId}
    ORDER BY owner_public_id, evidence_public_id
  `;
}

function boundedTargets(
  rows: readonly EvidenceRow[],
  ownerPublicId: string,
  maximum: number
): SemanticEmbeddingEvidenceTarget[] {
  const targets = rows.filter((row) => row.owner_public_id === ownerPublicId);
  if (targets.length === 0 || targets.length > maximum) {
    throw sourceInputError("semantic_evidence_target_limit");
  }
  return targets.map((row) => ({
    sourceFilePublicId: row.source_file_public_id,
    sourceRevisionPublicId: row.source_revision_public_id,
    evidencePublicId: row.evidence_public_id,
    logicalPath: row.logical_path
  }));
}

function assertLimit(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw sourceInputError("semantic_source_input_bound_invalid");
  }
}

function sourceInputError(code: string): Error & { code: string; retryable: false } {
  return Object.assign(new Error(`Semantic source embedding input failed: ${code}`), {
    code,
    retryable: false as const
  });
}
