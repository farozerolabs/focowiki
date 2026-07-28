import type { DatabaseClient } from "../../db/client.js";

export function createPostgresPublicationGraphSummaryFinalizer(sql: DatabaseClient) {
  return {
    async finalize(input: {
      knowledgeBaseId: string;
      generationId: string;
    }): Promise<void> {
      const rows = await sql<Array<{ generation_id: string }>>`
        WITH candidate_generation AS MATERIALIZED (
          SELECT predecessor_generation_id
          FROM focowiki.publication_generations
          WHERE id = ${input.generationId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
            AND generation_kind = 'normal'
        ),
        graph_delta AS MATERIALIZED (
          SELECT candidate.projection_kind,
                 coalesce(sum(CASE
                   WHEN candidate.action = 'upsert' AND active.record_id IS NULL THEN 1
                   WHEN candidate.action = 'delete' AND active.record_id IS NOT NULL THEN -1
                   ELSE 0
                 END), 0) AS count_delta
          FROM focowiki.generation_projection_records candidate
          LEFT JOIN focowiki.active_projection_records active
            ON active.knowledge_base_id = candidate.knowledge_base_id
           AND active.projection_kind = candidate.projection_kind
           AND active.record_id = candidate.record_id
          WHERE candidate.generation_id = ${input.generationId}
            AND candidate.knowledge_base_id = ${input.knowledgeBaseId}
            AND candidate.projection_kind IN ('graph_node', 'graph_edge')
          GROUP BY candidate.projection_kind
        ),
        expected AS MATERIALIZED (
          SELECT
            coalesce(predecessor.node_count, 0)
              + coalesce((SELECT count_delta FROM graph_delta
                          WHERE projection_kind = 'graph_node'), 0) AS node_count,
            coalesce(predecessor.edge_count, 0)
              + coalesce((SELECT count_delta FROM graph_delta
                          WHERE projection_kind = 'graph_edge'), 0) AS edge_count
          FROM candidate_generation candidate
          LEFT JOIN focowiki.generation_graph_summaries predecessor
            ON predecessor.generation_id = candidate.predecessor_generation_id
           AND predecessor.knowledge_base_id = ${input.knowledgeBaseId}
        )
        INSERT INTO focowiki.generation_graph_summaries (
          knowledge_base_id, generation_id, node_count, edge_count,
          graph_index_available, updated_at
        )
        SELECT ${input.knowledgeBaseId}, ${input.generationId},
               expected.node_count, expected.edge_count, true, now()
        FROM expected
        ON CONFLICT (generation_id) DO UPDATE
        SET node_count = EXCLUDED.node_count,
            edge_count = EXCLUDED.edge_count,
            graph_index_available = EXCLUDED.graph_index_available,
            updated_at = EXCLUDED.updated_at
        RETURNING generation_id
      `;
      if (rows.length !== 1) {
        throw new Error("Normal publication generation is unavailable for graph summary finalization");
      }
    }
  };
}
