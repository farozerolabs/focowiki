import type { DatabaseClient } from "../../db/client.js";
import type { SemanticSkeletonGraphSignals } from
  "../graphrag/skeleton-selector.js";

type SignalRow = {
  accepted_edge_count: number | string;
  inbound_edge_count: number | string;
  outbound_edge_count: number | string;
  distinct_neighbor_count: number | string;
  relation_kind_count: number | string;
  metadata: unknown;
};

export function createPostgresSemanticSkeletonSignalRead(sql: DatabaseClient) {
  return {
    async load(input: {
      knowledgeBaseId: string;
      sourceFilePublicId: string;
    }): Promise<SemanticSkeletonGraphSignals> {
      const rows = await sql<SignalRow[]>`
        WITH source_node AS (
          SELECT node.public_id, node.metadata
          FROM focowiki.graph_nodes node
          JOIN focowiki.source_file_current_revisions current_revision
            ON current_revision.knowledge_base_id = node.knowledge_base_id
           AND current_revision.source_file_public_id = node.source_file_public_id
           AND current_revision.source_revision_public_id
             = node.source_revision_public_id
          WHERE node.knowledge_base_id = ${input.knowledgeBaseId}
            AND node.source_file_public_id = ${input.sourceFilePublicId}
          ORDER BY node.public_id COLLATE "C"
          LIMIT 1
        ), bounded_edges AS (
          SELECT edge.from_node_public_id, edge.to_node_public_id, edge.relation
          FROM focowiki.graph_edges edge
          CROSS JOIN source_node
          WHERE edge.knowledge_base_id = ${input.knowledgeBaseId}
            AND (edge.from_node_public_id = source_node.public_id
              OR edge.to_node_public_id = source_node.public_id)
          ORDER BY edge.weight DESC, edge.public_id COLLATE "C"
          LIMIT 64
        )
        SELECT source_node.metadata,
          count(bounded_edges.relation)::integer AS accepted_edge_count,
          count(*) FILTER (
            WHERE bounded_edges.to_node_public_id = source_node.public_id
          )::integer AS inbound_edge_count,
          count(*) FILTER (
            WHERE bounded_edges.from_node_public_id = source_node.public_id
          )::integer AS outbound_edge_count,
          count(DISTINCT CASE
            WHEN bounded_edges.from_node_public_id = source_node.public_id
              THEN bounded_edges.to_node_public_id
            ELSE bounded_edges.from_node_public_id
          END)::integer AS distinct_neighbor_count,
          count(DISTINCT bounded_edges.relation)::integer AS relation_kind_count
        FROM source_node
        LEFT JOIN bounded_edges ON true
        GROUP BY source_node.public_id, source_node.metadata
      `;
      return rows[0] ? mapSignals(rows[0]) : emptySignals();
    }
  };
}

function mapSignals(row: SignalRow): SemanticSkeletonGraphSignals {
  const metadata = readObject(row.metadata);
  const profile = readObject(metadata?.contentProfile);
  return {
    acceptedEdgeCount: Number(row.accepted_edge_count),
    inboundEdgeCount: Number(row.inbound_edge_count),
    outboundEdgeCount: Number(row.outbound_edge_count),
    distinctNeighborCount: Number(row.distinct_neighbor_count),
    relationKindCount: Number(row.relation_kind_count),
    contentProfileHeadingCount: boundedStringArrayLength(profile?.headingOutline),
    contentProfileDefinitionCount: boundedStringArrayLength(profile?.definitions),
    contentProfileExplicitReferenceCount:
      boundedStringArrayLength(profile?.explicitReferences)
  };
}

function emptySignals(): SemanticSkeletonGraphSignals {
  return {
    acceptedEdgeCount: 0,
    inboundEdgeCount: 0,
    outboundEdgeCount: 0,
    distinctNeighborCount: 0,
    relationKindCount: 0,
    contentProfileHeadingCount: 0,
    contentProfileDefinitionCount: 0,
    contentProfileExplicitReferenceCount: 0
  };
}

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedStringArrayLength(value: unknown): number {
  return Array.isArray(value)
    ? Math.min(64, value.filter((item) => typeof item === "string").length)
    : 0;
}
