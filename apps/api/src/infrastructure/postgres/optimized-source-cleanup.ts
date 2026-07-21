import type { TransactionSql } from "postgres";

export async function purgeOptimizedSourceState(
  transaction: TransactionSql,
  input: {
    knowledgeBaseId: string;
    sourceIds: string[];
    cleanupJobId: string;
  }
): Promise<void> {
  const sourceInputKeys = input.sourceIds.map((sourceId) => `source:${sourceId}`);

  await transaction`
    DELETE FROM focowiki.active_object_refs
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND source_file_id = ANY(${input.sourceIds})
  `;
  await transaction`
    DELETE FROM focowiki.active_projection_records
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND (
        source_file_id = ANY(${input.sourceIds})
        OR related_source_file_id = ANY(${input.sourceIds})
      )
  `;
  await transaction`
    DELETE FROM focowiki.generation_object_refs
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND source_file_id = ANY(${input.sourceIds})
  `;
  await transaction`
    DELETE FROM focowiki.generation_projection_records
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND (
        source_file_id = ANY(${input.sourceIds})
        OR related_source_file_id = ANY(${input.sourceIds})
      )
  `;
  await transaction`
    WITH target_facts AS MATERIALIZED (
      SELECT id
      FROM focowiki.publication_change_facts
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND source_file_id = ANY(${input.sourceIds})
    ), target_impacts AS MATERIALIZED (
      SELECT DISTINCT cause.impact_id
      FROM focowiki.publication_impact_causes cause
      JOIN target_facts fact ON fact.id = cause.change_fact_id
    )
    DELETE FROM focowiki.publication_impacts impact
    WHERE impact.knowledge_base_id = ${input.knowledgeBaseId}
      AND (
        impact.record_identity = ANY(${input.sourceIds})
        OR impact.projection_input_key = ANY(${sourceInputKeys})
        OR (
          impact.id IN (SELECT impact_id FROM target_impacts)
          AND NOT EXISTS (
            SELECT 1
            FROM focowiki.publication_impact_causes remaining
            WHERE remaining.impact_id = impact.id
              AND remaining.change_fact_id NOT IN (SELECT id FROM target_facts)
          )
        )
      )
  `;
  await transaction`
    DELETE FROM focowiki.publication_change_facts
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND source_file_id = ANY(${input.sourceIds})
  `;
  await transaction`
    DELETE FROM focowiki.publication_projection_inputs input
    WHERE input.knowledge_base_id = ${input.knowledgeBaseId}
      AND input.input_key = ANY(${sourceInputKeys})
      AND NOT EXISTS (
        SELECT 1
        FROM focowiki.publication_impacts impact
        WHERE impact.generation_id = input.generation_id
          AND impact.projection_input_key = input.input_key
      )
  `;

  await transaction`
    DELETE FROM focowiki.source_file_graph_edges
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND (
        from_source_file_id = ANY(${input.sourceIds})
        OR to_source_file_id = ANY(${input.sourceIds})
      )
  `;
  await transaction`
    DELETE FROM focowiki.source_file_events
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND source_file_id = ANY(${input.sourceIds})
  `;
  await transaction`
    DELETE FROM focowiki.source_file_graph_jobs
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND source_file_id = ANY(${input.sourceIds})
  `;
  await transaction`
    DELETE FROM focowiki.source_file_graph_nodes
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND source_file_id = ANY(${input.sourceIds})
  `;
  await transaction`
    DELETE FROM focowiki.source_file_retry_attempts
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND source_file_id = ANY(${input.sourceIds})
  `;
  await transaction`
    DELETE FROM focowiki.model_invocations
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND source_file_id = ANY(${input.sourceIds})
  `;
  await transaction`
    DELETE FROM focowiki.source_dispatch_markers
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND source_file_id = ANY(${input.sourceIds})
  `;
  await transaction`
    DELETE FROM focowiki.role_jobs
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND source_file_id = ANY(${input.sourceIds})
      AND id <> ${input.cleanupJobId}
  `;
}
