import type { DatabaseClient } from "../../db/client.js";
import type {
  SemanticFileRelationshipCandidate,
  SemanticFileRelationshipEvidence,
  SemanticFileRelationshipReadPort
} from "../presentation/file-graph-evidence.js";

type CandidateRow = {
  semantic_generation_public_id: string;
  relationship_public_id: string;
  target_source_file_public_id: string;
  target_source_revision_public_id: string;
  from_entity_label: string;
  to_entity_label: string;
  relationship_kind: string;
  description: string | null;
  confidence: number | string;
};

type EvidenceRow = {
  relationship_public_id: string;
  source_file_public_id: string;
  source_revision_public_id: string;
  logical_path: string;
  start_offset: number | string;
  end_offset: number | string;
  excerpt_checksum_sha256: string;
};

export class SemanticFileGraphEvidenceRepositoryError extends Error {
  public constructor(public readonly code: "invalid_input") {
    super(`Semantic file graph evidence repository error: ${code}`);
    this.name = "SemanticFileGraphEvidenceRepositoryError";
  }
}

export function createPostgresSemanticFileGraphEvidenceRepository(
  sql: DatabaseClient
): SemanticFileRelationshipReadPort {
  return {
    async listOutboundCandidates(input) {
      const limit = assertInput(input);
      const rows = await sql<CandidateRow[]>`
        WITH selected_generation AS (
          SELECT generation.public_id, generation.knowledge_base_id
          FROM focowiki.semantic_generations generation
          WHERE generation.knowledge_base_id = ${input.knowledgeBaseId}
            AND generation.deleted_at IS NULL
            AND (
              generation.operation_public_id = ${input.operationPublicId}
                AND generation.generation_role = 'candidate'
                AND generation.state = 'ready'
              OR generation.generation_role = 'active'
                AND generation.state = 'active'
            )
          ORDER BY CASE
            WHEN generation.operation_public_id = ${input.operationPublicId}
              AND generation.generation_role = 'candidate' THEN 0
            ELSE 1
          END, generation.public_id COLLATE "C"
          LIMIT 1
        )
        SELECT DISTINCT generation.public_id AS semantic_generation_public_id,
               relationship.public_id AS relationship_public_id,
               target_observation.source_file_public_id
                 AS target_source_file_public_id,
               target_observation.source_revision_public_id
                 AS target_source_revision_public_id,
               from_entity.label AS from_entity_label,
               to_entity.label AS to_entity_label,
               relationship.relationship_kind,
               relationship.description,
               relationship.confidence
        FROM selected_generation generation
        JOIN focowiki.semantic_relationships relationship
          ON relationship.knowledge_base_id = generation.knowledge_base_id
         AND relationship.semantic_generation_public_id = generation.public_id
         AND relationship.deleted_at IS NULL
        JOIN focowiki.semantic_entities from_entity
          ON from_entity.knowledge_base_id = relationship.knowledge_base_id
         AND from_entity.semantic_generation_public_id
           = relationship.semantic_generation_public_id
         AND from_entity.public_id = relationship.from_entity_public_id
         AND from_entity.deleted_at IS NULL
        JOIN focowiki.semantic_entities to_entity
          ON to_entity.knowledge_base_id = relationship.knowledge_base_id
         AND to_entity.semantic_generation_public_id
           = relationship.semantic_generation_public_id
         AND to_entity.public_id = relationship.to_entity_public_id
         AND to_entity.deleted_at IS NULL
        JOIN focowiki.semantic_entity_observations source_observation
          ON source_observation.knowledge_base_id = relationship.knowledge_base_id
         AND source_observation.semantic_generation_public_id
           = relationship.semantic_generation_public_id
         AND source_observation.entity_public_id = relationship.from_entity_public_id
         AND source_observation.source_file_public_id = ${input.sourceFilePublicId}
         AND source_observation.source_revision_public_id
           = ${input.sourceRevisionPublicId}
        JOIN focowiki.semantic_mentions source_mention
          ON source_mention.knowledge_base_id = relationship.knowledge_base_id
         AND source_mention.semantic_generation_public_id
           = relationship.semantic_generation_public_id
         AND source_mention.entity_public_id = relationship.from_entity_public_id
         AND source_mention.source_file_public_id = ${input.sourceFilePublicId}
         AND source_mention.source_revision_public_id = ${input.sourceRevisionPublicId}
        JOIN focowiki.source_file_current_revisions source_current_revision
          ON source_current_revision.knowledge_base_id = relationship.knowledge_base_id
         AND source_current_revision.source_file_public_id = ${input.sourceFilePublicId}
         AND source_current_revision.source_revision_public_id
           = ${input.sourceRevisionPublicId}
        JOIN focowiki.semantic_entity_observations target_observation
          ON target_observation.knowledge_base_id = relationship.knowledge_base_id
         AND target_observation.semantic_generation_public_id
           = relationship.semantic_generation_public_id
         AND target_observation.entity_public_id = relationship.to_entity_public_id
         AND target_observation.source_file_public_id <> ${input.sourceFilePublicId}
        JOIN focowiki.semantic_mentions target_mention
          ON target_mention.knowledge_base_id = relationship.knowledge_base_id
         AND target_mention.semantic_generation_public_id
           = relationship.semantic_generation_public_id
         AND target_mention.entity_public_id = relationship.to_entity_public_id
         AND target_mention.source_file_public_id
           = target_observation.source_file_public_id
         AND target_mention.source_revision_public_id
           = target_observation.source_revision_public_id
        JOIN focowiki.source_files target_source
          ON target_source.knowledge_base_id = target_observation.knowledge_base_id
         AND target_source.public_id = target_observation.source_file_public_id
         AND target_source.deleted_at IS NULL
        JOIN focowiki.source_file_current_revisions target_current_revision
          ON target_current_revision.knowledge_base_id
            = target_observation.knowledge_base_id
         AND target_current_revision.source_file_public_id
           = target_observation.source_file_public_id
         AND target_current_revision.source_revision_public_id
           = target_observation.source_revision_public_id
        WHERE EXISTS (
            SELECT 1
            FROM focowiki.semantic_relationship_evidence relationship_evidence
            JOIN focowiki.semantic_evidence evidence
              ON evidence.knowledge_base_id = relationship_evidence.knowledge_base_id
             AND evidence.semantic_generation_public_id
               = relationship_evidence.semantic_generation_public_id
             AND evidence.public_id = relationship_evidence.evidence_public_id
            JOIN focowiki.source_file_current_revisions evidence_current_revision
              ON evidence_current_revision.knowledge_base_id = evidence.knowledge_base_id
             AND evidence_current_revision.source_file_public_id
               = evidence.source_file_public_id
             AND evidence_current_revision.source_revision_public_id
               = evidence.source_revision_public_id
            WHERE relationship_evidence.knowledge_base_id
              = relationship.knowledge_base_id
              AND relationship_evidence.semantic_generation_public_id
                = relationship.semantic_generation_public_id
              AND relationship_evidence.relationship_public_id
                = relationship.public_id
              AND evidence.source_file_public_id IN (
                ${input.sourceFilePublicId}, target_observation.source_file_public_id
              )
          )
        ORDER BY relationship_public_id, target_source_file_public_id
        LIMIT ${limit}
      `;
      const semanticGenerationPublicId = rows[0]?.semantic_generation_public_id;
      const relationshipPublicIds = [...new Set(rows.map((row) =>
        row.relationship_public_id))];
      const evidenceRows = relationshipPublicIds.length === 0
        || !semanticGenerationPublicId ? []
        : await readEvidence(
            sql,
            input.knowledgeBaseId,
            semanticGenerationPublicId,
            relationshipPublicIds
          );
      const evidenceByRelationship = groupEvidence(evidenceRows);
      return rows.map((row): SemanticFileRelationshipCandidate => ({
        targetSourceFilePublicId: row.target_source_file_public_id,
        targetSourceRevisionPublicId: row.target_source_revision_public_id,
        fromEntityLabel: row.from_entity_label,
        toEntityLabel: row.to_entity_label,
        kind: row.relationship_kind,
        description: row.description,
        confidence: Number(row.confidence),
        evidence: (evidenceByRelationship.get(row.relationship_public_id) ?? []).filter(
          (evidence) => evidence.sourceFilePublicId === input.sourceFilePublicId
            || evidence.sourceFilePublicId === row.target_source_file_public_id
        )
      }));
    }
  };
}

async function readEvidence(
  sql: DatabaseClient,
  knowledgeBaseId: string,
  semanticGenerationPublicId: string,
  relationshipPublicIds: readonly string[]
): Promise<EvidenceRow[]> {
  return sql<EvidenceRow[]>`
    WITH ranked_evidence AS (
      SELECT relationship_evidence.relationship_public_id,
             evidence.source_file_public_id,
             evidence.source_revision_public_id,
             evidence.logical_path,
             evidence.start_offset,
             evidence.end_offset,
             evidence.excerpt_checksum_sha256,
             row_number() OVER (
               PARTITION BY relationship_evidence.relationship_public_id
               ORDER BY evidence.logical_path COLLATE "C",
                        evidence.start_offset,
                        evidence.public_id COLLATE "C"
             ) AS evidence_ordinal
      FROM focowiki.semantic_relationship_evidence relationship_evidence
      JOIN focowiki.semantic_evidence evidence
        ON evidence.knowledge_base_id = relationship_evidence.knowledge_base_id
       AND evidence.semantic_generation_public_id
         = relationship_evidence.semantic_generation_public_id
       AND evidence.public_id = relationship_evidence.evidence_public_id
      JOIN focowiki.semantic_generations generation
        ON generation.knowledge_base_id = relationship_evidence.knowledge_base_id
       AND generation.public_id
         = relationship_evidence.semantic_generation_public_id
       AND generation.deleted_at IS NULL
      JOIN focowiki.source_files source
        ON source.knowledge_base_id = evidence.knowledge_base_id
       AND source.public_id = evidence.source_file_public_id
       AND source.deleted_at IS NULL
      JOIN focowiki.source_file_current_revisions current_revision
        ON current_revision.knowledge_base_id = evidence.knowledge_base_id
       AND current_revision.source_file_public_id = evidence.source_file_public_id
       AND current_revision.source_revision_public_id
         = evidence.source_revision_public_id
      WHERE relationship_evidence.knowledge_base_id = ${knowledgeBaseId}
        AND relationship_evidence.semantic_generation_public_id
          = ${semanticGenerationPublicId}
        AND (
          generation.generation_role = 'candidate' AND generation.state = 'ready'
          OR generation.generation_role = 'active' AND generation.state = 'active'
        )
        AND relationship_evidence.relationship_public_id
          = ANY(${[...relationshipPublicIds]})
    )
    SELECT relationship_public_id, source_file_public_id,
           source_revision_public_id, logical_path, start_offset, end_offset,
           excerpt_checksum_sha256
    FROM ranked_evidence
    WHERE evidence_ordinal <= 16
    ORDER BY relationship_public_id COLLATE "C", evidence_ordinal
  `;
}

function groupEvidence(
  rows: readonly EvidenceRow[]
): Map<string, SemanticFileRelationshipEvidence[]> {
  const result = new Map<string, SemanticFileRelationshipEvidence[]>();
  for (const row of rows) {
    const values = result.get(row.relationship_public_id) ?? [];
    values.push({
      sourceFilePublicId: row.source_file_public_id,
      sourceRevisionPublicId: row.source_revision_public_id,
      logicalPath: row.logical_path,
      startOffset: Number(row.start_offset),
      endOffset: Number(row.end_offset),
      excerptChecksumSha256: row.excerpt_checksum_sha256
    });
    result.set(row.relationship_public_id, values);
  }
  return result;
}

function assertInput(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  limit: number;
}): number {
  if (
    !input.knowledgeBaseId
    || !input.operationPublicId
    || !input.sourceFilePublicId
    || !input.sourceRevisionPublicId
    || !Number.isSafeInteger(input.limit)
    || input.limit < 1
    || input.limit > 1_000
  ) throw new SemanticFileGraphEvidenceRepositoryError("invalid_input");
  return input.limit;
}
