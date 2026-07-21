import { randomUUID } from "node:crypto";
import {
  presentGraphRelationship,
  type OkfGraphEdge,
  type OkfGraphNode
} from "@focowiki/okf";
import type { DatabaseClient } from "./client.js";
import { buildGraphQueryTerms } from "../graph/graph-term-document.js";
import {
  GRAPH_COMMON_TERM_ABSOLUTE_MAX_DOCUMENTS,
  GRAPH_COMMON_TERM_MAX_DOCUMENT_RATIO,
  GRAPH_LEXICAL_QUERY_TERM_LIMIT,
  GRAPH_QUERY_TERM_LIMIT
} from "../graph/graph-term-frequency.js";
import type {
  FileGraphRelatedRecord,
  FileGraphRepository
} from "./admin-repositories.js";

type SourceGraphNodeRow = {
  knowledge_base_id: string;
  source_file_id: string;
  path: string;
  title: string;
  type: string | null;
  description: string | null;
  summary: string | null;
  subjects_json: unknown;
  tags_json: unknown;
  entities_json: unknown;
  explicit_references_json: unknown;
  relationship_hints_json: unknown;
  headings_json: unknown;
  keywords_json: unknown;
  language: string | null;
  profile_json: unknown;
  metadata_json: unknown;
  updated_at: Date;
};

type GraphEdgeRow = {
  id: string;
  knowledge_base_id: string;
  from_source_file_id: string;
  to_source_file_id: string;
  relation_type: string;
  weight: number | string;
  reason: string;
  source: string;
  status: "accepted" | "rejected";
  evidence_json: unknown;
  updated_at: Date;
};

type RelatedRow = {
  current_source_file_id: string;
  current_path: string;
  current_title: string;
  source_file_id: string;
  generated_file_id: string | null;
  path: string;
  title: string;
  relation_type: string;
  direction: "outgoing" | "incoming";
  weight: number | string;
  reason: string;
  source: string;
  evidence_json: unknown;
  content_available: boolean;
};

export function createPostgresFileGraphRepository(sql: DatabaseClient): FileGraphRepository {
  return {
    async upsertGraphNode({ knowledgeBaseId, node }) {
      await sql`
        INSERT INTO focowiki.source_file_graph_nodes (
          knowledge_base_id, source_file_id, path, title, type, description, summary,
          subjects_json, tags_json, entities_json, explicit_references_json,
          relationship_hints_json, headings_json, keywords_json, language,
          profile_version, profile_source, profile_json, metadata_json, updated_at
        )
        SELECT ${knowledgeBaseId}, ${node.fileId}, ${node.path}, ${node.title},
               ${node.type ?? null}, ${node.description ?? null}, ${node.summary ?? null},
               ${sql.json((node.subjects ?? []) as never)},
               ${sql.json((node.tags ?? []) as never)},
               ${sql.json((node.entities ?? []) as never)},
               ${sql.json((node.explicitReferences ?? []) as never)},
               ${sql.json((node.relationshipHints ?? []) as never)},
               ${sql.json((node.headings ?? []) as never)},
               ${sql.json((node.keywords ?? []) as never)}, ${node.language ?? null},
               ${readProfileString(node.metadata, "profileVersion")},
               ${readProfileString(node.metadata, "profileSource")},
               ${sql.json((node.metadata ?? {}) as never)},
               ${sql.json((node.metadata ?? {}) as never)}, now()
        FROM focowiki.source_files source
        WHERE source.id = ${node.fileId}
          AND source.knowledge_base_id = ${knowledgeBaseId}
          AND source.deleted_at IS NULL
          AND source.deletion_intent_id IS NULL
        ON CONFLICT (knowledge_base_id, source_file_id) DO UPDATE SET
          path = EXCLUDED.path,
          title = EXCLUDED.title,
          type = EXCLUDED.type,
          description = EXCLUDED.description,
          summary = EXCLUDED.summary,
          subjects_json = EXCLUDED.subjects_json,
          tags_json = EXCLUDED.tags_json,
          entities_json = EXCLUDED.entities_json,
          explicit_references_json = EXCLUDED.explicit_references_json,
          relationship_hints_json = EXCLUDED.relationship_hints_json,
          headings_json = EXCLUDED.headings_json,
          keywords_json = EXCLUDED.keywords_json,
          language = EXCLUDED.language,
          profile_version = EXCLUDED.profile_version,
          profile_source = EXCLUDED.profile_source,
          profile_json = EXCLUDED.profile_json,
          metadata_json = EXCLUDED.metadata_json,
          updated_at = now()
      `;
    },
    async upsertGraphTermDocument({ knowledgeBaseId, document }) {
      await sql`
        INSERT INTO focowiki.source_file_graph_term_documents (
          knowledge_base_id, source_file_id, source_revision_id,
          term_fingerprint, lexical_text, exact_terms, phrase_terms,
          explicit_references, updated_at
        )
        SELECT ${knowledgeBaseId}, ${document.sourceFileId}, ${document.sourceRevisionId},
               ${document.fingerprint}, ${document.lexicalText}, ${document.exactTerms},
               ${document.phraseTerms}, ${document.explicitReferences}, now()
        FROM focowiki.source_files source
        JOIN focowiki.source_revisions revision
          ON revision.id = ${document.sourceRevisionId}
         AND revision.knowledge_base_id = source.knowledge_base_id
         AND revision.source_file_id = source.id
        WHERE source.knowledge_base_id = ${knowledgeBaseId}
          AND source.id = ${document.sourceFileId}
          AND source.deleted_at IS NULL
          AND source.deletion_intent_id IS NULL
          AND ${document.sourceRevisionId} = CASE
            WHEN source.candidate_operation_id IS NULL THEN source.active_revision_id
            ELSE source.candidate_revision_id
          END
        ON CONFLICT (knowledge_base_id, source_file_id) DO UPDATE SET
          source_revision_id = EXCLUDED.source_revision_id,
          term_fingerprint = EXCLUDED.term_fingerprint,
          lexical_text = EXCLUDED.lexical_text,
          exact_terms = EXCLUDED.exact_terms,
          phrase_terms = EXCLUDED.phrase_terms,
          explicit_references = EXCLUDED.explicit_references,
          updated_at = now()
      `;
    },
    async applyGraphMutationSet(input) {
      return applyGraphMutationSet(sql, input);
    },
    async listGraphNodes(input) {
      return listSourceNodes(sql, input);
    },
    async listGraphEdges(input) {
      return listSourceEdges(sql, input);
    },
    async getGraphEdge({ knowledgeBaseId, edgeId }) {
      const rows = await sql<GraphEdgeRow[]>`
        SELECT id, knowledge_base_id, from_source_file_id, to_source_file_id,
               relation_type, weight, reason, source, status, evidence_json, updated_at
        FROM focowiki.source_file_graph_edges
        WHERE knowledge_base_id = ${knowledgeBaseId} AND id = ${edgeId}
        LIMIT 1
      `;
      return rows[0] ? mapEdge(rows[0]) : null;
    },
    async listGraphNeighborhood(input) {
      return listSourceNeighborhood(sql, input);
    },
    async listGraphCandidates({ knowledgeBaseId, sourceFileId, terms, limit }) {
      const query = buildGraphQueryTerms(terms.slice(0, 100));
      if (query.exactTerms.length === 0 || limit <= 0) return [];
      const rows = await sql.begin(async (transaction) => {
        await transaction`SET LOCAL enable_seqscan = off`;
        return transaction<Array<SourceGraphNodeRow & { candidate_score: number | string }>>`
          WITH query_term_frequencies AS MATERIALIZED (
            SELECT frequency.term, sum(frequency.document_count)::bigint AS document_count
            FROM focowiki.source_file_graph_term_frequencies frequency
            WHERE frequency.knowledge_base_id = ${knowledgeBaseId}
              AND frequency.term = ANY(${query.exactTerms})
            GROUP BY frequency.term
          ), selected_query_terms AS MATERIALIZED (
            SELECT query_term.term,
                   coalesce(frequency.document_count, 0)::bigint AS document_count
            FROM unnest(${query.exactTerms}::text[]) AS query_term(term)
            LEFT JOIN query_term_frequencies frequency
              ON frequency.term = query_term.term
            LEFT JOIN (
              SELECT coalesce(sum(source_file_count), 0)::bigint AS source_file_count
              FROM focowiki.knowledge_base_incremental_stat_shards
              WHERE knowledge_base_id = ${knowledgeBaseId}
            ) stats ON true
            WHERE coalesce(frequency.document_count, 0) <= greatest(
              1::bigint,
              least(
                ${GRAPH_COMMON_TERM_ABSOLUTE_MAX_DOCUMENTS}::bigint,
                ceil(
                  coalesce(stats.source_file_count, 0)
                  * ${GRAPH_COMMON_TERM_MAX_DOCUMENT_RATIO}::numeric
                )::bigint
              )
            )
            ORDER BY coalesce(frequency.document_count, 0), query_term.term
            LIMIT ${GRAPH_QUERY_TERM_LIMIT}
          ), bounded_query AS MATERIALIZED (
            SELECT coalesce(
                     array_agg(term ORDER BY document_count, term),
                     ARRAY[]::text[]
                   ) AS exact_terms,
                   coalesce(
                     array_to_string(
                       (array_agg(term ORDER BY document_count, term))
                         [1:${GRAPH_LEXICAL_QUERY_TERM_LIMIT}],
                       ' '
                     ),
                     ''
                   ) AS lexical_text
            FROM selected_query_terms
          ), candidate_matches AS MATERIALIZED (
          SELECT document.source_file_id, 100::real AS score
          FROM focowiki.source_file_graph_term_documents document
          WHERE document.knowledge_base_id = ${knowledgeBaseId}
            AND document.source_file_id <> ${sourceFileId}
            AND cardinality(${query.explicitReferences}::text[]) > 0
            AND document.explicit_references && ${query.explicitReferences}

          UNION ALL

          SELECT document.source_file_id, 20::real AS score
          FROM focowiki.source_file_graph_term_documents document
          CROSS JOIN bounded_query query
          WHERE document.knowledge_base_id = ${knowledgeBaseId}
            AND document.source_file_id <> ${sourceFileId}
            AND cardinality(${query.phraseTerms}::text[]) > 0
            AND document.phrase_terms && ${query.phraseTerms}
            AND cardinality(query.exact_terms) > 0
            AND document.exact_terms && query.exact_terms

          UNION ALL

          SELECT document.source_file_id, 10::real AS score
          FROM focowiki.source_file_graph_term_documents document
          CROSS JOIN bounded_query query
          WHERE document.knowledge_base_id = ${knowledgeBaseId}
            AND document.source_file_id <> ${sourceFileId}
            AND cardinality(query.exact_terms) > 0
            AND document.exact_terms && query.exact_terms

          UNION ALL

          SELECT document.source_file_id,
                 ts_rank_cd(
                   document.lexical_vector,
                   websearch_to_tsquery('simple', query.lexical_text)
                 ) AS score
          FROM focowiki.source_file_graph_term_documents document
          CROSS JOIN bounded_query query
          WHERE document.knowledge_base_id = ${knowledgeBaseId}
            AND document.source_file_id <> ${sourceFileId}
            AND query.lexical_text <> ''
            AND document.lexical_vector @@ websearch_to_tsquery('simple', query.lexical_text)
        ), candidate_documents AS (
          SELECT candidate.source_file_id, sum(candidate.score) AS candidate_score
          FROM candidate_matches candidate
          GROUP BY candidate.source_file_id
          ORDER BY candidate_score DESC, candidate.source_file_id ASC
          LIMIT ${Math.max(1, Math.min(1_000, limit))}
        )
        SELECT node.knowledge_base_id, node.source_file_id, node.path, node.title, node.type,
               node.description, node.summary, node.subjects_json, node.tags_json,
               node.entities_json, node.explicit_references_json, node.relationship_hints_json,
               node.headings_json, node.keywords_json, node.language, node.profile_json,
               node.metadata_json, node.updated_at, candidate.candidate_score
        FROM candidate_documents candidate
        JOIN focowiki.source_file_graph_nodes node
          ON node.knowledge_base_id = ${knowledgeBaseId}
         AND node.source_file_id = candidate.source_file_id
        JOIN focowiki.source_files source
          ON source.knowledge_base_id = node.knowledge_base_id
         AND source.id = node.source_file_id
        WHERE source.deleted_at IS NULL AND source.deletion_intent_id IS NULL
          ORDER BY candidate.candidate_score DESC, node.source_file_id ASC
        `;
      });
      return rows.map(mapNode);
    },
    async getGraphSummary({ knowledgeBaseId, sourceFileId, limit }) {
      const countRows = await sql<Array<{ count: number | string }>>`
        SELECT count(*)::int AS count
        FROM focowiki.source_file_graph_edges
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND status = 'accepted'
          AND (from_source_file_id = ${sourceFileId} OR to_source_file_id = ${sourceFileId})
      `;
      const related = await listSourceNeighborhood(sql, {
        knowledgeBaseId,
        sourceFileId,
        limit,
        cursor: null
      });
      return {
        sourceFileId,
        relationshipCount: Number(countRows[0]?.count ?? 0),
        relationships: related.items
      };
    },
    async getMutationClosures({ knowledgeBaseId, sourceFileIds }) {
      const uniqueSourceFileIds = unique(sourceFileIds).slice(0, 1_000);
      const closures = new Map<string, {
        neighborSourceFileIds: string[];
        edgeIds: string[];
      }>();
      for (const sourceFileId of uniqueSourceFileIds) {
        closures.set(sourceFileId, { neighborSourceFileIds: [], edgeIds: [] });
      }
      if (uniqueSourceFileIds.length === 0) return closures;

      const rows = await sql<Array<{
        id: string;
        from_source_file_id: string;
        to_source_file_id: string;
      }>>`
        SELECT id, from_source_file_id, to_source_file_id
        FROM focowiki.source_file_graph_edges
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND status = 'accepted'
          AND (
            from_source_file_id = ANY(${uniqueSourceFileIds})
            OR to_source_file_id = ANY(${uniqueSourceFileIds})
          )
        ORDER BY id ASC
      `;
      for (const row of rows) {
        const from = closures.get(row.from_source_file_id);
        if (from) {
          from.edgeIds.push(row.id);
          from.neighborSourceFileIds.push(row.to_source_file_id);
        }
        const to = closures.get(row.to_source_file_id);
        if (to) {
          to.edgeIds.push(row.id);
          to.neighborSourceFileIds.push(row.from_source_file_id);
        }
      }
      for (const closure of closures.values()) {
        closure.edgeIds = unique(closure.edgeIds);
        closure.neighborSourceFileIds = unique(closure.neighborSourceFileIds);
      }
      return closures;
    },
    async deleteGraphForSourceFile({ knowledgeBaseId, sourceFileId }) {
      await sql.begin(async (transaction) => {
        await transaction`
          DELETE FROM focowiki.source_file_graph_edges
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND (from_source_file_id = ${sourceFileId} OR to_source_file_id = ${sourceFileId})
        `;
        await transaction`
          DELETE FROM focowiki.source_file_graph_term_documents
          WHERE knowledge_base_id = ${knowledgeBaseId} AND source_file_id = ${sourceFileId}
        `;
        await transaction`
          DELETE FROM focowiki.source_file_graph_nodes
          WHERE knowledge_base_id = ${knowledgeBaseId} AND source_file_id = ${sourceFileId}
        `;
      });
    }
  };
}

type GraphMutationInput = {
  knowledgeBaseId: string;
  sourceFileId: string;
  target: OkfGraphNode;
  acceptedEdges: OkfGraphEdge[];
  rejectedEdges: OkfGraphEdge[];
  limit: number;
};

type GraphMutationEdgeRow = {
  id: string;
  from_source_file_id: string;
  to_source_file_id: string;
  status: "accepted" | "rejected";
};

async function applyGraphMutationSet(
  sql: DatabaseClient,
  input: GraphMutationInput
): Promise<{
  edgeCount: number;
  affectedSourceFileIds: string[];
  edgeIds: string[];
  removedEdgeIds: string[];
}> {
  return sql.begin(async (transaction) => {
    const removed = await transaction<GraphMutationEdgeRow[]>`
      DELETE FROM focowiki.source_file_graph_edges
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND (
          from_source_file_id = ${input.sourceFileId}
          OR (
            to_source_file_id = ${input.target.fileId}
            AND relation_type = 'direct_reference'
            AND evidence_json ->> 'reconciliation' = 'explicit_reference'
          )
        )
      RETURNING id, from_source_file_id, to_source_file_id, status
    `;
    const accepted = await bulkUpsertSourceEdges(
      transaction as unknown as DatabaseClient,
      input.knowledgeBaseId,
      input.acceptedEdges,
      "accepted"
    );
    const acceptedIdentities = new Set(input.acceptedEdges.map(edgeIdentity));
    const rejected = await bulkUpsertSourceEdges(
      transaction as unknown as DatabaseClient,
      input.knowledgeBaseId,
      input.rejectedEdges.filter((edge) => !acceptedIdentities.has(edgeIdentity(edge))),
      "rejected"
    );
    const referenceTerms = buildGraphQueryTerms([input.target.path]).explicitReferences;
    const explicit = referenceTerms.length === 0
      ? []
      : await transaction<GraphMutationEdgeRow[]>`
          WITH matching_referrers AS (
            SELECT document.source_file_id
            FROM focowiki.source_file_graph_term_documents document
            JOIN focowiki.source_files source
              ON source.knowledge_base_id = document.knowledge_base_id
             AND source.id = document.source_file_id
            WHERE document.knowledge_base_id = ${input.knowledgeBaseId}
              AND document.source_file_id <> ${input.target.fileId}
              AND document.explicit_references && ${referenceTerms}
              AND source.deleted_at IS NULL
              AND source.deletion_intent_id IS NULL
            ORDER BY document.source_file_id ASC
            LIMIT ${Math.max(1, Math.min(1_000, input.limit))}
          )
          INSERT INTO focowiki.source_file_graph_edges (
            id, knowledge_base_id, from_source_file_id, to_source_file_id,
            relation_type, weight, reason, source, status, evidence_json, updated_at
          )
          SELECT
            'source-graph-edge-' || md5(
              ${input.knowledgeBaseId} || ':' || referrer.source_file_id || ':' ||
              ${input.target.fileId} || ':direct_reference'
            ),
            ${input.knowledgeBaseId}, referrer.source_file_id, ${input.target.fileId},
            'direct_reference', 0.95,
            'The source explicitly references this file.',
            'deterministic', 'accepted',
            jsonb_build_object(
              'signal', 'direct_reference',
              'reconciliation', 'explicit_reference',
              'targetPath', ${normalizeGraphReferencePath(input.target.path)}::text,
              'targetTitle', ${input.target.title}::text
            ),
            now()
          FROM matching_referrers referrer
          ON CONFLICT (knowledge_base_id, from_source_file_id, to_source_file_id, relation_type)
          DO UPDATE SET
            weight = EXCLUDED.weight,
            reason = EXCLUDED.reason,
            source = EXCLUDED.source,
            status = EXCLUDED.status,
            evidence_json = EXCLUDED.evidence_json,
            updated_at = now()
          RETURNING id, from_source_file_id, to_source_file_id, status
        `;
    const affectedSourceFileIds = unique([
      input.sourceFileId,
      ...removed.flatMap((edge) => [edge.from_source_file_id, edge.to_source_file_id]),
      ...accepted.flatMap((edge) => [edge.from_source_file_id, edge.to_source_file_id]),
      ...rejected.flatMap((edge) => [edge.from_source_file_id, edge.to_source_file_id]),
      ...explicit.flatMap((edge) => [edge.from_source_file_id, edge.to_source_file_id])
    ]);

    return {
      edgeCount: accepted.length + explicit.length,
      affectedSourceFileIds,
      edgeIds: unique([...accepted, ...explicit].map((edge) => edge.id)),
      removedEdgeIds: unique(removed.map((edge) => edge.id))
    };
  });
}

async function bulkUpsertSourceEdges(
  sql: DatabaseClient,
  knowledgeBaseId: string,
  edges: OkfGraphEdge[],
  status: "accepted" | "rejected"
): Promise<GraphMutationEdgeRow[]> {
  if (edges.length === 0) return [];
  const rows = edges.map((edge) => ({
    id: `source-graph-edge-${randomUUID()}`,
    fromFileId: edge.fromFileId,
    toFileId: edge.toFileId,
    relationType: edge.relationType,
    weight: Math.max(0, Math.min(1, edge.weight)),
    reason: edge.reason,
    source: edge.source,
    evidence: normalizeEvidence(edge.evidence)
  }));

  return sql<GraphMutationEdgeRow[]>`
      WITH input_edges AS (
        SELECT edge.*
        FROM jsonb_to_recordset(${sql.json(rows as never)}) AS edge(
          "id" text,
          "fromFileId" text,
          "toFileId" text,
          "relationType" text,
          "weight" double precision,
          "reason" text,
          "source" text,
          "evidence" jsonb
        )
      ), valid_edges AS (
        SELECT edge.*
        FROM input_edges edge
        JOIN focowiki.source_files source
          ON source.knowledge_base_id = ${knowledgeBaseId}
         AND source.id = edge."fromFileId"
         AND source.deleted_at IS NULL
         AND source.deletion_intent_id IS NULL
        JOIN focowiki.source_files target
          ON target.knowledge_base_id = ${knowledgeBaseId}
         AND target.id = edge."toFileId"
         AND target.deleted_at IS NULL
         AND target.deletion_intent_id IS NULL
      )
      INSERT INTO focowiki.source_file_graph_edges (
        id, knowledge_base_id, from_source_file_id, to_source_file_id,
        relation_type, weight, reason, source, status, evidence_json, updated_at
      )
      SELECT edge."id", ${knowledgeBaseId}, edge."fromFileId", edge."toFileId",
             edge."relationType", edge."weight", edge."reason", edge."source",
             ${status}, edge."evidence", now()
      FROM valid_edges edge
      ON CONFLICT (knowledge_base_id, from_source_file_id, to_source_file_id, relation_type)
      DO UPDATE SET weight = EXCLUDED.weight, reason = EXCLUDED.reason,
                    source = EXCLUDED.source, status = EXCLUDED.status,
                    evidence_json = EXCLUDED.evidence_json, updated_at = now()
      RETURNING id, from_source_file_id, to_source_file_id, status
    `;
}

function edgeIdentity(edge: OkfGraphEdge): string {
  return `${edge.fromFileId}\u0000${edge.toFileId}\u0000${edge.relationType}`;
}

async function listSourceNodes(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; limit: number; cursor: string | null }
) {
  const cursor = parseIdCursor(input.cursor);
  const rows = await sql<SourceGraphNodeRow[]>`
    ${sourceNodeSelect(sql, input.knowledgeBaseId)}
      ${cursor ? sql`AND node.source_file_id > ${cursor}` : sql``}
    ORDER BY node.source_file_id ASC
    LIMIT ${input.limit + 1}
  `;
  return nodePage(rows, input.limit);
}

function sourceNodeSelect(sql: DatabaseClient, knowledgeBaseId: string) {
  return sql`
    SELECT node.knowledge_base_id, node.source_file_id, node.path, node.title, node.type,
           node.description, node.summary, node.subjects_json, node.tags_json,
           node.entities_json, node.explicit_references_json, node.relationship_hints_json,
           node.headings_json, node.keywords_json, node.language, node.profile_json,
           node.metadata_json, node.updated_at
    FROM focowiki.source_file_graph_nodes node
    JOIN focowiki.source_files source
      ON source.id = node.source_file_id AND source.knowledge_base_id = node.knowledge_base_id
    WHERE node.knowledge_base_id = ${knowledgeBaseId}
      AND source.deleted_at IS NULL AND source.deletion_intent_id IS NULL
  `;
}

function normalizeGraphReferencePath(value: string): string {
  return value.trim().replace(/^\/+|#.*$/gu, "");
}

async function listSourceEdges(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; limit: number; cursor: string | null }
) {
  const cursor = parseIdCursor(input.cursor);
  const rows = await sql<GraphEdgeRow[]>`
    SELECT edge.id, edge.knowledge_base_id, edge.from_source_file_id,
           edge.to_source_file_id, edge.relation_type, edge.weight, edge.reason,
           edge.source, edge.status, edge.evidence_json, edge.updated_at
    FROM focowiki.source_file_graph_edges edge
    JOIN focowiki.source_files source ON source.id = edge.from_source_file_id
    JOIN focowiki.source_files target ON target.id = edge.to_source_file_id
    WHERE edge.knowledge_base_id = ${input.knowledgeBaseId}
      AND edge.status = 'accepted'
      AND source.deleted_at IS NULL AND source.deletion_intent_id IS NULL
      AND target.deleted_at IS NULL AND target.deletion_intent_id IS NULL
      ${cursor ? sql`AND edge.id > ${cursor}` : sql``}
    ORDER BY edge.id ASC
    LIMIT ${input.limit + 1}
  `;
  return edgePage(rows, input.limit);
}

async function listSourceNeighborhood(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; sourceFileId: string; limit: number; cursor?: string | null }
) {
  const cursor = parseRelationCursor(input.cursor ?? null);
  const rows = await sql<RelatedRow[]>`
    WITH current_node AS (
      SELECT node.source_file_id, node.path, node.title
      FROM focowiki.source_file_graph_nodes node
      JOIN focowiki.source_files source
        ON source.id = node.source_file_id
       AND source.knowledge_base_id = node.knowledge_base_id
      WHERE node.knowledge_base_id = ${input.knowledgeBaseId}
        AND node.source_file_id = ${input.sourceFileId}
        AND source.deleted_at IS NULL
        AND source.deletion_intent_id IS NULL
      LIMIT 1
    ), raw_relationships AS (
      SELECT edge.to_source_file_id AS source_file_id, edge.relation_type,
             'outgoing'::text AS direction, edge.weight, edge.reason, edge.source, edge.evidence_json
      FROM focowiki.source_file_graph_edges edge
      WHERE edge.knowledge_base_id = ${input.knowledgeBaseId}
        AND edge.from_source_file_id = ${input.sourceFileId} AND edge.status = 'accepted'
      UNION ALL
      SELECT edge.from_source_file_id, edge.relation_type, 'incoming'::text,
             edge.weight, edge.reason, edge.source, edge.evidence_json
      FROM focowiki.source_file_graph_edges edge
      WHERE edge.knowledge_base_id = ${input.knowledgeBaseId}
        AND edge.to_source_file_id = ${input.sourceFileId} AND edge.status = 'accepted'
    ), relationships AS (
      SELECT source_file_id, relation_type, direction, weight, reason, source, evidence_json
      FROM (
        SELECT raw_relationships.*,
               row_number() OVER (
                 PARTITION BY source_file_id
                 ORDER BY weight DESC,
                          CASE WHEN direction = 'outgoing' THEN 0 ELSE 1 END,
                          relation_type ASC
               ) AS relationship_rank
        FROM raw_relationships
      ) ranked
      WHERE relationship_rank = 1
    )
    SELECT current.source_file_id AS current_source_file_id,
           current.path AS current_path, current.title AS current_title,
           related.source_file_id, NULL::text AS generated_file_id, node.path,
           node.title, related.relation_type, related.direction::text AS direction,
           related.weight, related.reason, related.source, related.evidence_json,
           false AS content_available
    FROM relationships related
    JOIN focowiki.source_file_graph_nodes node
      ON node.knowledge_base_id = ${input.knowledgeBaseId}
     AND node.source_file_id = related.source_file_id
    JOIN focowiki.source_files source ON source.id = related.source_file_id
    CROSS JOIN current_node current
    WHERE source.deleted_at IS NULL AND source.deletion_intent_id IS NULL
      ${cursor ? sql`AND (related.weight < ${cursor.weight}
        OR (related.weight = ${cursor.weight} AND related.source_file_id > ${cursor.fileId}))` : sql``}
    ORDER BY related.weight DESC, related.source_file_id ASC
    LIMIT ${input.limit + 1}
  `;
  return relatedPage(rows, input.limit);
}


function nodePage(rows: SourceGraphNodeRow[], limit: number) {
  const items = rows.slice(0, limit).map(mapNode);
  return { items, nextCursor: rows.length > limit ? serializeIdCursor(items.at(-1)?.fileId ?? "") : null };
}

function edgePage(rows: GraphEdgeRow[], limit: number) {
  const items = rows.slice(0, limit).map(mapEdge);
  return { items, nextCursor: rows.length > limit ? serializeIdCursor(rows[limit - 1]?.id ?? "") : null };
}

function relatedPage(rows: RelatedRow[], limit: number) {
  const pageRows = rows.slice(0, limit);
  const items = pageRows.map(mapRelated);
  const last = pageRows.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last
      ? serializeRelationCursor({ weight: Number(last.weight), fileId: last.source_file_id })
      : null
  };
}

function mapNode(row: SourceGraphNodeRow): OkfGraphNode {
  return {
    fileId: row.source_file_id,
    path: row.path,
    title: row.title,
    ...(row.type ? { type: row.type } : {}),
    ...(row.description ? { description: row.description } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    tags: strings(row.tags_json),
    subjects: strings(row.subjects_json),
    entities: strings(row.entities_json),
    explicitReferences: strings(row.explicit_references_json),
    relationshipHints: strings(row.relationship_hints_json),
    headings: strings(row.headings_json),
    keywords: strings(row.keywords_json),
    ...(row.language ? { language: row.language } : {}),
    metadata: record(row.profile_json)
  };
}

function mapEdge(row: GraphEdgeRow): OkfGraphEdge {
  return {
    fromFileId: row.from_source_file_id,
    toFileId: row.to_source_file_id,
    relationType: row.relation_type,
    weight: Number(row.weight),
    reason: row.reason,
    source: row.source,
    evidence: evidenceRecord(row.evidence_json)
  };
}

function mapRelated(row: RelatedRow): FileGraphRelatedRecord {
  const current = {
    fileId: row.current_source_file_id,
    path: row.current_path,
    title: row.current_title
  };
  const related = {
    fileId: row.source_file_id,
    path: row.path,
    title: row.title
  };
  const relationship = presentGraphRelationship(
    {
      from: row.direction === "outgoing" ? current : related,
      to: row.direction === "outgoing" ? related : current,
      relationType: row.relation_type,
      weight: Number(row.weight),
      reason: row.reason,
      source: row.source,
      evidence: evidenceRecord(row.evidence_json)
    },
    current.fileId
  );

  return {
    ...relationship,
    sourceFileId: row.source_file_id,
    generatedFileId: row.generated_file_id,
    contentAvailable: row.content_available
  };
}

function normalizeEvidence(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return { items: value };
  return record(value);
}

function evidenceRecord(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) return record(value);
  if (value.length === 1) return record(value[0]);
  return { items: value };
}

function readProfileString(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function serializeIdCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id })).toString("base64url");
}

function parseIdCursor(cursor: string | null): string | null {
  if (!cursor) return null;
  const parsed = record(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  return typeof parsed.id === "string" && parsed.id ? parsed.id : null;
}

function serializeRelationCursor(value: { weight: number; fileId: string }): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function parseRelationCursor(cursor: string | null): { weight: number; fileId: string } | null {
  if (!cursor) return null;
  const parsed = record(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  return typeof parsed.weight === "number" && typeof parsed.fileId === "string"
    ? { weight: parsed.weight, fileId: parsed.fileId }
    : null;
}
