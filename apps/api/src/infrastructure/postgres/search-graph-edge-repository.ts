import type { DatabaseClient } from "../../db/client.js";
import type { AcceptedGraphEdge } from "../../search/graph-expansion.js";
import type { TransactionSql } from "postgres";

type ReadSql = DatabaseClient | TransactionSql;

type AcceptedGraphEdgeRow = {
  seed_source_file_id: string;
  related_source_file_id: string;
  related_source_revision_id: string;
  weight: number | string;
  reason: string | null;
};

export async function loadActiveAcceptedGraphEdges(input: {
  sql: ReadSql;
  knowledgeBaseId: string;
  seedSourceFileIds: string[];
  limitPerSeed: number;
}): Promise<AcceptedGraphEdge[]> {
  const seedSourceFileIds = [...new Set(input.seedSourceFileIds)].slice(0, 1_000);
  if (seedSourceFileIds.length === 0) return [];
  const rows = await input.sql<AcceptedGraphEdgeRow[]>`
    SELECT seed.source_file_id AS seed_source_file_id,
           relation.related_source_file_id,
           relation.related_source_revision_id,
           relation.weight,
           relation.reason
    FROM unnest(${seedSourceFileIds}::text[]) AS seed(source_file_id)
    CROSS JOIN LATERAL (
      SELECT
        CASE
          WHEN edge.source_file_id = seed.source_file_id
            THEN edge.related_source_file_id
          ELSE edge.source_file_id
        END AS related_source_file_id,
        related.active_revision_id AS related_source_revision_id,
        coalesce((edge.payload_json->>'weight')::real, 0) AS weight,
        coalesce(edge.payload_json->>'reason', edge.summary) AS reason
      FROM focowiki.active_projection_records edge
      JOIN focowiki.source_files related
        ON related.id = CASE
          WHEN edge.source_file_id = seed.source_file_id
            THEN edge.related_source_file_id
          ELSE edge.source_file_id
        END
       AND related.knowledge_base_id = edge.knowledge_base_id
       AND related.deleted_at IS NULL
       AND related.task_deleted_at IS NULL
       AND related.deletion_intent_id IS NULL
       AND related.generated_output_status = 'visible'
       AND related.active_revision_id IS NOT NULL
      WHERE edge.knowledge_base_id = ${input.knowledgeBaseId}
        AND edge.projection_kind = 'graph_edge'
        AND (
          edge.source_file_id = seed.source_file_id
          OR edge.related_source_file_id = seed.source_file_id
        )
      ORDER BY coalesce((edge.payload_json->>'weight')::real, 0) DESC,
               edge.record_id
      LIMIT ${input.limitPerSeed}
    ) relation
  `;
  return rows.map((row) => ({
    seedSourceFileId: row.seed_source_file_id,
    relatedSourceFileId: row.related_source_file_id,
    relatedSourceRevisionId: row.related_source_revision_id,
    weight: Number(row.weight),
    reason: row.reason
  }));
}
