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
      AND (entry.source_file_public_id = ${input.fileId} OR entry.object_id = ${input.fileId})
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
    limitPerSource: number;
  }
): Promise<Map<string, StorageVnextOpenApiSearchGraphContext>> {
  const sourceFileIds = [...new Set(input.sourceFileIds)];
  if (sourceFileIds.length === 0) return new Map();
  type SearchRelationshipRow = {
    seed_source_file_public_id: string;
    seed_node_public_id: string;
    relation_ordinal: number | string;
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
    WITH seeds AS (
      SELECT node.public_id AS seed_node_public_id,
             node.source_file_public_id AS seed_source_file_public_id
      FROM focowiki.graph_nodes node
      WHERE node.knowledge_base_id = ${input.knowledgeBaseId}
        AND node.source_file_public_id = ANY(${sourceFileIds}::text[])
    ), ranked AS (
      SELECT seed.seed_source_file_public_id, seed.seed_node_public_id,
             edge.public_id, related.source_file_public_id,
             related.logical_path, related.label AS title,
             edge.relation, edge.weight, edge.reason,
             CASE WHEN edge.from_node_public_id = seed.seed_node_public_id
               THEN 'outgoing' ELSE 'incoming' END AS direction,
             row_number() OVER (
               PARTITION BY seed.seed_source_file_public_id
               ORDER BY edge.public_id COLLATE "C"
             ) AS relation_ordinal
      FROM seeds seed
      LEFT JOIN focowiki.graph_edges edge
        ON edge.knowledge_base_id = ${input.knowledgeBaseId}
       AND (edge.from_node_public_id = seed.seed_node_public_id
         OR edge.to_node_public_id = seed.seed_node_public_id)
      LEFT JOIN focowiki.graph_nodes related
        ON related.knowledge_base_id = ${input.knowledgeBaseId}
       AND related.public_id = CASE
         WHEN edge.from_node_public_id = seed.seed_node_public_id
           THEN edge.to_node_public_id ELSE edge.from_node_public_id END
    )
    SELECT * FROM ranked
    WHERE public_id IS NULL OR relation_ordinal <= ${input.limitPerSource}
    ORDER BY seed_source_file_public_id COLLATE "C", public_id COLLATE "C"
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
    ) {
      context.relationships.push({
        public_id: row.public_id,
        source_file_public_id: row.source_file_public_id,
        logical_path: row.logical_path,
        title: row.title,
        relation: row.relation,
        weight: row.weight,
        reason: row.reason,
        direction: row.direction
      });
    }
  }
  return contexts;
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
