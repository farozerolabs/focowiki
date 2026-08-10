import type { DatabaseClient } from "../../db/client.js";
import { validationError } from "../../developer-openapi/errors.js";
import type { StorageVnextOpenApiRelationship } from "./openapi-presenters.js";

export type StorageVnextGeneratedIdentity = {
  logical_path: string;
  source_file_public_id: string | null;
  object_id: string;
};

export type StorageVnextOpenApiSearchGraphContext = {
  nodePublicId: string;
  relationships: StorageVnextOpenApiRelationship[];
};

export async function findStorageVnextGeneratedIdentity(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; fileId: string }
) {
  const rows = await sql<StorageVnextGeneratedIdentity[]>`
    SELECT entry.logical_path, entry.source_file_public_id, entry.object_id
    FROM focowiki.release_roots root
    CROSS JOIN LATERAL focowiki.resolve_release_catalog(root.public_id) entry
    WHERE root.knowledge_base_id = ${input.knowledgeBaseId}
      AND root.root_role = 'active'
      AND (
        entry.source_file_public_id = ${input.fileId}
        OR entry.object_id = ${input.fileId}
        OR focowiki.public_generated_file_id(
          ${input.knowledgeBaseId},
          entry.logical_path
        ) = ${input.fileId}
      )
    ORDER BY entry.ordinal
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listStorageVnextRelationships(
  sql: DatabaseClient,
  input: {
    knowledgeBaseId: string;
    sourceFileId: string;
    limit: number;
    cursor: string | null;
  }
) {
  const cursor = decodeRelationshipCursor(input.cursor);
  const rows = await sql<StorageVnextOpenApiRelationship[]>`
    WITH seeds AS (
      SELECT public_id FROM focowiki.graph_nodes
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND source_file_public_id = ${input.sourceFileId}
    )
    SELECT edge.public_id, related.source_file_public_id, generated.logical_path,
           related.label AS title, edge.relation, edge.weight, edge.reason,
           ${input.sourceFileId}::text AS from_source_file_public_id,
           1::integer AS relationship_depth,
           CASE WHEN edge.from_node_public_id IN (SELECT public_id FROM seeds)
             THEN 'outgoing' ELSE 'incoming' END AS direction
    FROM focowiki.graph_edges edge
    JOIN focowiki.graph_nodes related
      ON related.knowledge_base_id = edge.knowledge_base_id
     AND related.public_id = CASE
       WHEN edge.from_node_public_id IN (SELECT public_id FROM seeds)
         THEN edge.to_node_public_id ELSE edge.from_node_public_id END
    JOIN focowiki.release_roots root
      ON root.knowledge_base_id = related.knowledge_base_id AND root.root_role = 'active'
    JOIN LATERAL focowiki.resolve_release_catalog(root.public_id) generated
      ON generated.source_file_public_id = related.source_file_public_id
    WHERE edge.knowledge_base_id = ${input.knowledgeBaseId}
      AND (edge.from_node_public_id IN (SELECT public_id FROM seeds)
        OR edge.to_node_public_id IN (SELECT public_id FROM seeds))
      AND (${cursor}::text IS NULL OR edge.public_id COLLATE "C" > ${cursor} COLLATE "C")
    ORDER BY edge.public_id COLLATE "C"
    LIMIT ${input.limit + 1}
  `;
  const pageRows = rows.slice(0, input.limit);
  return {
    items: pageRows,
    nextCursor: rows.length > input.limit
      ? encodeRelationshipCursor(pageRows.at(-1)!.public_id)
      : null
  };
}

export async function listStorageVnextSearchGraphContexts(
  sql: DatabaseClient,
  input: {
    knowledgeBaseId: string;
    sourceFileIds: readonly string[];
    depth: 0 | 1 | 2;
    limitPerSource: number;
    fanoutPerNode?: number;
  }
): Promise<Map<string, StorageVnextOpenApiSearchGraphContext>> {
  const sourceFileIds = [...new Set(input.sourceFileIds)];
  if (sourceFileIds.length === 0) return new Map();
  type SearchRelationshipRow = {
    seed_source_file_public_id: string;
    seed_node_public_id: string;
    relation_ordinal: number | string;
    from_source_file_public_id: string | null;
    relationship_depth: number | string;
    public_id: string | null;
    source_file_public_id: string | null;
    logical_path: string | null;
    title: string | null;
    relation: string | null;
    weight: number | string | null;
    reason: string | null;
    direction: "incoming" | "outgoing" | null;
  };
  const rows = await sql<SearchRelationshipRow[]>`
    WITH RECURSIVE seeds AS (
      SELECT node.public_id AS seed_node_public_id,
             node.source_file_public_id AS seed_source_file_public_id
      FROM focowiki.graph_nodes node
      WHERE node.knowledge_base_id = ${input.knowledgeBaseId}
        AND node.source_file_public_id = ANY(${sourceFileIds}::text[])
    ), walk AS (
      SELECT seed.seed_source_file_public_id, seed.seed_node_public_id,
             seed.seed_node_public_id AS current_node_public_id,
             seed.seed_node_public_id AS from_node_public_id,
             0::integer AS relationship_depth,
             ARRAY[seed.seed_node_public_id]::text[] AS visited_node_public_ids,
             NULL::text AS public_id, NULL::text AS relation,
             NULL::double precision AS weight, NULL::text AS reason,
             NULL::text AS direction
      FROM seeds seed
      UNION ALL
      SELECT walk.seed_source_file_public_id, walk.seed_node_public_id,
             step.next_node_public_id, walk.current_node_public_id,
             walk.relationship_depth + 1,
             walk.visited_node_public_ids || step.next_node_public_id,
             step.public_id, step.relation, step.weight, step.reason,
             step.direction
      FROM walk
      CROSS JOIN LATERAL (
        SELECT edge.public_id, edge.relation, edge.weight, edge.reason,
               CASE WHEN edge.from_node_public_id = walk.current_node_public_id
                 THEN edge.to_node_public_id ELSE edge.from_node_public_id
               END AS next_node_public_id,
               CASE WHEN edge.from_node_public_id = walk.current_node_public_id
                 THEN 'outgoing' ELSE 'incoming' END AS direction
        FROM focowiki.graph_edges edge
        WHERE edge.knowledge_base_id = ${input.knowledgeBaseId}
          AND (edge.from_node_public_id = walk.current_node_public_id
            OR edge.to_node_public_id = walk.current_node_public_id)
          AND NOT (CASE
            WHEN edge.from_node_public_id = walk.current_node_public_id
              THEN edge.to_node_public_id ELSE edge.from_node_public_id
          END = ANY(walk.visited_node_public_ids))
        ORDER BY edge.public_id COLLATE "C"
        LIMIT ${input.fanoutPerNode ?? input.limitPerSource}
      ) step
      WHERE walk.relationship_depth < ${input.depth}
    ), ranked AS (
      SELECT walk.seed_source_file_public_id, walk.seed_node_public_id,
             origin.source_file_public_id AS from_source_file_public_id,
             walk.relationship_depth, walk.public_id,
             related.source_file_public_id,
             related.logical_path, related.label AS title,
             walk.relation, walk.weight, walk.reason, walk.direction,
             row_number() OVER (
               PARTITION BY walk.seed_source_file_public_id
               ORDER BY walk.relationship_depth, walk.public_id COLLATE "C"
             ) AS relation_ordinal
      FROM walk
      JOIN focowiki.graph_nodes origin
        ON origin.knowledge_base_id = ${input.knowledgeBaseId}
       AND origin.public_id = walk.from_node_public_id
      JOIN focowiki.graph_nodes related
        ON related.knowledge_base_id = ${input.knowledgeBaseId}
       AND related.public_id = walk.current_node_public_id
      WHERE walk.public_id IS NOT NULL
    )
    SELECT seed.seed_source_file_public_id, seed.seed_node_public_id,
           ranked.from_source_file_public_id, ranked.relationship_depth,
           coalesce(ranked.relation_ordinal, 0) AS relation_ordinal,
           ranked.public_id, ranked.source_file_public_id, ranked.logical_path,
           ranked.title, ranked.relation, ranked.weight, ranked.reason,
           ranked.direction
    FROM seeds seed
    LEFT JOIN ranked
      ON ranked.seed_source_file_public_id = seed.seed_source_file_public_id
     AND ranked.relation_ordinal <= ${input.limitPerSource}
    ORDER BY seed.seed_source_file_public_id COLLATE "C",
             ranked.relationship_depth, ranked.public_id COLLATE "C"
  `;
  const contexts = new Map<string, StorageVnextOpenApiSearchGraphContext>();
  for (const row of rows) {
    const context = contexts.get(row.seed_source_file_public_id) ?? {
      nodePublicId: row.seed_node_public_id,
      relationships: []
    };
    contexts.set(row.seed_source_file_public_id, context);
    if (
      row.public_id
      && row.source_file_public_id
      && row.logical_path
      && row.title
      && row.relation
      && row.weight !== null
      && row.direction
      && row.from_source_file_public_id
      && Number(row.relationship_depth) <= input.depth
    ) {
      context.relationships.push({
        public_id: row.public_id,
        source_file_public_id: row.source_file_public_id,
        logical_path: row.logical_path,
        title: row.title,
        relation: row.relation,
        weight: row.weight,
        reason: row.reason,
        direction: row.direction,
        from_source_file_public_id: row.from_source_file_public_id,
        relationship_depth: row.relationship_depth
      });
    }
  }
  return contexts;
}

export async function listStorageVnextGraphExpansionRelationships(
  sql: DatabaseClient,
  input: {
    knowledgeBaseId: string;
    sourceFileId: string;
    depth: 0 | 1 | 2;
    fanout: number;
    limit: number;
    cursor: string | null;
  }
) {
  const offset = decodeGraphExpansionCursor(input.cursor, input);
  const contexts = await listStorageVnextSearchGraphContexts(sql, {
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileIds: [input.sourceFileId],
    depth: input.depth,
    fanoutPerNode: input.fanout,
    limitPerSource: offset + input.limit + 1
  });
  const relationships = contexts.get(input.sourceFileId)?.relationships ?? [];
  const items = relationships.slice(offset, offset + input.limit);
  return {
    items,
    nextCursor: relationships.length > offset + input.limit
      ? encodeGraphExpansionCursor(input, offset + items.length)
      : null
  };
}

export async function readStorageVnextGraphSearchSummary(
  sql: DatabaseClient,
  knowledgeBaseId: string
) {
  const rows = await sql<Array<{
    indexed_document_count: number | string;
    indexed_relationship_count: number | string;
  }>>`
    SELECT
      (SELECT count(*) FROM focowiki.graph_nodes
       WHERE knowledge_base_id = ${knowledgeBaseId}) AS indexed_document_count,
      (SELECT count(*) FROM focowiki.graph_edges
       WHERE knowledge_base_id = ${knowledgeBaseId}) AS indexed_relationship_count
  `;
  return {
    indexedDocumentCount: safeCount(rows[0]?.indexed_document_count ?? 0),
    indexedRelationshipCount: safeCount(rows[0]?.indexed_relationship_count ?? 0)
  };
}

function safeCount(value: number | string): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function encodeGraphExpansionCursor(
  input: {
    knowledgeBaseId: string;
    sourceFileId: string;
    depth: 0 | 1 | 2;
    fanout: number;
  },
  offset: number
) {
  return Buffer.from(JSON.stringify({
    version: 1,
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.sourceFileId,
    depth: input.depth,
    fanout: input.fanout,
    offset
  }), "utf8").toString("base64url");
}

function decodeGraphExpansionCursor(
  cursor: string | null,
  input: {
    knowledgeBaseId: string;
    sourceFileId: string;
    depth: 0 | 1 | 2;
    fanout: number;
  }
) {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      version?: unknown;
      knowledgeBaseId?: unknown;
      sourceFileId?: unknown;
      depth?: unknown;
      fanout?: unknown;
      offset?: unknown;
    };
    if (
      value.version !== 1
      || value.knowledgeBaseId !== input.knowledgeBaseId
      || value.sourceFileId !== input.sourceFileId
      || value.depth !== input.depth
      || value.fanout !== input.fanout
      || !Number.isSafeInteger(value.offset)
      || Number(value.offset) < 1
      || Number(value.offset) > 1_000
    ) throw new Error("invalid");
    return Number(value.offset);
  } catch {
    throw validationError("Pagination cursor is invalid.", { field: "cursor" });
  }
}

export async function resolveStorageVnextGraphSeed(
  sql: DatabaseClient,
  input: {
    knowledgeBaseId: string;
    fileId: string | null;
    nodeId: string | null;
    edgeId: string | null;
    query: string | null;
  }
) {
  if (input.fileId) return { sourceFileId: input.fileId };
  const normalizedQuery = input.query?.trim() || null;
  const rows = await sql<Array<{ source_file_public_id: string }>>`
    SELECT node.source_file_public_id
    FROM focowiki.graph_nodes node
    LEFT JOIN focowiki.graph_edges edge
      ON edge.knowledge_base_id = node.knowledge_base_id
     AND (edge.from_node_public_id = node.public_id OR edge.to_node_public_id = node.public_id)
    WHERE node.knowledge_base_id = ${input.knowledgeBaseId}
      AND (${input.nodeId}::text IS NULL OR node.public_id = ${input.nodeId})
      AND (${input.edgeId}::text IS NULL OR edge.public_id = ${input.edgeId})
      AND (${normalizedQuery}::text IS NULL OR strpos(
        lower(node.label || ' ' || node.logical_path), lower(${normalizedQuery})
      ) > 0)
    ORDER BY node.public_id
    LIMIT 1
  `;
  return rows[0] ? { sourceFileId: rows[0].source_file_public_id } : null;
}

function encodeRelationshipCursor(publicId: string) {
  return Buffer.from(JSON.stringify({ version: 1, publicId })).toString("base64url");
}

function decodeRelationshipCursor(cursor: string | null) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      version?: number;
      publicId?: string;
    };
    if (value.version !== 1 || typeof value.publicId !== "string" || !value.publicId) {
      throw new Error("invalid");
    }
    return value.publicId;
  } catch {
    throw validationError("Pagination cursor is invalid.", { field: "cursor" });
  }
}
