import type {
  ActiveGenerationFile,
  ActiveGenerationPage,
  ActiveGenerationProjection,
  ActiveGenerationReadRepository,
  ActiveGenerationReadScope,
  ActiveGenerationScoredCursor
} from "../../application/ports/active-generation-read-repository.js";
import type { SerializableJson } from "../../application/ports/source-dispatch-repository.js";
import type { DatabaseClient } from "../../db/client.js";
import {
  listActiveTree,
  listActiveTreeAncestors
} from "./active-tree-read-model.js";
import type { TransactionSql } from "postgres";

type ReadSql = DatabaseClient | TransactionSql;

type FileRow = {
  file_id: string;
  ref_kind: string;
  ref_key: string;
  last_changed_generation_id: string;
  logical_path: string;
  source_file_id: string | null;
  object_key: string;
  content_type: string;
  size_bytes: number;
  checksum_sha256: string;
  title: string | null;
  summary: string | null;
  payload_json: SerializableJson | null;
};

type ProjectionRow = {
  projection_kind: string;
  record_id: string;
  source_file_id: string | null;
  related_source_file_id: string | null;
  logical_path: string | null;
  parent_path: string | null;
  sort_key: string | null;
  title: string | null;
  summary: string | null;
  score: number | null;
  payload_json: SerializableJson;
};

type RelatedProjectionRow = ProjectionRow & {
  seed_source_file_id: string;
};

export function createPostgresActiveGenerationReadRepository(
  sql: DatabaseClient
): ActiveGenerationReadRepository {
  async function withActiveGeneration<T>(
    knowledgeBaseId: string,
    reader: (scope: ActiveGenerationReadScope) => Promise<T>
  ): Promise<T | null> {
    const result = await sql.begin("isolation level repeatable read read only", async (transaction) => {
      const rows = await transaction<Array<{ active_generation_id: string | null }>>`
        SELECT active_generation_id
        FROM focowiki.knowledge_bases
        WHERE id = ${knowledgeBaseId}
          AND deleted_at IS NULL
        LIMIT 1
      `;
      const generationId = rows[0]?.active_generation_id;
      if (!generationId) return null;
      return reader(createScope(transaction, knowledgeBaseId, generationId));
    });
    return result as T | null;
  }
  return {
    withActiveGeneration
  };
}

function createScope(
  sql: ReadSql,
  knowledgeBaseId: string,
  generationId: string
): ActiveGenerationReadScope {
  return {
    knowledgeBaseId,
    generationId,

    async findFileById(fileId) {
      const rows = await selectFile(sql, knowledgeBaseId, { fileId, path: null });
      return rows[0] ? mapFile(generationId, rows[0]) : null;
    },

    async findFileByPath(path) {
      const rows = await selectFile(sql, knowledgeBaseId, { fileId: null, path });
      return rows[0] ? mapFile(generationId, rows[0]) : null;
    },

    async findFilesBySourceIds(sourceFileIds) {
      const uniqueIds = [...new Set(sourceFileIds)];
      if (uniqueIds.length === 0) return [];
      const rows = await selectFilesBySourceIds(sql, knowledgeBaseId, uniqueIds);
      return rows.map((row) => mapFile(generationId, row));
    },

    async findProjection(input) {
      const rows = await sql<ProjectionRow[]>`
        SELECT projection_kind, record_id, source_file_id,
               related_source_file_id, logical_path, parent_path, sort_key,
               title, summary, NULL::real AS score, payload_json
        FROM focowiki.active_projection_records
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND projection_kind = ${input.projectionKind}
          AND record_id = ${input.recordId}
          AND (
            source_file_id IS NULL OR EXISTS (
              SELECT 1 FROM focowiki.source_files source
              WHERE source.id = source_file_id
                AND source.knowledge_base_id = ${knowledgeBaseId}
                AND source.deleted_at IS NULL
                AND source.deletion_intent_id IS NULL
            )
          )
          AND (
            related_source_file_id IS NULL OR EXISTS (
              SELECT 1 FROM focowiki.source_files related
              WHERE related.id = related_source_file_id
                AND related.knowledge_base_id = ${knowledgeBaseId}
                AND related.deleted_at IS NULL
                AND related.deletion_intent_id IS NULL
            )
          )
        LIMIT 1
      `;
      return rows[0] ? mapProjection(generationId, rows[0]) : null;
    },

    async getGraphSummary() {
      const persisted = await sql<Array<{
        node_count: number;
        edge_count: number;
        graph_index_available: boolean;
      }>>`
        SELECT node_count, edge_count, graph_index_available
        FROM focowiki.generation_graph_summaries
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND generation_id = ${generationId}
        LIMIT 1
      `;
      if (persisted[0]) {
        return {
          nodeCount: Number(persisted[0].node_count),
          edgeCount: Number(persisted[0].edge_count),
          graphIndexAvailable: persisted[0].graph_index_available,
          persisted: true
        };
      }
      const compatibility = await sql<Array<{
        node_count: number;
        edge_count: number;
        graph_index_available: boolean;
      }>>`
        SELECT
          count(*) FILTER (WHERE projection_kind = 'graph_node')::int AS node_count,
          count(*) FILTER (WHERE projection_kind = 'graph_edge')::int AS edge_count,
          EXISTS (
            SELECT 1 FROM focowiki.active_object_refs reference
            WHERE reference.knowledge_base_id = ${knowledgeBaseId}
              AND reference.logical_path = '_graph/index.md'
          ) AS graph_index_available
        FROM focowiki.active_projection_records
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND projection_kind IN ('graph_node', 'graph_edge')
      `;
      return {
        nodeCount: Number(compatibility[0]?.node_count ?? 0),
        edgeCount: Number(compatibility[0]?.edge_count ?? 0),
        graphIndexAvailable: compatibility[0]?.graph_index_available ?? false,
        persisted: false
      };
    },

    async listTree(input) {
      assertLimit(input.limit);
      return listActiveTree(sql, knowledgeBaseId, generationId, input);
    },

    async listTreeAncestors(paths) {
      return listActiveTreeAncestors(sql, knowledgeBaseId, generationId, paths);
    },

    async search(input) {
      assertLimit(input.limit);
      const query = input.query.trim();
      if (!query) return { items: [], nextCursor: null };
      const pattern = `%${escapeLikePattern(query)}%`;
      const rows = await sql<ProjectionRow[]>`
        WITH raw_candidates AS (
          SELECT record.projection_kind, record.record_id,
                 record.source_file_id, record.related_source_file_id,
                 file.logical_path, record.parent_path, record.sort_key,
                 record.title, record.summary, record.searchable_text,
                 record.payload_json || jsonb_build_object(
                   'fileId', file.file_id,
                   'path', file.logical_path,
                   'matchType', 'file_direct'
                 ) AS payload_json
          FROM focowiki.active_projection_records record
          JOIN focowiki.active_object_refs file
            ON file.knowledge_base_id = record.knowledge_base_id
           AND file.source_file_id = record.source_file_id
           AND file.ref_kind = 'page'
          JOIN focowiki.source_files source
            ON source.id = record.source_file_id
           AND source.knowledge_base_id = record.knowledge_base_id
           AND source.deleted_at IS NULL
           AND source.deletion_intent_id IS NULL
          WHERE record.knowledge_base_id = ${knowledgeBaseId}
            AND record.projection_kind = 'search'
            AND ${input.mode} IN ('file', 'hybrid')
          UNION ALL
          SELECT record.projection_kind, record.record_id,
                 record.source_file_id, record.related_source_file_id,
                 file.logical_path, record.parent_path, record.sort_key,
                 record.title, record.summary, record.searchable_text,
                 record.payload_json || jsonb_build_object(
                   'fileId', file.file_id,
                   'path', file.logical_path,
                   'matchType', 'graph_node'
                 ) AS payload_json
          FROM focowiki.active_projection_records record
          JOIN focowiki.active_object_refs file
            ON file.knowledge_base_id = record.knowledge_base_id
           AND file.source_file_id = record.source_file_id
           AND file.ref_kind = 'page'
          JOIN focowiki.source_files source
            ON source.id = record.source_file_id
           AND source.knowledge_base_id = record.knowledge_base_id
           AND source.deleted_at IS NULL
           AND source.deletion_intent_id IS NULL
          WHERE record.knowledge_base_id = ${knowledgeBaseId}
            AND record.projection_kind = 'graph_node'
            AND ${input.mode} IN ('graph', 'hybrid')
          UNION ALL
          SELECT record.projection_kind,
                 candidate.source_file_id AS record_id,
                 candidate.source_file_id,
                 candidate.related_source_file_id,
                 file.logical_path, NULL::text AS parent_path,
                 file.logical_path AS sort_key, candidate.title,
                 record.summary, record.searchable_text,
                 record.payload_json || jsonb_build_object(
                   'fileId', file.file_id,
                   'path', file.logical_path,
                   'matchType', 'graph_edge',
                   'graphEdgeId', record.record_id
                 ) AS payload_json
          FROM focowiki.active_projection_records record
          CROSS JOIN LATERAL (
            VALUES
              (record.source_file_id, record.related_source_file_id, record.payload_json->>'fromTitle'),
              (record.related_source_file_id, record.source_file_id, record.payload_json->>'toTitle')
          ) AS candidate(source_file_id, related_source_file_id, title)
          JOIN focowiki.active_object_refs file
            ON file.knowledge_base_id = record.knowledge_base_id
           AND file.source_file_id = candidate.source_file_id
           AND file.ref_kind = 'page'
          JOIN focowiki.source_files source
            ON source.id = candidate.source_file_id
           AND source.knowledge_base_id = record.knowledge_base_id
           AND source.deleted_at IS NULL
           AND source.deletion_intent_id IS NULL
          JOIN focowiki.source_files related
            ON related.id = candidate.related_source_file_id
           AND related.knowledge_base_id = record.knowledge_base_id
           AND related.deleted_at IS NULL
           AND related.deletion_intent_id IS NULL
          WHERE record.knowledge_base_id = ${knowledgeBaseId}
            AND record.projection_kind = 'graph_edge'
            AND candidate.source_file_id IS NOT NULL
            AND ${input.mode} IN ('graph', 'hybrid')
        ), matched AS (
          SELECT *, (
            CASE WHEN lower(coalesce(title, '')) = lower(${query}) THEN 100 ELSE 0 END
            + CASE WHEN coalesce(title, '') ILIKE ${pattern} ESCAPE '\\' THEN 40 ELSE 0 END
            + CASE WHEN coalesce(logical_path, '') ILIKE ${pattern} ESCAPE '\\' THEN 20 ELSE 0 END
            + ts_rank_cd(
                to_tsvector('simple', coalesce(searchable_text, '')),
                plainto_tsquery('simple', ${query})
              ) * 10
            + similarity(lower(coalesce(searchable_text, '')), lower(${query}))
          )::real AS score
          FROM raw_candidates
          WHERE to_tsvector('simple', coalesce(searchable_text, '')) @@ plainto_tsquery('simple', ${query})
             OR coalesce(searchable_text, '') ILIKE ${pattern} ESCAPE '\\'
             OR coalesce(title, '') ILIKE ${pattern} ESCAPE '\\'
             OR coalesce(logical_path, '') ILIKE ${pattern} ESCAPE '\\'
        ), deduplicated AS (
          SELECT *, row_number() OVER (
            PARTITION BY source_file_id
            ORDER BY score DESC, projection_kind, record_id
          ) AS candidate_rank
          FROM matched
        ), ranked AS (
          SELECT projection_kind, record_id, source_file_id,
                 related_source_file_id, logical_path, parent_path,
                 sort_key, title, summary, payload_json, score
          FROM deduplicated
          WHERE candidate_rank = 1
        )
        SELECT * FROM ranked
        WHERE (
          ${input.cursor?.score ?? null}::real IS NULL
          OR score < ${input.cursor?.score ?? null}
          OR (score = ${input.cursor?.score ?? null} AND record_id > ${input.cursor?.recordId ?? null})
        )
        ORDER BY score DESC, record_id
        LIMIT ${input.limit + 1}
      `;
      return mapScoredPage(generationId, rows, input.limit);
    },

    async listRelated(input) {
      assertLimit(input.limit);
      const rows = await sql<ProjectionRow[]>`
        WITH ranked AS (
          SELECT projection_kind, record_id, source_file_id,
                 related_source_file_id, logical_path, parent_path, sort_key,
                 CASE
                   WHEN source_file_id = ${input.sourceFileId}
                     THEN coalesce(payload_json->>'toTitle', title)
                   ELSE coalesce(payload_json->>'fromTitle', title)
                 END AS title,
                 coalesce(payload_json->>'reason', summary) AS summary,
                 payload_json,
                 coalesce((payload_json->>'weight')::real, 0) AS score
          FROM focowiki.active_projection_records
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND projection_kind = 'graph_edge'
            AND EXISTS (
              SELECT 1 FROM focowiki.source_files source
              WHERE source.id = source_file_id
                AND source.knowledge_base_id = ${knowledgeBaseId}
                AND source.deleted_at IS NULL
                AND source.deletion_intent_id IS NULL
            )
            AND EXISTS (
              SELECT 1 FROM focowiki.source_files related
              WHERE related.id = related_source_file_id
                AND related.knowledge_base_id = ${knowledgeBaseId}
                AND related.deleted_at IS NULL
                AND related.deletion_intent_id IS NULL
            )
            AND (
              source_file_id = ${input.sourceFileId}
              OR related_source_file_id = ${input.sourceFileId}
            )
        )
        SELECT *
        FROM ranked
        WHERE (
          ${input.cursor?.score ?? null}::real IS NULL
          OR score < ${input.cursor?.score ?? null}
          OR (score = ${input.cursor?.score ?? null} AND record_id > ${input.cursor?.recordId ?? null})
        )
        ORDER BY score DESC, record_id
        LIMIT ${input.limit + 1}
      `;
      const page = mapScoredPage(generationId, rows, input.limit);
      return {
        ...page,
        items: page.items.map((item) => {
          const seedIsFrom = item.sourceFileId === input.sourceFileId;
          return {
            ...item,
            relatedSourceFileId: seedIsFrom
              ? item.relatedSourceFileId
              : item.sourceFileId,
            sourceFileId: input.sourceFileId,
            path: seedIsFrom
              ? readJsonString(item.payload, "toPath")
              : readJsonString(item.payload, "fromPath")
          };
        })
      };
    },

    async listRelatedForSources(input) {
      assertLimit(input.limitPerSource);
      const sourceFileIds = [...new Set(input.sourceFileIds.filter(Boolean))];
      const grouped = new Map<string, ActiveGenerationProjection[]>(
        sourceFileIds.map((sourceFileId) => [sourceFileId, []])
      );
      if (sourceFileIds.length === 0) return grouped;

      const rows = await sql<RelatedProjectionRow[]>`
        SELECT seed.source_file_id AS seed_source_file_id,
               relation.projection_kind, relation.record_id,
               relation.source_file_id, relation.related_source_file_id,
               relation.logical_path, relation.parent_path, relation.sort_key,
               relation.title, relation.summary, relation.score,
               relation.payload_json
        FROM unnest(${sourceFileIds}::text[]) AS seed(source_file_id)
        CROSS JOIN LATERAL (
          SELECT edge.projection_kind, edge.record_id,
                 seed.source_file_id AS source_file_id,
                 CASE WHEN edge.source_file_id = seed.source_file_id
                   THEN edge.related_source_file_id
                   ELSE edge.source_file_id
                 END AS related_source_file_id,
                 CASE WHEN edge.source_file_id = seed.source_file_id
                   THEN edge.payload_json->>'toPath'
                   ELSE edge.payload_json->>'fromPath'
                 END AS logical_path,
                 NULL::text AS parent_path,
                 edge.record_id AS sort_key,
                 CASE WHEN edge.source_file_id = seed.source_file_id
                   THEN coalesce(edge.payload_json->>'toTitle', edge.title)
                   ELSE coalesce(edge.payload_json->>'fromTitle', edge.title)
                 END AS title,
                 coalesce(edge.payload_json->>'reason', edge.summary) AS summary,
                 coalesce((edge.payload_json->>'weight')::real, 0) AS score,
                 edge.payload_json
          FROM focowiki.active_projection_records edge
          JOIN focowiki.source_files source
            ON source.id = edge.source_file_id
           AND source.knowledge_base_id = edge.knowledge_base_id
           AND source.deleted_at IS NULL
           AND source.deletion_intent_id IS NULL
          JOIN focowiki.source_files related
            ON related.id = edge.related_source_file_id
           AND related.knowledge_base_id = edge.knowledge_base_id
           AND related.deleted_at IS NULL
           AND related.deletion_intent_id IS NULL
          WHERE edge.knowledge_base_id = ${knowledgeBaseId}
            AND edge.projection_kind = 'graph_edge'
            AND (
              edge.source_file_id = seed.source_file_id
              OR edge.related_source_file_id = seed.source_file_id
            )
          ORDER BY coalesce((edge.payload_json->>'weight')::real, 0) DESC,
                   edge.record_id
          LIMIT ${input.limitPerSource}
        ) relation
      `;

      for (const row of rows) {
        grouped.get(row.seed_source_file_id)?.push(mapProjection(generationId, row));
      }
      return grouped;
    }
  };
}

async function selectFile(
  sql: ReadSql,
  knowledgeBaseId: string,
  input: { fileId: string | null; path: string | null }
): Promise<FileRow[]> {
  return sql<FileRow[]>`
    SELECT active.file_id, active.ref_kind, active.ref_key,
           active.last_changed_generation_id, active.logical_path,
           active.source_file_id, object.object_key, object.content_type,
           object.size_bytes, object.checksum_sha256,
           search.title, search.summary, search.payload_json
    FROM focowiki.active_object_refs active
    JOIN focowiki.immutable_objects object
      ON object.checksum_sha256 = active.checksum_sha256
     AND object.format_version = active.format_version
    LEFT JOIN focowiki.source_files source
      ON source.id = active.source_file_id
     AND source.knowledge_base_id = active.knowledge_base_id
    LEFT JOIN focowiki.active_projection_records search
      ON search.knowledge_base_id = active.knowledge_base_id
     AND search.projection_kind = 'search'
     AND search.source_file_id = active.source_file_id
    WHERE active.knowledge_base_id = ${knowledgeBaseId}
      AND active.logical_path IS NOT NULL
      AND (
        active.source_file_id IS NULL
        OR (source.id IS NOT NULL AND source.deleted_at IS NULL AND source.deletion_intent_id IS NULL)
      )
      AND (${input.fileId}::text IS NULL OR active.file_id = ${input.fileId})
      AND (${input.path}::text IS NULL OR active.logical_path = ${input.path})
    LIMIT 1
  `;
}

async function selectFilesBySourceIds(
  sql: ReadSql,
  knowledgeBaseId: string,
  sourceFileIds: string[]
): Promise<FileRow[]> {
  return sql<FileRow[]>`
    SELECT DISTINCT ON (active.source_file_id)
           active.file_id, active.ref_kind, active.ref_key,
           active.last_changed_generation_id, active.logical_path,
           active.source_file_id, object.object_key, object.content_type,
           object.size_bytes, object.checksum_sha256,
           search.title, search.summary, search.payload_json
    FROM focowiki.active_object_refs active
    JOIN focowiki.immutable_objects object
      ON object.checksum_sha256 = active.checksum_sha256
     AND object.format_version = active.format_version
    JOIN focowiki.source_files source
      ON source.id = active.source_file_id
     AND source.knowledge_base_id = active.knowledge_base_id
     AND source.deleted_at IS NULL
     AND source.deletion_intent_id IS NULL
    LEFT JOIN focowiki.active_projection_records search
      ON search.knowledge_base_id = active.knowledge_base_id
     AND search.projection_kind = 'search'
     AND search.source_file_id = active.source_file_id
    WHERE active.knowledge_base_id = ${knowledgeBaseId}
      AND active.ref_kind = 'page'
      AND active.source_file_id = ANY(${sourceFileIds})
      AND active.logical_path IS NOT NULL
    ORDER BY active.source_file_id, active.logical_path, active.file_id
  `;
}

function mapFile(generationId: string, row: FileRow): ActiveGenerationFile {
  return {
    generationId,
    fileId: row.file_id,
    refKind: row.ref_kind,
    refKey: row.ref_key,
    lastChangedGenerationId: row.last_changed_generation_id,
    path: row.logical_path,
    sourceFileId: row.source_file_id,
    objectKey: row.object_key,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    checksumSha256: row.checksum_sha256,
    title: row.title,
    summary: row.summary,
    payload: row.payload_json ?? {}
  };
}

function mapScoredPage(
  generationId: string,
  rows: ProjectionRow[],
  limit: number
): ActiveGenerationPage<ActiveGenerationProjection, ActiveGenerationScoredCursor> {
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map((row) => mapProjection(generationId, row)),
    nextCursor: rows.length > limit && last
      ? { score: Number(last.score ?? 0), recordId: last.record_id }
      : null
  };
}

function mapProjection(generationId: string, row: ProjectionRow): ActiveGenerationProjection {
  return {
    generationId,
    projectionKind: row.projection_kind,
    recordId: row.record_id,
    sourceFileId: row.source_file_id,
    relatedSourceFileId: row.related_source_file_id,
    path: row.logical_path,
    parentPath: row.parent_path,
    sortKey: row.sort_key ?? "",
    title: row.title,
    summary: row.summary,
    score: row.score === null ? null : Number(row.score),
    payload: row.payload_json
  };
}

function readJsonString(value: SerializableJson, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Date) return null;
  const property = (value as { readonly [property: string]: SerializableJson | undefined })[key];
  return typeof property === "string" ? property : null;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) {
    throw new Error("Read page limit must be between 1 and 1000");
  }
}
