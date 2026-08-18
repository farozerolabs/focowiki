import { createHash } from "node:crypto";
import { portableByFileGraphPath } from "@focowiki/okf";
import type { TransactionSql } from "postgres";
import { generatedPagePath } from "../../domain/source-path.js";
import type {
  SemanticAffectedClosure,
  SemanticDesiredFactSet
} from "../domain/contracts.js";

export type PriorSemanticSourceFacts = {
  sourceRevisionPublicIds: string[];
  entityPublicIds: string[];
  relationshipPublicIds: string[];
  evidencePublicIds: string[];
};

export async function capturePriorSemanticSourceFacts(
  sql: TransactionSql,
  input: SemanticDesiredFactSet
): Promise<PriorSemanticSourceFacts> {
  const rows = await sql<Array<{
    source_revision_public_id: string;
    evidence_public_id: string;
    entity_public_id: string | null;
    relationship_public_id: string | null;
    from_entity_public_id: string | null;
    to_entity_public_id: string | null;
  }>>`
    SELECT evidence.source_revision_public_id,
           evidence.public_id AS evidence_public_id,
           mention.entity_public_id,
           relationship_evidence.relationship_public_id,
           relationship.from_entity_public_id,
           relationship.to_entity_public_id
    FROM focowiki.semantic_evidence evidence
    LEFT JOIN focowiki.semantic_mentions mention
      ON mention.knowledge_base_id = evidence.knowledge_base_id
     AND mention.semantic_generation_public_id = evidence.semantic_generation_public_id
     AND mention.evidence_public_id = evidence.public_id
    LEFT JOIN focowiki.semantic_relationship_evidence relationship_evidence
      ON relationship_evidence.knowledge_base_id = evidence.knowledge_base_id
     AND relationship_evidence.semantic_generation_public_id
       = evidence.semantic_generation_public_id
     AND relationship_evidence.evidence_public_id = evidence.public_id
    LEFT JOIN focowiki.semantic_relationships relationship
      ON relationship.knowledge_base_id = relationship_evidence.knowledge_base_id
     AND relationship.semantic_generation_public_id
       = relationship_evidence.semantic_generation_public_id
     AND relationship.public_id = relationship_evidence.relationship_public_id
    WHERE evidence.knowledge_base_id = ${input.knowledgeBaseId}
      AND evidence.semantic_generation_public_id = ${input.semanticGenerationPublicId}
      AND evidence.source_file_public_id = ${input.sourceFilePublicId}
    ORDER BY evidence.public_id, mention.entity_public_id,
      relationship_evidence.relationship_public_id
  `;
  return {
    sourceRevisionPublicIds: unique(rows.map((row) => row.source_revision_public_id)),
    evidencePublicIds: unique(rows.map((row) => row.evidence_public_id)),
    entityPublicIds: unique(rows.flatMap((row) => [
      row.entity_public_id,
      row.from_entity_public_id,
      row.to_entity_public_id
    ].filter((value): value is string => Boolean(value)))),
    relationshipPublicIds: unique(rows.flatMap((row) =>
      row.relationship_public_id ? [row.relationship_public_id] : []))
  };
}

export async function replaceSemanticReverseReferences(
  sql: TransactionSql,
  input: SemanticDesiredFactSet
): Promise<void> {
  await sql`
    DELETE FROM focowiki.semantic_reverse_references
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.semanticGenerationPublicId}
      AND source_file_public_id = ${input.sourceFilePublicId}
      AND source_revision_public_id = ${input.sourceRevisionPublicId}
  `;
  const rows = [
    ...input.mentions.map((mention) => ({
      targetKind: "entity",
      targetPublicId: mention.entityPublicId,
      evidencePublicId: mention.evidencePublicId
    })),
    ...input.relationships.flatMap((relationship) =>
      relationship.evidencePublicIds.map((evidencePublicId) => ({
        targetKind: "relationship",
        targetPublicId: relationship.publicId,
        evidencePublicId
      }))),
    ...input.evidence.map((evidence) => ({
      targetKind: "file",
      targetPublicId: input.sourceFilePublicId,
      evidencePublicId: evidence.publicId
    }))
  ];
  const deduplicated = [...new Map(rows.map((row) => [
    `${row.targetKind}\u001f${row.targetPublicId}\u001f${row.evidencePublicId}`,
    row
  ])).values()];
  if (deduplicated.length === 0) return;
  await sql`
    INSERT INTO focowiki.semantic_reverse_references (
      knowledge_base_id, semantic_generation_public_id, target_kind,
      target_public_id, source_file_public_id, source_revision_public_id,
      evidence_public_id
    )
    SELECT ${input.knowledgeBaseId}, ${input.semanticGenerationPublicId},
      item."targetKind", item."targetPublicId", ${input.sourceFilePublicId},
      ${input.sourceRevisionPublicId}, item."evidencePublicId"
    FROM jsonb_to_recordset(${sql.json(deduplicated as never)}) AS item(
      "targetKind" text, "targetPublicId" text, "evidencePublicId" text
    )
    ON CONFLICT DO NOTHING
  `;
}

export async function buildSemanticAffectedClosure(
  sql: TransactionSql,
  input: SemanticDesiredFactSet,
  prior: PriorSemanticSourceFacts
): Promise<SemanticAffectedClosure> {
  const entityPublicIds = unique([
    ...prior.entityPublicIds,
    ...input.entities.map((entity) => entity.publicId)
  ]);
  const relationshipPublicIds = unique([
    ...prior.relationshipPublicIds,
    ...input.relationships.map((relationship) => relationship.publicId)
  ]);
  const targets = [
    ...entityPublicIds.map((publicId) => ({ kind: "entity", publicId })),
    ...relationshipPublicIds.map((publicId) => ({ kind: "relationship", publicId }))
  ];
  const neighbors = targets.length === 0
    ? []
    : await sql<Array<{ source_file_public_id: string }>>`
      WITH targets AS (
        SELECT item.kind, item."publicId"
        FROM jsonb_to_recordset(${sql.json(targets as never)}) AS item(
          kind text, "publicId" text
        )
      )
      SELECT DISTINCT reference.source_file_public_id
      FROM targets
      JOIN focowiki.semantic_reverse_references reference
        ON reference.semantic_generation_public_id = ${input.semanticGenerationPublicId}
       AND reference.target_kind = targets.kind
       AND reference.target_public_id = targets."publicId"
      WHERE reference.knowledge_base_id = ${input.knowledgeBaseId}
        AND reference.source_file_public_id <> ${input.sourceFilePublicId}
      ORDER BY reference.source_file_public_id
    `;
  const evidencePublicIds = unique([
    ...prior.evidencePublicIds,
    ...input.evidence.map((evidence) => evidence.publicId)
  ]);
  const sourceRevisionPublicIds = unique([
    ...prior.sourceRevisionPublicIds,
    input.sourceRevisionPublicId
  ]);
  return {
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFilePublicIds: [input.sourceFilePublicId],
    sourceRevisionPublicIds,
    entityPublicIds,
    relationshipPublicIds,
    evidencePublicIds,
    reverseReferencePublicIds: unique([
      ...entityPublicIds.map((id) => `entity:${id}`),
      ...relationshipPublicIds.map((id) => `relationship:${id}`),
      `file:${input.sourceFilePublicId}`
    ]),
    vectorOwnerPublicIds: unique([
      input.sourceFilePublicId,
      ...entityPublicIds,
      ...relationshipPublicIds
    ]),
    dirtyPartitionKeys: unique(entityPublicIds.map((id) => `entity-${id.slice(0, 2)}`)),
    affectedFileNeighborPublicIds: neighbors.map((row) => row.source_file_public_id),
    generatedLogicalPaths: unique(input.evidence.slice(0, 1).flatMap((evidence) => {
      const pagePath = generatedPagePath(evidence.logicalPath);
      return [pagePath, portableByFileGraphPath(pagePath)];
    })),
    graphShardPublicIds: unique(entityPublicIds.map((id) => shard("graph", id))),
    searchShardPublicIds: unique([
      input.sourceFilePublicId,
      ...entityPublicIds,
      ...relationshipPublicIds
    ].map((id) => shard("search", id)))
  };
}

function shard(kind: string, value: string): string {
  return `${kind}-${createHash("sha256").update(value).digest("hex").slice(0, 4)}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
