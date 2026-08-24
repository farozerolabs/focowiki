import type { DatabaseClient } from "../../db/client.js";
import type { DocumentPublicationFactDelta } from
  "../application/document-publication-planner.js";
import {
  visibleDocumentGraphEvidence,
  visibleDocumentGraphRelation
} from "./postgres-document-graph-visibility.js";

export async function replacePostgresDocumentGenerationGraphDegrees(input: {
  transaction: DatabaseClient;
  generationPublicId: string;
  knowledgeBaseId: string;
  documents: readonly DocumentPublicationFactDelta[];
  createdAt: string;
}): Promise<number> {
  const sql = input.transaction;
  const included = [...new Set(input.documents.flatMap((document) =>
    document.operation === "delete" ? [] : [document.sourceRevisionPublicId]
  ))].sort();
  const excluded = [...new Set(input.documents.map((document) =>
    document.sourceFilePublicId))].sort();
  if (excluded.length === 0) return 0;
  const rows = await sql<Array<{ source_revision_public_id: string }>>`
    WITH relevant_relation AS MATERIALIZED (
      SELECT relation.first_source_revision_public_id,
             relation.second_source_revision_public_id
      FROM focowiki.canonical_file_relations relation
      WHERE relation.knowledge_base_id = ${input.knowledgeBaseId}
        AND relation.first_source_file_public_id = ANY(${excluded}::text[])
      UNION
      SELECT relation.first_source_revision_public_id,
             relation.second_source_revision_public_id
      FROM focowiki.canonical_file_relations relation
      WHERE relation.knowledge_base_id = ${input.knowledgeBaseId}
        AND relation.second_source_file_public_id = ANY(${excluded}::text[])
      UNION
      SELECT relation.first_source_revision_public_id,
             relation.second_source_revision_public_id
      FROM focowiki.canonical_file_relations relation
      WHERE relation.knowledge_base_id = ${input.knowledgeBaseId}
        AND relation.first_source_revision_public_id = ANY(${included}::text[])
      UNION
      SELECT relation.first_source_revision_public_id,
             relation.second_source_revision_public_id
      FROM focowiki.canonical_file_relations relation
      WHERE relation.knowledge_base_id = ${input.knowledgeBaseId}
        AND relation.second_source_revision_public_id = ANY(${included}::text[])
    ), affected_revision AS MATERIALIZED (
      SELECT included.source_revision_public_id
      FROM unnest(${included}::text[])
        AS included(source_revision_public_id)
      UNION
      SELECT relation.first_source_revision_public_id
      FROM relevant_relation relation
      UNION
      SELECT relation.second_source_revision_public_id
      FROM relevant_relation relation
    ), visible_revision AS MATERIALIZED (
      SELECT record.source_revision_public_id
      FROM focowiki.document_projection_records record
      JOIN affected_revision affected
        ON affected.source_revision_public_id
             = record.source_revision_public_id
      WHERE record.knowledge_base_id = ${input.knowledgeBaseId}
        AND (
          record.source_revision_public_id = ANY(${included}::text[])
          OR (record.active
            AND record.source_file_public_id <> ALL(${excluded}::text[]))
        )
    ), calculated AS (
      SELECT visible.source_revision_public_id,
             count(DISTINCT relation.public_id) FILTER (
               WHERE evidence.target_source_revision_public_id
                 = visible.source_revision_public_id
             ) AS incoming_count,
             count(DISTINCT relation.public_id) FILTER (
               WHERE evidence.source_revision_public_id
                 = visible.source_revision_public_id
             ) AS outgoing_count
      FROM visible_revision visible
      LEFT JOIN focowiki.canonical_file_relations relation
        ON relation.knowledge_base_id = ${input.knowledgeBaseId}
       AND (
         relation.first_source_revision_public_id
           = visible.source_revision_public_id
         OR relation.second_source_revision_public_id
           = visible.source_revision_public_id
       )
       AND (${visibleDocumentGraphRelation(sql, included, excluded)})
      LEFT JOIN focowiki.relation_directed_evidence evidence
        ON evidence.knowledge_base_id = relation.knowledge_base_id
       AND evidence.pair_public_id = relation.pair_public_id
       AND (${visibleDocumentGraphEvidence(sql, included, excluded)})
      GROUP BY visible.source_revision_public_id
    )
    INSERT INTO focowiki.projection_generation_graph_degrees (
      publication_generation_public_id, knowledge_base_id,
      source_revision_public_id, incoming_count, outgoing_count, created_at
    )
    SELECT ${input.generationPublicId}, ${input.knowledgeBaseId},
           calculated.source_revision_public_id,
           calculated.incoming_count, calculated.outgoing_count,
           ${input.createdAt}
    FROM calculated
    ON CONFLICT (
      publication_generation_public_id, source_revision_public_id
    ) DO UPDATE SET
      incoming_count = excluded.incoming_count,
      outgoing_count = excluded.outgoing_count,
      created_at = excluded.created_at
    RETURNING source_revision_public_id
  `;
  return rows.length;
}
