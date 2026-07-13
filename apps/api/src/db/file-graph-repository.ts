import { randomUUID } from "node:crypto";
import type { OkfGraphEdge, OkfGraphNode } from "@focowiki/okf";
import type { DatabaseClient } from "./client.js";
import type {
  FileGraphJobRecord,
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

type ReleaseGraphNodeRow = SourceGraphNodeRow & { id: string };

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
  source_file_id: string;
  bundle_file_id: string | null;
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

type GraphJobRow = {
  id: string;
  knowledge_base_id: string;
  source_file_id: string;
  status: FileGraphJobRecord["status"];
  started_at: Date;
  ended_at: Date | null;
  error_code: string | null;
  created_at: Date;
};

export function createPostgresFileGraphRepository(sql: DatabaseClient): FileGraphRepository {
  const refreshGraphSummariesForSourceFiles = async (input: {
    knowledgeBaseId: string;
    sourceFileIds: string[];
    limit: number;
  }) => {
    for (const sourceFileId of unique(input.sourceFileIds)) {
      const countRows = await sql<Array<{ count: number | string }>>`
        SELECT count(*)::int AS count
        FROM focowiki.source_file_graph_edges edge
        WHERE edge.knowledge_base_id = ${input.knowledgeBaseId}
          AND edge.status = 'accepted'
          AND (edge.from_source_file_id = ${sourceFileId} OR edge.to_source_file_id = ${sourceFileId})
      `;
      const related = await listSourceNeighborhood(sql, {
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFileId,
        limit: input.limit,
        cursor: null
      });
      await sql`
        UPDATE focowiki.source_files
        SET graph_relationship_count = ${Number(countRows[0]?.count ?? 0)},
            graph_top_relationships_json = ${sql.json(related.items as never)}
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND id = ${sourceFileId}
          AND deleted_at IS NULL
      `;
    }
  };

  return {
    async createGraphJob(input) {
      const rows = await sql<GraphJobRow[]>`
        INSERT INTO focowiki.source_file_graph_jobs (
          id, knowledge_base_id, source_file_id, status, started_at
        )
        SELECT ${input.id ?? `graph-job-${randomUUID()}`}, ${input.knowledgeBaseId},
               ${input.sourceFileId}, 'running', ${input.startedAt}
        FROM focowiki.source_files source
        WHERE source.id = ${input.sourceFileId}
          AND source.knowledge_base_id = ${input.knowledgeBaseId}
          AND source.deleted_at IS NULL
          AND source.deletion_intent_id IS NULL
        RETURNING id, knowledge_base_id, source_file_id, status, started_at,
                  ended_at, error_code, created_at
      `;
      return mapGraphJob(requireRow(rows[0]));
    },
    async completeGraphJob(input) {
      const rows = await sql<GraphJobRow[]>`
        UPDATE focowiki.source_file_graph_jobs
        SET status = ${input.status}, ended_at = ${input.endedAt},
            error_code = ${input.errorCode ?? null}
        WHERE id = ${input.id}
        RETURNING id, knowledge_base_id, source_file_id, status, started_at,
                  ended_at, error_code, created_at
      `;
      return rows[0] ? mapGraphJob(rows[0]) : null;
    },
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
    async upsertGraphEdges({ knowledgeBaseId, edges }) {
      await upsertSourceEdges(sql, knowledgeBaseId, edges, "accepted");
      await refreshGraphSummariesForSourceFiles({
        knowledgeBaseId,
        sourceFileIds: edges.flatMap((edge) => [edge.fromFileId, edge.toFileId]),
        limit: 3
      });
    },
    async upsertRejectedGraphEdges({ knowledgeBaseId, edges }) {
      await upsertSourceEdges(sql, knowledgeBaseId, edges, "rejected");
    },
    async replaceGraphEdgesForSourceFile({ knowledgeBaseId, sourceFileId }) {
      const rows = await sql<Array<{ source_file_id: string }>>`
        WITH removed AS (
          DELETE FROM focowiki.source_file_graph_edges
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND from_source_file_id = ${sourceFileId}
          RETURNING to_source_file_id
        )
        SELECT DISTINCT to_source_file_id AS source_file_id FROM removed
      `;
      await refreshGraphSummariesForSourceFiles({
        knowledgeBaseId,
        sourceFileIds: [sourceFileId, ...rows.map((row) => row.source_file_id)],
        limit: 3
      });
      return rows.map((row) => row.source_file_id);
    },
    async reconcileExplicitReferenceEdgesForTarget({ knowledgeBaseId, target, limit }) {
      const targetPath = normalizeGraphReferencePath(target.path);
      const referenceTerms = unique([
        targetPath,
        `/${targetPath}`,
        target.title.trim()
      ]).filter(Boolean);
      const rows = await sql.begin(async (transaction) => {
        await transaction`
          DELETE FROM focowiki.source_file_graph_edges
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND to_source_file_id = ${target.fileId}
            AND relation_type = 'direct_reference'
            AND evidence_json ->> 'reconciliation' = 'explicit_reference'
        `;

        return transaction<Array<{ source_file_id: string }>>`
          WITH matching_referrers AS (
            SELECT node.source_file_id
            FROM focowiki.source_file_graph_nodes node
            JOIN focowiki.source_files source
              ON source.id = node.source_file_id
             AND source.knowledge_base_id = node.knowledge_base_id
            WHERE node.knowledge_base_id = ${knowledgeBaseId}
              AND node.source_file_id <> ${target.fileId}
              AND source.deleted_at IS NULL
              AND source.deletion_intent_id IS NULL
              AND node.explicit_references_json ?| ${referenceTerms}
            ORDER BY node.source_file_id ASC
            LIMIT ${limit}
          ), inserted AS (
            INSERT INTO focowiki.source_file_graph_edges (
              id, knowledge_base_id, from_source_file_id, to_source_file_id,
              relation_type, weight, reason, source, status, evidence_json, updated_at
            )
            SELECT
              'source-graph-edge-' || md5(
                ${knowledgeBaseId} || ':' || referrer.source_file_id || ':' ||
                ${target.fileId} || ':direct_reference'
              ),
              ${knowledgeBaseId}, referrer.source_file_id, ${target.fileId},
              'direct_reference', 0.95,
              'The source explicitly references this file.',
              'deterministic', 'accepted',
              ${transaction.json({
                signal: "direct_reference",
                reconciliation: "explicit_reference",
                targetPath,
                targetTitle: target.title
              } as never)},
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
            RETURNING from_source_file_id AS source_file_id
          )
          SELECT source_file_id FROM inserted
        `;
      });
      const sourceFileIds = unique(rows.map((row) => row.source_file_id));

      if (sourceFileIds.length > 0) {
        await refreshGraphSummariesForSourceFiles({
          knowledgeBaseId,
          sourceFileIds: [...sourceFileIds, target.fileId],
          limit: 3
        });
      }

      return {
        edgeCount: sourceFileIds.length,
        sourceFileIds
      };
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
      const cleanTerms = unique(terms).slice(0, 100);
      if (cleanTerms.length === 0 || limit <= 0) return [];
      const patterns = cleanTerms.map((term) => `%${escapeLike(term.toLowerCase())}%`);
      const rows = await sql<SourceGraphNodeRow[]>`
        ${sourceNodeSelect(sql, knowledgeBaseId)}
          AND node.source_file_id <> ${sourceFileId}
          AND (
            lower(node.title) LIKE ANY(${patterns})
            OR lower(COALESCE(node.summary, node.description, '')) LIKE ANY(${patterns})
            OR lower(node.profile_json::text) LIKE ANY(${patterns})
            OR node.subjects_json ?| ${cleanTerms}
            OR node.entities_json ?| ${cleanTerms}
            OR node.keywords_json ?| ${cleanTerms}
          )
        ORDER BY node.updated_at DESC, node.source_file_id ASC
        LIMIT ${limit}
      `;
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
    refreshGraphSummariesForSourceFiles,
    async listActiveGraphNodes(input) {
      return listReleaseNodes(sql, input);
    },
    async listActiveGraphEdges(input) {
      return listReleaseEdges(sql, input);
    },
    async getActiveGraphEdge(input) {
      const rows = await sql<GraphEdgeRow[]>`
        ${releaseEdgeSelect(sql, input.knowledgeBaseId, input.releaseId)}
          AND edge.id = ${input.edgeId}
        LIMIT 1
      `;
      return rows[0] ? mapEdge(rows[0]) : null;
    },
    async listActiveGraphNeighborhood(input) {
      return listReleaseNeighborhood(sql, input);
    },
    async deleteGraphForSourceFile({ knowledgeBaseId, sourceFileId }) {
      await sql.begin(async (transaction) => {
        await transaction`
          DELETE FROM focowiki.source_file_graph_edges
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND (from_source_file_id = ${sourceFileId} OR to_source_file_id = ${sourceFileId})
        `;
        await transaction`
          DELETE FROM focowiki.source_file_graph_nodes
          WHERE knowledge_base_id = ${knowledgeBaseId} AND source_file_id = ${sourceFileId}
        `;
      });
    }
  };
}

async function upsertSourceEdges(
  sql: DatabaseClient,
  knowledgeBaseId: string,
  edges: OkfGraphEdge[],
  status: "accepted" | "rejected"
): Promise<void> {
  for (const edge of edges) {
    await sql`
      INSERT INTO focowiki.source_file_graph_edges (
        id, knowledge_base_id, from_source_file_id, to_source_file_id,
        relation_type, weight, reason, source, status, evidence_json, updated_at
      )
      SELECT ${`source-graph-edge-${randomUUID()}`}, ${knowledgeBaseId},
             ${edge.fromFileId}, ${edge.toFileId}, ${edge.relationType},
             ${Math.max(0, Math.min(1, edge.weight))}, ${edge.reason}, ${edge.source},
             ${status}, ${sql.json(normalizeEvidence(edge.evidence) as never)}, now()
      WHERE EXISTS (
        SELECT 1 FROM focowiki.source_files source
        WHERE source.id = ${edge.fromFileId} AND source.knowledge_base_id = ${knowledgeBaseId}
          AND source.deleted_at IS NULL AND source.deletion_intent_id IS NULL
      ) AND EXISTS (
        SELECT 1 FROM focowiki.source_files target
        WHERE target.id = ${edge.toFileId} AND target.knowledge_base_id = ${knowledgeBaseId}
          AND target.deleted_at IS NULL AND target.deletion_intent_id IS NULL
      )
      ON CONFLICT (knowledge_base_id, from_source_file_id, to_source_file_id, relation_type)
      DO UPDATE SET weight = EXCLUDED.weight, reason = EXCLUDED.reason,
                    source = EXCLUDED.source, status = EXCLUDED.status,
                    evidence_json = EXCLUDED.evidence_json, updated_at = now()
    `;
  }
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
    WITH raw_relationships AS (
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
    SELECT related.source_file_id, NULL::text AS bundle_file_id, node.path,
           node.title, related.relation_type, related.direction::text AS direction,
           related.weight, related.reason, related.source, related.evidence_json,
           false AS content_available
    FROM relationships related
    JOIN focowiki.source_file_graph_nodes node
      ON node.knowledge_base_id = ${input.knowledgeBaseId}
     AND node.source_file_id = related.source_file_id
    JOIN focowiki.source_files source ON source.id = related.source_file_id
    WHERE source.deleted_at IS NULL AND source.deletion_intent_id IS NULL
      ${cursor ? sql`AND (related.weight < ${cursor.weight}
        OR (related.weight = ${cursor.weight} AND related.source_file_id > ${cursor.fileId}))` : sql``}
    ORDER BY related.weight DESC, related.source_file_id ASC
    LIMIT ${input.limit + 1}
  `;
  return relatedPage(rows, input.limit);
}

async function listReleaseNodes(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; releaseId: string; limit: number; cursor: string | null }
) {
  const cursor = parseIdCursor(input.cursor);
  const rows = await sql<ReleaseGraphNodeRow[]>`
    ${releaseNodeSelect(sql, input.knowledgeBaseId, input.releaseId)}
      ${cursor ? sql`AND node.id > ${cursor}` : sql``}
    ORDER BY node.id ASC
    LIMIT ${input.limit + 1}
  `;
  const items = rows.slice(0, input.limit).map(mapNode);
  return {
    items,
    nextCursor: rows.length > input.limit
      ? serializeIdCursor(rows[input.limit - 1]?.id ?? "")
      : null
  };
}

function releaseNodeSelect(sql: DatabaseClient, knowledgeBaseId: string, releaseId: string) {
  return sql`
    SELECT node.id, node.knowledge_base_id, node.source_file_id, node.path, node.title,
           file.okf_type AS type, file.description, node.summary, node.subjects_json,
           file.tags_json, node.entities_json, node.explicit_references_json,
           '[]'::jsonb AS relationship_hints_json, node.headings_json, node.keywords_json,
           NULL::text AS language, node.metadata_json AS profile_json,
           node.metadata_json, node.updated_at
    FROM focowiki.knowledge_graph_nodes node
    JOIN focowiki.bundle_files file ON file.id = node.file_id AND file.release_id = node.release_id
    WHERE node.knowledge_base_id = ${knowledgeBaseId} AND node.release_id = ${releaseId}
  `;
}

async function listReleaseEdges(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; releaseId: string; limit: number; cursor: string | null }
) {
  const cursor = parseIdCursor(input.cursor);
  const rows = await sql<GraphEdgeRow[]>`
    ${releaseEdgeSelect(sql, input.knowledgeBaseId, input.releaseId)}
      ${cursor ? sql`AND edge.id > ${cursor}` : sql``}
    ORDER BY edge.id ASC
    LIMIT ${input.limit + 1}
  `;
  return edgePage(rows, input.limit);
}

function releaseEdgeSelect(sql: DatabaseClient, knowledgeBaseId: string, releaseId: string) {
  return sql`
    SELECT edge.id, edge.knowledge_base_id,
           from_file.source_file_id AS from_source_file_id,
           to_file.source_file_id AS to_source_file_id,
           edge.relation_type, edge.weight, edge.reason, edge.created_by AS source,
           CASE WHEN edge.quality_status = 'accepted' THEN 'accepted' ELSE 'rejected' END AS status,
           edge.evidence_json, edge.updated_at
    FROM focowiki.knowledge_graph_edges edge
    JOIN focowiki.bundle_files from_file ON from_file.id = edge.from_file_id
    JOIN focowiki.bundle_files to_file ON to_file.id = edge.to_file_id
    WHERE edge.knowledge_base_id = ${knowledgeBaseId} AND edge.release_id = ${releaseId}
      AND edge.quality_status = 'accepted'
  `;
}

async function listReleaseNeighborhood(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; releaseId: string; sourceFileId: string; limit: number; cursor?: string | null }
) {
  const cursor = parseRelationCursor(input.cursor ?? null);
  const rows = await sql<RelatedRow[]>`
    WITH source_file AS (
      SELECT id FROM focowiki.bundle_files
      WHERE knowledge_base_id = ${input.knowledgeBaseId} AND release_id = ${input.releaseId}
        AND source_file_id = ${input.sourceFileId} AND file_kind = 'page'
      LIMIT 1
    ), raw_relationships AS (
      SELECT edge.to_file_id AS file_id, edge.relation_type, 'outgoing'::text AS direction,
             edge.weight, edge.reason, edge.created_by AS source, edge.evidence_json
      FROM focowiki.knowledge_graph_edges edge
      WHERE edge.release_id = ${input.releaseId} AND edge.from_file_id IN (SELECT id FROM source_file)
        AND edge.quality_status = 'accepted'
      UNION ALL
      SELECT edge.from_file_id, edge.relation_type, 'incoming'::text, edge.weight,
             edge.reason, edge.created_by, edge.evidence_json
      FROM focowiki.knowledge_graph_edges edge
      WHERE edge.release_id = ${input.releaseId} AND edge.to_file_id IN (SELECT id FROM source_file)
        AND edge.quality_status = 'accepted'
    ), relationships AS (
      SELECT file_id, relation_type, direction, weight, reason, source, evidence_json
      FROM (
        SELECT raw_relationships.*,
               row_number() OVER (
                 PARTITION BY file_id
                 ORDER BY weight DESC,
                          CASE WHEN direction = 'outgoing' THEN 0 ELSE 1 END,
                          relation_type ASC
               ) AS relationship_rank
        FROM raw_relationships
      ) ranked
      WHERE relationship_rank = 1
    )
    SELECT file.source_file_id, file.id AS bundle_file_id, file.logical_path AS path,
           COALESCE(file.title, file.logical_path) AS title, related.relation_type,
           related.direction::text AS direction, related.weight, related.reason,
           related.source, related.evidence_json, true AS content_available
    FROM relationships related
    JOIN focowiki.bundle_files file ON file.id = related.file_id AND file.release_id = ${input.releaseId}
    WHERE file.source_file_id IS NOT NULL
      ${cursor ? sql`AND (related.weight < ${cursor.weight}
        OR (related.weight = ${cursor.weight} AND file.source_file_id > ${cursor.fileId}))` : sql``}
    ORDER BY related.weight DESC, file.source_file_id ASC
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
  return {
    fileId: row.source_file_id,
    sourceFileId: row.source_file_id,
    bundleFileId: row.bundle_file_id,
    path: row.path,
    title: row.title,
    relationType: row.relation_type,
    direction: row.direction,
    weight: Number(row.weight),
    reason: row.reason,
    source: row.source,
    evidence: evidenceRecord(row.evidence_json),
    contentAvailable: row.content_available
  };
}

function mapGraphJob(row: GraphJobRow): FileGraphJobRecord {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    sourceFileId: row.source_file_id,
    status: row.status,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at?.toISOString() ?? null,
    errorCode: row.error_code,
    createdAt: row.created_at.toISOString()
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

function requireRow<T>(row: T | undefined): T {
  if (!row) throw new Error("Graph database mutation did not return a row");
  return row;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (match) => `\\${match}`);
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
