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

const MAX_RELATION_KINDS_PER_TARGET = 2;

export async function findStorageVnextGeneratedIdentity(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; fileId: string }
) {
  const rows = await sql<StorageVnextGeneratedIdentity[]>`
    SELECT page.logical_path, page.source_file_public_id, page.object_id
    FROM focowiki.generated_page_heads page
    LEFT JOIN focowiki.source_file_active_revisions active
      ON active.knowledge_base_id = page.knowledge_base_id
     AND active.source_file_public_id = page.source_file_public_id
    WHERE page.knowledge_base_id = ${input.knowledgeBaseId}
      AND (page.source_file_public_id IS NULL
        OR active.active_source_revision_public_id = page.source_revision_public_id)
      AND (
        page.source_file_public_id = ${input.fileId}
        OR page.object_id = ${input.fileId}
        OR focowiki.public_generated_file_id(
          ${input.knowledgeBaseId},
          page.logical_path
        ) = ${input.fileId}
      )
    ORDER BY page.logical_path COLLATE "C"
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
  const cursor = decodeRelationshipCursor(input.cursor, input);
  const rawLimit = input.limit * MAX_RELATION_KINDS_PER_TARGET + 1;
  const rows = await sql<StorageVnextOpenApiRelationship[]>`
    WITH eligible AS MATERIALIZED (
      SELECT relation.public_id,
             CASE WHEN relation.first_source_file_public_id = ${input.sourceFileId}
               THEN relation.second_source_file_public_id
               ELSE relation.first_source_file_public_id END AS source_file_public_id,
             relation.relation_kind AS relation,
             page.logical_path, presentation.title,
             CASE
               WHEN relation.direction = 'bidirectional' THEN true
               WHEN relation.direction = 'first_to_second'
                 THEN relation.first_source_file_public_id = ${input.sourceFileId}
               ELSE relation.second_source_file_public_id = ${input.sourceFileId}
             END AS has_outgoing,
             CASE
               WHEN relation.direction = 'bidirectional' THEN true
               WHEN relation.direction = 'first_to_second'
                 THEN relation.second_source_file_public_id = ${input.sourceFileId}
               ELSE relation.first_source_file_public_id = ${input.sourceFileId}
             END AS has_incoming,
             max(evidence.evidence->>'reason') AS reason
      FROM focowiki.canonical_file_relations relation
      JOIN focowiki.relation_directed_evidence evidence
        ON evidence.knowledge_base_id = relation.knowledge_base_id
       AND evidence.pair_public_id = relation.pair_public_id
       AND evidence.active AND evidence.retired_at IS NULL
      JOIN focowiki.source_file_active_revisions first_active
        ON first_active.knowledge_base_id = relation.knowledge_base_id
       AND first_active.source_file_public_id
         = relation.first_source_file_public_id
       AND first_active.active_source_revision_public_id
         = relation.first_source_revision_public_id
      JOIN focowiki.source_file_active_revisions second_active
        ON second_active.knowledge_base_id = relation.knowledge_base_id
       AND second_active.source_file_public_id
         = relation.second_source_file_public_id
       AND second_active.active_source_revision_public_id
         = relation.second_source_revision_public_id
      JOIN focowiki.source_file_active_revisions active
        ON active.knowledge_base_id = relation.knowledge_base_id
       AND active.source_file_public_id = CASE
         WHEN relation.first_source_file_public_id = ${input.sourceFileId}
           THEN relation.second_source_file_public_id
         ELSE relation.first_source_file_public_id END
       AND active.active_source_revision_public_id IS NOT NULL
      JOIN focowiki.source_revision_presentations presentation
        ON presentation.knowledge_base_id = active.knowledge_base_id
       AND presentation.source_file_public_id = active.source_file_public_id
       AND presentation.source_revision_public_id
         = active.active_source_revision_public_id
      JOIN focowiki.generated_page_heads page
        ON page.knowledge_base_id = active.knowledge_base_id
       AND page.source_file_public_id = active.source_file_public_id
       AND page.source_revision_public_id = active.active_source_revision_public_id
       AND page.entry_kind = 'source'
      WHERE relation.knowledge_base_id = ${input.knowledgeBaseId}
        AND relation.active AND relation.retired_at IS NULL
        AND (${input.sourceFileId} IN (
          relation.first_source_file_public_id,
          relation.second_source_file_public_id
        ))
        AND (${cursor}::text IS NULL OR (CASE
          WHEN relation.first_source_file_public_id = ${input.sourceFileId}
            THEN relation.second_source_file_public_id
          ELSE relation.first_source_file_public_id
        END) COLLATE "C" > ${cursor} COLLATE "C")
      GROUP BY relation.public_id, relation.first_source_file_public_id,
               relation.second_source_file_public_id, relation.relation_kind,
               relation.direction,
               page.logical_path, presentation.title
      ORDER BY (CASE
        WHEN relation.first_source_file_public_id = ${input.sourceFileId}
          THEN relation.second_source_file_public_id
        ELSE relation.first_source_file_public_id
      END) COLLATE "C",
               relation.public_id COLLATE "C"
      LIMIT ${rawLimit}
    )
    SELECT eligible.public_id, eligible.source_file_public_id,
           eligible.logical_path, eligible.title,
           eligible.relation, 1::double precision AS weight,
           eligible.reason,
           ${input.sourceFileId}::text AS from_source_file_public_id,
           1::integer AS relationship_depth,
           CASE WHEN eligible.has_outgoing AND eligible.has_incoming
             THEN 'bidirectional'
             WHEN eligible.has_outgoing THEN 'outgoing'
             ELSE 'incoming' END AS direction
    FROM eligible
    ORDER BY eligible.source_file_public_id COLLATE "C",
             eligible.public_id COLLATE "C"
  `;
  const collapsed = collapseStorageVnextRelationships(rows);
  const pageRows = collapsed.slice(0, input.limit);
  return {
    items: pageRows,
    nextCursor: collapsed.length > input.limit
      ? encodeRelationshipCursor({
          knowledgeBaseId: input.knowledgeBaseId,
          sourceFileId: input.sourceFileId,
          targetSourceFileId: pageRows.at(-1)!.source_file_public_id
        })
      : null
  };
}

export function collapseStorageVnextRelationships(
  rows: readonly StorageVnextOpenApiRelationship[]
): StorageVnextOpenApiRelationship[] {
  const grouped = new Map<string, {
    selected: StorageVnextOpenApiRelationship;
    directions: Set<"incoming" | "outgoing">;
  }>();
  for (const row of rows) {
    const current = grouped.get(row.source_file_public_id);
    const directions = current?.directions ?? new Set<"incoming" | "outgoing">();
    if (row.direction === "bidirectional") {
      directions.add("incoming");
      directions.add("outgoing");
    } else {
      directions.add(row.direction);
    }
    const selected = !current || relationshipPresentationPriority(row)
      > relationshipPresentationPriority(current.selected)
      ? row
      : current.selected;
    grouped.set(row.source_file_public_id, { selected, directions });
  }
  return [...grouped.values()].map(({ selected, directions }) => ({
    ...selected,
    direction: directions.size === 2
      ? "bidirectional"
      : directions.has("outgoing") ? "outgoing" : "incoming"
  }));
}

function relationshipPresentationPriority(row: StorageVnextOpenApiRelationship) {
  return row.relation === "related" ? 2 : 1;
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
    direction: "incoming" | "outgoing" | "bidirectional" | null;
  };
  const rows = await sql<SearchRelationshipRow[]>`
    WITH RECURSIVE seeds AS (
      SELECT active.source_file_public_id AS seed_node_public_id,
             active.source_file_public_id AS seed_source_file_public_id
      FROM focowiki.source_file_active_revisions active
      JOIN focowiki.generated_page_heads page
        ON page.knowledge_base_id = active.knowledge_base_id
       AND page.source_file_public_id = active.source_file_public_id
       AND page.source_revision_public_id = active.active_source_revision_public_id
       AND page.entry_kind = 'source'
      WHERE active.knowledge_base_id = ${input.knowledgeBaseId}
        AND active.active_source_revision_public_id IS NOT NULL
        AND active.source_file_public_id = ANY(${sourceFileIds}::text[])
    ), walk AS (
      SELECT seed.seed_source_file_public_id, seed.seed_node_public_id,
             seed.seed_source_file_public_id AS current_source_file_public_id,
             seed.seed_source_file_public_id AS from_source_file_public_id,
             0::integer AS relationship_depth,
             ARRAY[seed.seed_source_file_public_id]::text[]
               AS visited_source_file_public_ids,
             NULL::text AS public_id, NULL::text AS relation,
             NULL::double precision AS weight, NULL::text AS reason,
             NULL::text AS direction
      FROM seeds seed
      UNION ALL
      SELECT walk.seed_source_file_public_id, walk.seed_node_public_id,
             step.next_source_file_public_id,
             walk.current_source_file_public_id,
             walk.relationship_depth + 1,
             walk.visited_source_file_public_ids || step.next_source_file_public_id,
             step.public_id, step.relation, step.weight, step.reason,
             step.direction
      FROM walk
      CROSS JOIN LATERAL (
        SELECT relation.public_id, relation.relation_kind AS relation,
               1::double precision AS weight,
               max(evidence.evidence->>'reason') AS reason,
               CASE
                 WHEN relation.first_source_file_public_id
                   = walk.current_source_file_public_id
                   THEN relation.second_source_file_public_id
                 ELSE relation.first_source_file_public_id
               END AS next_source_file_public_id,
               CASE
                 WHEN relation.direction = 'bidirectional' THEN 'bidirectional'
                 WHEN relation.direction = 'first_to_second'
                   AND relation.first_source_file_public_id
                     = walk.current_source_file_public_id
                   THEN 'outgoing'
                 WHEN relation.direction = 'second_to_first'
                   AND relation.second_source_file_public_id
                     = walk.current_source_file_public_id
                   THEN 'outgoing'
                 ELSE 'incoming'
               END AS direction
        FROM focowiki.canonical_file_relations relation
        JOIN focowiki.relation_directed_evidence evidence
          ON evidence.knowledge_base_id = relation.knowledge_base_id
         AND evidence.pair_public_id = relation.pair_public_id
         AND evidence.active AND evidence.retired_at IS NULL
        JOIN focowiki.source_file_active_revisions first_active
          ON first_active.knowledge_base_id = relation.knowledge_base_id
         AND first_active.source_file_public_id
           = relation.first_source_file_public_id
         AND first_active.active_source_revision_public_id
           = relation.first_source_revision_public_id
        JOIN focowiki.source_file_active_revisions second_active
          ON second_active.knowledge_base_id = relation.knowledge_base_id
         AND second_active.source_file_public_id
           = relation.second_source_file_public_id
         AND second_active.active_source_revision_public_id
           = relation.second_source_revision_public_id
        JOIN focowiki.source_file_active_revisions target
          ON target.knowledge_base_id = relation.knowledge_base_id
         AND target.source_file_public_id = CASE
           WHEN relation.first_source_file_public_id
             = walk.current_source_file_public_id
             THEN relation.second_source_file_public_id
           ELSE relation.first_source_file_public_id END
         AND target.active_source_revision_public_id IS NOT NULL
        JOIN focowiki.generated_page_heads target_page
          ON target_page.knowledge_base_id = target.knowledge_base_id
         AND target_page.source_file_public_id = target.source_file_public_id
         AND target_page.source_revision_public_id
           = target.active_source_revision_public_id
         AND target_page.entry_kind = 'source'
        WHERE relation.knowledge_base_id = ${input.knowledgeBaseId}
          AND relation.active AND relation.retired_at IS NULL
          AND (relation.first_source_file_public_id
            = walk.current_source_file_public_id
            OR relation.second_source_file_public_id
              = walk.current_source_file_public_id)
          AND NOT (CASE
            WHEN relation.first_source_file_public_id
              = walk.current_source_file_public_id
              THEN relation.second_source_file_public_id
            ELSE relation.first_source_file_public_id
          END = ANY(walk.visited_source_file_public_ids))
        GROUP BY relation.public_id, relation.relation_kind,
                 relation.first_source_file_public_id,
                 relation.second_source_file_public_id,
                 relation.direction
        ORDER BY relation.public_id COLLATE "C"
        LIMIT ${input.fanoutPerNode ?? input.limitPerSource}
      ) step
      WHERE walk.relationship_depth < ${input.depth}
    ), ranked AS (
      SELECT walk.seed_source_file_public_id, walk.seed_node_public_id,
             walk.from_source_file_public_id,
             walk.relationship_depth, walk.public_id,
             active.source_file_public_id,
             page.logical_path, presentation.title,
             walk.relation, walk.weight, walk.reason, walk.direction,
             row_number() OVER (
               PARTITION BY walk.seed_source_file_public_id
               ORDER BY walk.relationship_depth, walk.public_id COLLATE "C"
             ) AS relation_ordinal
      FROM walk
      JOIN focowiki.source_file_active_revisions active
        ON active.knowledge_base_id = ${input.knowledgeBaseId}
       AND active.source_file_public_id = walk.current_source_file_public_id
       AND active.active_source_revision_public_id IS NOT NULL
      JOIN focowiki.source_revision_presentations presentation
        ON presentation.knowledge_base_id = active.knowledge_base_id
       AND presentation.source_file_public_id = active.source_file_public_id
       AND presentation.source_revision_public_id
         = active.active_source_revision_public_id
      JOIN focowiki.generated_page_heads page
        ON page.knowledge_base_id = active.knowledge_base_id
       AND page.source_file_public_id = active.source_file_public_id
       AND page.source_revision_public_id = active.active_source_revision_public_id
       AND page.entry_kind = 'source'
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
    WITH active_sources AS MATERIALIZED (
      SELECT active.source_file_public_id
      FROM focowiki.source_file_active_revisions active
      JOIN focowiki.generated_page_heads page
        ON page.knowledge_base_id = active.knowledge_base_id
       AND page.source_file_public_id = active.source_file_public_id
       AND page.source_revision_public_id = active.active_source_revision_public_id
       AND page.entry_kind = 'source'
      WHERE active.knowledge_base_id = ${knowledgeBaseId}
        AND active.active_source_revision_public_id IS NOT NULL
    )
    SELECT
      (SELECT count(*) FROM active_sources) AS indexed_document_count,
      (SELECT count(*) FROM focowiki.canonical_file_relations relation
       WHERE relation.knowledge_base_id = ${knowledgeBaseId}
         AND relation.active AND relation.retired_at IS NULL
         AND relation.first_source_file_public_id IN (
           SELECT source_file_public_id FROM active_sources
         )
         AND relation.second_source_file_public_id IN (
           SELECT source_file_public_id FROM active_sources
         )
         AND EXISTS (
           SELECT 1 FROM focowiki.relation_directed_evidence evidence
           WHERE evidence.knowledge_base_id = relation.knowledge_base_id
             AND evidence.pair_public_id = relation.pair_public_id
             AND evidence.active AND evidence.retired_at IS NULL
         )
      ) AS indexed_relationship_count
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
    fileId: string;
  }
) {
  const identity = await findStorageVnextGeneratedIdentity(sql, input);
  return identity?.source_file_public_id
    ? { sourceFileId: identity.source_file_public_id }
    : null;
}

export function encodeRelationshipCursor(input: {
  knowledgeBaseId: string;
  sourceFileId: string;
  targetSourceFileId: string;
}) {
  return Buffer.from(JSON.stringify({
    version: 3,
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.sourceFileId,
    targetSourceFileId: input.targetSourceFileId
  })).toString("base64url");
}

export function decodeRelationshipCursor(
  cursor: string | null,
  input: { knowledgeBaseId: string; sourceFileId: string }
) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      version?: number;
      knowledgeBaseId?: string;
      sourceFileId?: string;
      targetSourceFileId?: string;
    };
    if (value.version !== 3
      || value.knowledgeBaseId !== input.knowledgeBaseId
      || value.sourceFileId !== input.sourceFileId
      || typeof value.targetSourceFileId !== "string"
      || !value.targetSourceFileId) {
      throw new Error("invalid");
    }
    return value.targetSourceFileId;
  } catch {
    throw validationError("Pagination cursor is invalid.", { field: "cursor" });
  }
}
