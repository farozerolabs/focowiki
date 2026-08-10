import type { DatabaseClient } from "../../db/client.js";
import type {
  SemanticPresentedEntity,
  SemanticSourcePresentationReadPort
} from "../presentation/source-context.js";
import { generatedPagePath } from "../../domain/source-path.js";

type PresentedEntityRow = {
  entity_public_id: string;
  label: string;
  entity_kind: string;
  description: string | null;
  confidence: number | string;
  logical_path: string;
};

export class SemanticSourcePresentationRepositoryError extends Error {
  public constructor(public readonly code: "invalid_input") {
    super(`Semantic source presentation repository error: ${code}`);
    this.name = "SemanticSourcePresentationRepositoryError";
  }
}

export function createPostgresSemanticSourcePresentationRepository(
  sql: DatabaseClient
): SemanticSourcePresentationReadPort {
  return {
    async getSourceContext(input) {
      const entityLimit = assertInput(input);
      const rows = await sql<PresentedEntityRow[]>`
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
        ), selected_entities AS (
          SELECT entity.public_id, observation.label, entity.entity_kind,
                 observation.description, observation.confidence
          FROM selected_generation generation
          JOIN focowiki.semantic_entities entity
            ON entity.knowledge_base_id = generation.knowledge_base_id
           AND entity.semantic_generation_public_id = generation.public_id
           AND entity.deleted_at IS NULL
          JOIN focowiki.semantic_entity_observations observation
            ON observation.knowledge_base_id = entity.knowledge_base_id
           AND observation.semantic_generation_public_id
             = entity.semantic_generation_public_id
           AND observation.entity_public_id = entity.public_id
           AND observation.source_file_public_id = ${input.sourceFilePublicId}
           AND observation.source_revision_public_id
             = ${input.sourceRevisionPublicId}
          WHERE EXISTS (
              SELECT 1
              FROM focowiki.semantic_mentions mention
              JOIN focowiki.semantic_evidence evidence
                ON evidence.knowledge_base_id = mention.knowledge_base_id
               AND evidence.semantic_generation_public_id
                 = mention.semantic_generation_public_id
               AND evidence.public_id = mention.evidence_public_id
              WHERE mention.knowledge_base_id = entity.knowledge_base_id
                AND mention.semantic_generation_public_id
                  = entity.semantic_generation_public_id
                AND mention.entity_public_id = entity.public_id
                AND mention.source_file_public_id = ${input.sourceFilePublicId}
                AND mention.source_revision_public_id
                  = ${input.sourceRevisionPublicId}
                AND ${visibleSourceRevisionSql(sql, input)}
            )
          ORDER BY observation.confidence DESC, entity.public_id COLLATE "C"
          LIMIT ${entityLimit}
        ), ranked_evidence AS (
          SELECT selected.public_id AS entity_public_id,
                 selected.label, selected.entity_kind, selected.description,
                 selected.confidence, evidence.logical_path,
                 row_number() OVER (
                   PARTITION BY selected.public_id
                   ORDER BY evidence.logical_path COLLATE "C",
                            evidence.start_offset,
                            evidence.public_id COLLATE "C"
                 ) AS evidence_ordinal
          FROM selected_entities selected
          JOIN selected_generation generation
            ON generation.knowledge_base_id = ${input.knowledgeBaseId}
          JOIN focowiki.semantic_mentions mention
            ON mention.knowledge_base_id = generation.knowledge_base_id
           AND mention.semantic_generation_public_id = generation.public_id
           AND mention.entity_public_id = selected.public_id
           AND mention.source_file_public_id = ${input.sourceFilePublicId}
           AND mention.source_revision_public_id = ${input.sourceRevisionPublicId}
          JOIN focowiki.semantic_evidence evidence
            ON evidence.knowledge_base_id = mention.knowledge_base_id
           AND evidence.semantic_generation_public_id
             = mention.semantic_generation_public_id
           AND evidence.public_id = mention.evidence_public_id
           AND evidence.source_file_public_id = ${input.sourceFilePublicId}
           AND evidence.source_revision_public_id = ${input.sourceRevisionPublicId}
          WHERE ${visibleSourceRevisionSql(sql, input)}
        )
        SELECT entity_public_id, label, entity_kind, description, confidence,
               logical_path
        FROM ranked_evidence
        WHERE evidence_ordinal <= 4
        ORDER BY confidence DESC, entity_public_id COLLATE "C", evidence_ordinal
      `;
      return { entities: mapEntities(rows) };
    }
  };
}

function visibleSourceRevisionSql(
  sql: DatabaseClient,
  input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
  }
) {
  return sql`
    EXISTS (
      SELECT 1
      FROM focowiki.source_file_current_revisions current_revision
      WHERE current_revision.knowledge_base_id = ${input.knowledgeBaseId}
        AND current_revision.source_file_public_id = ${input.sourceFilePublicId}
        AND current_revision.source_revision_public_id
          = ${input.sourceRevisionPublicId}
    )
    OR EXISTS (
      SELECT 1
      FROM focowiki.source_revisions revision
      JOIN focowiki.operation_work_items work
        ON work.knowledge_base_id = revision.knowledge_base_id
       AND work.operation_public_id = ${input.operationPublicId}
       AND work.work_kind = 'mutation'
       AND work.state IN ('queued', 'running', 'retry')
       AND work.checkpoint ->> 'candidateRevisionPublicId' = revision.public_id
      WHERE revision.knowledge_base_id = ${input.knowledgeBaseId}
        AND revision.source_file_public_id = ${input.sourceFilePublicId}
        AND revision.public_id = ${input.sourceRevisionPublicId}
        AND revision.revision_role = 'candidate'
    )
  `;
}

function mapEntities(rows: readonly PresentedEntityRow[]): SemanticPresentedEntity[] {
  const entities = new Map<string, SemanticPresentedEntity>();
  for (const row of rows) {
    const current = entities.get(row.entity_public_id) ?? {
      label: row.label,
      kind: row.entity_kind,
      description: row.description,
      confidence: Number(row.confidence),
      evidencePaths: []
    };
    const publicEvidencePath = generatedPagePath(row.logical_path);
    if (!current.evidencePaths.includes(publicEvidencePath)) {
      current.evidencePaths = [...current.evidencePaths, publicEvidencePath];
    }
    entities.set(row.entity_public_id, current);
  }
  return [...entities.values()];
}

function assertInput(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  entityLimit: number;
}): number {
  if (
    !input.knowledgeBaseId
    || !input.operationPublicId
    || !input.sourceFilePublicId
    || !input.sourceRevisionPublicId
    || !Number.isSafeInteger(input.entityLimit)
    || input.entityLimit < 1
    || input.entityLimit > 1_000
  ) throw new SemanticSourcePresentationRepositoryError("invalid_input");
  return input.entityLimit;
}
