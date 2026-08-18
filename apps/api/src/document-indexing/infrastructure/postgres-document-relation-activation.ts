import type { DatabaseClient } from "../../db/client.js";

export async function applyPostgresDocumentRelationActivation(input: {
  transaction: DatabaseClient;
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  readinessSequence: number;
  relationPublicIds: readonly string[];
  activatedAt: string;
}): Promise<void> {
  const sql = input.transaction;
  await sql`
    UPDATE focowiki.canonical_file_relations relation
    SET active = false, retired_at = ${input.activatedAt}
    WHERE relation.knowledge_base_id = ${input.knowledgeBaseId}
      AND relation.active
      AND (relation.first_source_file_public_id = ${input.sourceFilePublicId}
        OR relation.second_source_file_public_id = ${input.sourceFilePublicId})
      AND relation.first_source_revision_public_id <> ${input.sourceRevisionPublicId}
      AND relation.second_source_revision_public_id <> ${input.sourceRevisionPublicId}
  `;
  await sql`
    UPDATE focowiki.relation_directed_evidence evidence
    SET active = false, retired_at = ${input.activatedAt}
    WHERE evidence.knowledge_base_id = ${input.knowledgeBaseId}
      AND evidence.active
      AND (evidence.source_file_public_id = ${input.sourceFilePublicId}
        OR evidence.target_source_file_public_id = ${input.sourceFilePublicId})
      AND evidence.source_revision_public_id <> ${input.sourceRevisionPublicId}
      AND evidence.target_source_revision_public_id <> ${input.sourceRevisionPublicId}
  `;
  const activated = await sql<Array<{
    public_id: string;
    pair_public_id: string;
  }>>`
    UPDATE focowiki.canonical_file_relations relation
    SET active = true, activated_sequence = ${input.readinessSequence},
        retired_at = NULL
    FROM focowiki.source_file_active_revisions first_active,
         focowiki.source_file_active_revisions second_active
    WHERE relation.knowledge_base_id = ${input.knowledgeBaseId}
      AND (
        relation.public_id = ANY(${input.relationPublicIds}::text[])
        OR relation.first_source_revision_public_id
          = ${input.sourceRevisionPublicId}
        OR relation.second_source_revision_public_id
          = ${input.sourceRevisionPublicId}
      )
      AND relation.retired_at IS NULL
      AND first_active.knowledge_base_id = relation.knowledge_base_id
      AND first_active.source_file_public_id
        = relation.first_source_file_public_id
      AND first_active.active_source_revision_public_id
        = relation.first_source_revision_public_id
      AND second_active.knowledge_base_id = relation.knowledge_base_id
      AND second_active.source_file_public_id
        = relation.second_source_file_public_id
      AND second_active.active_source_revision_public_id
        = relation.second_source_revision_public_id
    RETURNING relation.public_id, relation.pair_public_id
  `;
  if (activated.length > 0) {
    await sql`
      UPDATE focowiki.relation_directed_evidence
      SET active = true, retired_at = NULL
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND pair_public_id = ANY(
          ${activated.map((row) => row.pair_public_id)}::text[]
        )
    `;
  }
  await refreshAffectedGraphDegrees({
    transaction: sql,
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFilePublicId: input.sourceFilePublicId,
    sourceRevisionPublicId: input.sourceRevisionPublicId,
    relationPublicIds: activated.map((row) => row.public_id),
    updatedAt: input.activatedAt
  });
}

async function refreshAffectedGraphDegrees(input: {
  transaction: DatabaseClient;
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  relationPublicIds: readonly string[];
  updatedAt: string;
}): Promise<void> {
  const sql = input.transaction;
  await sql`
    WITH affected_revisions AS (
      SELECT ${input.sourceRevisionPublicId}::text
        AS source_revision_public_id
      UNION
      SELECT relation.first_source_revision_public_id
      FROM focowiki.canonical_file_relations relation
      WHERE relation.knowledge_base_id = ${input.knowledgeBaseId}
        AND (
          relation.first_source_file_public_id = ${input.sourceFilePublicId}
          OR relation.second_source_file_public_id = ${input.sourceFilePublicId}
          OR relation.public_id = ANY(${input.relationPublicIds}::text[])
        )
      UNION
      SELECT relation.second_source_revision_public_id
      FROM focowiki.canonical_file_relations relation
      WHERE relation.knowledge_base_id = ${input.knowledgeBaseId}
        AND (
          relation.first_source_file_public_id = ${input.sourceFilePublicId}
          OR relation.second_source_file_public_id = ${input.sourceFilePublicId}
          OR relation.public_id = ANY(${input.relationPublicIds}::text[])
        )
    ), calculated AS (
      SELECT affected.source_revision_public_id,
             count(DISTINCT relation.public_id) FILTER (
               WHERE evidence.target_source_revision_public_id
                 = affected.source_revision_public_id
             ) AS incoming_count,
             count(DISTINCT relation.public_id) FILTER (
               WHERE evidence.source_revision_public_id
                 = affected.source_revision_public_id
             ) AS outgoing_count
      FROM affected_revisions affected
      LEFT JOIN focowiki.canonical_file_relations relation
        ON relation.knowledge_base_id = ${input.knowledgeBaseId}
       AND relation.active
       AND (
         relation.first_source_revision_public_id
           = affected.source_revision_public_id
         OR relation.second_source_revision_public_id
           = affected.source_revision_public_id
       )
      LEFT JOIN focowiki.relation_directed_evidence evidence
        ON evidence.knowledge_base_id = relation.knowledge_base_id
       AND evidence.pair_public_id = relation.pair_public_id
       AND evidence.active
      GROUP BY affected.source_revision_public_id
    )
    UPDATE focowiki.document_graph_degrees degree
    SET incoming_count = calculated.incoming_count,
        outgoing_count = calculated.outgoing_count,
        updated_at = ${input.updatedAt}
    FROM calculated
    WHERE degree.knowledge_base_id = ${input.knowledgeBaseId}
      AND degree.source_revision_public_id
        = calculated.source_revision_public_id
      AND ROW(degree.incoming_count, degree.outgoing_count)
        IS DISTINCT FROM ROW(
          calculated.incoming_count, calculated.outgoing_count
        )
  `;
}
