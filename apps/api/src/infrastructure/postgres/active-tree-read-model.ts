import type {
  ActiveGenerationCursor,
  ActiveGenerationPage,
  ActiveGenerationProjection
} from "../../application/ports/active-generation-read-repository.js";
import type { SerializableJson } from "../../application/ports/source-dispatch-repository.js";
import type { DatabaseClient } from "../../db/client.js";
import type { TransactionSql } from "postgres";

type ReadSql = DatabaseClient | TransactionSql;

type TreeInput = {
  parentPath: string;
  entryType: "file" | "directory" | null;
  query: string | null;
  limit: number;
  cursor: ActiveGenerationCursor | null;
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

type GeneratedFileRow = {
  file_id: string;
  ref_kind: string;
  logical_path: string;
};

type TreeStatisticsRow = {
  path: string;
  direct_entry_count: number;
  direct_directory_count: number;
  direct_file_count: number;
  descendant_file_count: number;
};

type GeneratedDirectoryRow = {
  path: string;
  direct_file_count: number;
  descendant_file_count: number;
};

const ROOT_GENERATED_FILES = ["index.md", "log.md", "schema.md"] as const;

const GENERATED_DIRECTORIES = [
  { path: "_graph", parentPath: "" },
  { path: "_graph/by-file", parentPath: "_graph" },
  { path: "_graph/graph_edge", parentPath: "_graph" },
  { path: "_graph/graph_edge/v1", parentPath: "_graph/graph_edge" },
  { path: "_graph/graph_node", parentPath: "_graph" },
  { path: "_graph/graph_node/v1", parentPath: "_graph/graph_node" },
  { path: "_index", parentPath: "" },
  { path: "_index/links", parentPath: "_index" },
  { path: "_index/links/v1", parentPath: "_index/links" },
  { path: "_index/manifest", parentPath: "_index" },
  { path: "_index/manifest/v1", parentPath: "_index/manifest" },
  { path: "_index/search", parentPath: "_index" },
  { path: "_index/search/v1", parentPath: "_index/search" },
  { path: "_index/tree", parentPath: "_index" },
  { path: "_index/tree/v1", parentPath: "_index/tree" }
] as const;

export async function listActiveTree(
  sql: ReadSql,
  knowledgeBaseId: string,
  generationId: string,
  allowCompatibilityFallback: boolean,
  input: TreeInput
): Promise<ActiveGenerationPage<ActiveGenerationProjection, ActiveGenerationCursor>> {
  const query = input.query?.trim() ?? "";
  const [sourceEntries, generatedFiles, generatedDirectories] = await Promise.all([
    listSourceEntries(
      sql,
      knowledgeBaseId,
      generationId,
      allowCompatibilityFallback,
      input,
      query
    ),
    input.entryType === "directory"
      ? Promise.resolve([])
      : listGeneratedFiles(sql, knowledgeBaseId, generationId, input, query),
    input.entryType === "file"
      ? Promise.resolve([])
      : listGeneratedDirectories(sql, knowledgeBaseId, generationId, input, query)
  ]);

  const entries = [...sourceEntries, ...generatedFiles, ...generatedDirectories]
    .filter((entry) => isAfterCursor(entry, input.cursor))
    .sort(compareTreeEntries)
    .slice(0, input.limit + 1);
  const visible = entries.slice(0, input.limit);
  const last = visible.at(-1);

  return {
    items: visible,
    nextCursor: entries.length > input.limit && last
      ? { sortKey: last.sortKey, recordId: last.recordId }
      : null
  };
}

export async function listActiveTreeAncestors(
  sql: ReadSql,
  knowledgeBaseId: string,
  generationId: string,
  allowCompatibilityFallback: boolean,
  paths: string[]
): Promise<Map<string, ActiveGenerationProjection[]>> {
  const ancestorsByPath = new Map(
    paths.map((path) => [path, treeAncestorPaths(path)] as const)
  );
  const ancestorPaths = [...new Set([...ancestorsByPath.values()].flat())];
  if (ancestorPaths.length === 0) {
    return new Map(paths.map((path) => [path, []]));
  }

  const rows = await sql<ProjectionRow[]>`
    SELECT projection_kind, record_id, source_file_id,
           related_source_file_id, logical_path, parent_path, sort_key,
           title, summary, NULL::real AS score, payload_json
    FROM focowiki.active_projection_records
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND projection_kind = 'tree'
      AND logical_path IN ${sql(ancestorPaths)}
      AND payload_json->>'kind' = 'directory'
    ORDER BY length(logical_path), logical_path, record_id
  `;
  const hydratedRows = await hydrateSourceDirectoryStatistics(
    sql,
    knowledgeBaseId,
    generationId,
    allowCompatibilityFallback,
    rows.map((row) => mapProjection(generationId, row))
  );
  const records = new Map(
    hydratedRows.map((row) => [row.path!, row] as const)
  );
  const generatedStatistics = await loadGeneratedDirectoryStatistics(sql, knowledgeBaseId);
  for (const directory of GENERATED_DIRECTORIES) {
    if (ancestorPaths.includes(directory.path)) {
      const statistics = generatedStatistics.get(directory.path);
      if (statistics) {
        records.set(
          directory.path,
          generatedDirectoryProjection(generationId, directory, statistics)
        );
      }
    }
  }

  return new Map([...ancestorsByPath].map(([path, ancestorPathList]) => [
    path,
    ancestorPathList
      .map((ancestorPath) => records.get(ancestorPath))
      .filter((record): record is ActiveGenerationProjection => Boolean(record))
  ]));
}

async function listSourceEntries(
  sql: ReadSql,
  knowledgeBaseId: string,
  generationId: string,
  allowCompatibilityFallback: boolean,
  input: TreeInput,
  query: string
): Promise<ActiveGenerationProjection[]> {
  const queryPattern = `%${escapeLikePattern(query)}%`;
  const normalizedQueryPattern = queryPattern.toLocaleLowerCase("en-US");
  const rows = await sql<ProjectionRow[]>`
    SELECT record.projection_kind, record.record_id, record.source_file_id,
           record.related_source_file_id, record.logical_path,
           record.parent_path, record.sort_key, record.title, record.summary,
           NULL::real AS score, record.payload_json
    FROM focowiki.active_projection_records record
    WHERE record.knowledge_base_id = ${knowledgeBaseId}
      AND record.projection_kind = 'tree'
      AND (${query} <> '' OR coalesce(record.parent_path, '') = ${input.parentPath})
      AND (${query} = '' OR lower(
        coalesce(record.title, '') || ' ' || coalesce(record.logical_path, '')
      ) LIKE ${normalizedQueryPattern} ESCAPE '\\')
      AND (${input.entryType}::text IS NULL OR record.payload_json->>'kind' = ${input.entryType})
      AND (
        record.source_file_id IS NULL OR EXISTS (
          SELECT 1 FROM focowiki.source_files source
          WHERE source.id = record.source_file_id
            AND source.knowledge_base_id = ${knowledgeBaseId}
            AND source.deleted_at IS NULL
            AND source.deletion_intent_id IS NULL
        )
      )
      AND (
        ${input.cursor?.sortKey ?? null}::text IS NULL
        OR (coalesce(record.sort_key, ''), record.record_id) >
           (${input.cursor?.sortKey ?? null}, ${input.cursor?.recordId ?? null})
      )
    ORDER BY coalesce(record.sort_key, ''), record.record_id
    LIMIT ${input.limit + 1}
  `;
  return hydrateSourceDirectoryStatistics(
    sql,
    knowledgeBaseId,
    generationId,
    allowCompatibilityFallback,
    rows.map((row) => mapProjection(generationId, row))
  );
}

async function listGeneratedFiles(
  sql: ReadSql,
  knowledgeBaseId: string,
  generationId: string,
  input: TreeInput,
  query: string
): Promise<ActiveGenerationProjection[]> {
  const pathRows = input.parentPath === ""
    ? await sql<GeneratedFileRow[]>`
        SELECT file_id, ref_kind, logical_path
        FROM focowiki.active_object_refs
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND logical_path = ANY(${[...ROOT_GENERATED_FILES]})
        ORDER BY lower(logical_path), file_id
      `
    : await listGeneratedFilesBelowParent(
        sql,
        knowledgeBaseId,
        input.parentPath,
        input.limit,
        input.cursor
      );

  const normalizedQuery = query.toLocaleLowerCase("en-US");
  return pathRows
    .map((row) => generatedFileProjection(generationId, input.parentPath, row))
    .filter((entry) => !normalizedQuery || matchesQuery(entry, normalizedQuery))
    .filter((entry) => isAfterCursor(entry, input.cursor))
    .sort(compareTreeEntries)
    .slice(0, input.limit + 1);
}

async function listGeneratedFilesBelowParent(
  sql: ReadSql,
  knowledgeBaseId: string,
  parentPath: string,
  limit: number,
  cursor: ActiveGenerationCursor | null
): Promise<GeneratedFileRow[]> {
  const prefix = `${parentPath}/`;
  const upperBound = `${parentPath}0`;
  return sql<GeneratedFileRow[]>`
    SELECT file_id, ref_kind, logical_path
    FROM focowiki.active_object_refs
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND logical_path >= ${prefix}
      AND logical_path < ${upperBound}
      AND position('/' in substring(logical_path from (${prefix.length + 1})::integer)) = 0
      AND ref_kind NOT IN ('page', 'generation_manifest')
      AND (
        ${cursor?.sortKey ?? null}::text IS NULL
        OR logical_path > ${cursor?.sortKey ?? null}
      )
    ORDER BY knowledge_base_id, logical_path
    LIMIT ${limit + 1}
  `;
}

async function listGeneratedDirectories(
  sql: ReadSql,
  knowledgeBaseId: string,
  generationId: string,
  input: TreeInput,
  query: string
): Promise<ActiveGenerationProjection[]> {
  const candidates = GENERATED_DIRECTORIES.filter((entry) => entry.parentPath === input.parentPath);
  if (candidates.length === 0) return [];
  const statistics = await loadGeneratedDirectoryStatistics(sql, knowledgeBaseId);
  const normalizedQuery = query.toLocaleLowerCase("en-US");
  return candidates
    .filter((entry) => statistics.has(entry.path))
    .map((entry) => generatedDirectoryProjection(
      generationId,
      entry,
      statistics.get(entry.path)!
    ))
    .filter((entry) => !normalizedQuery || matchesQuery(entry, normalizedQuery))
    .filter((entry) => isAfterCursor(entry, input.cursor));
}

async function loadGeneratedDirectoryStatistics(
  sql: ReadSql,
  knowledgeBaseId: string
): Promise<Map<string, {
  directDirectoryCount: number;
  directFileCount: number;
  descendantFileCount: number;
}>> {
  const candidatePaths = GENERATED_DIRECTORIES.map((entry) => entry.path);
  const rows = await sql<GeneratedDirectoryRow[]>`
    SELECT path, direct_file_count::int, descendant_file_count::int
    FROM focowiki.active_generated_directory_stats
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND path = ANY(${candidatePaths})
  `;
  const available = new Set(rows.map((row) => row.path));
  return new Map(rows.map((row) => {
    const directDirectoryCount = GENERATED_DIRECTORIES.filter((candidate) =>
      candidate.parentPath === row.path && available.has(candidate.path)
    ).length;
    return [
      row.path,
      {
        directDirectoryCount,
        directFileCount: Number(row.direct_file_count),
        descendantFileCount: Number(row.descendant_file_count)
      }
    ] as const;
  }));
}

function generatedDirectoryProjection(
  generationId: string,
  entry: (typeof GENERATED_DIRECTORIES)[number],
  counts: {
    directDirectoryCount: number;
    directFileCount: number;
    descendantFileCount: number;
  } = { directDirectoryCount: 0, directFileCount: 0, descendantFileCount: 0 }
): ActiveGenerationProjection {
  const name = entry.path.split("/").at(-1) ?? entry.path;
  return {
    generationId,
    projectionKind: "tree",
    recordId: `generated-directory:${entry.path}`,
    sourceFileId: null,
    relatedSourceFileId: null,
    path: entry.path,
    parentPath: entry.parentPath,
    sortKey: entry.path.toLocaleLowerCase("en-US"),
    title: name,
    summary: null,
    score: null,
    payload: {
      kind: "directory",
      name,
      parentPath: entry.parentPath,
      path: entry.path,
      directEntryCount: counts.directDirectoryCount + counts.directFileCount,
      directDirectoryCount: counts.directDirectoryCount,
      directFileCount: counts.directFileCount,
      descendantFileCount: counts.descendantFileCount
    }
  };
}

function generatedFileProjection(
  generationId: string,
  parentPath: string,
  row: GeneratedFileRow
): ActiveGenerationProjection {
  const name = row.logical_path.split("/").at(-1) ?? row.logical_path;
  return {
    generationId,
    projectionKind: "tree",
    recordId: `generated-file:${row.file_id}`,
    sourceFileId: null,
    relatedSourceFileId: null,
    path: row.logical_path,
    parentPath,
    sortKey: row.logical_path,
    title: name,
    summary: null,
    score: null,
    payload: {
      fileId: row.file_id,
      fileKind: generatedFileKind(row.ref_kind, row.logical_path),
      kind: "file",
      name,
      parentPath,
      path: row.logical_path,
      directEntryCount: 0,
      directDirectoryCount: 0,
      directFileCount: 0,
      descendantFileCount: 0
    }
  };
}

async function hydrateSourceDirectoryStatistics(
  sql: ReadSql,
  knowledgeBaseId: string,
  generationId: string,
  allowCompatibilityFallback: boolean,
  entries: ActiveGenerationProjection[]
): Promise<ActiveGenerationProjection[]> {
  const directoryPaths = entries
    .filter((entry) => readPayloadString(entry.payload, "kind") === "directory" && entry.path)
    .map((entry) => entry.path!);
  if (directoryPaths.length === 0) return entries;

  const persistedRows = await sql<TreeStatisticsRow[]>`
    SELECT path, direct_entry_count, direct_directory_count,
           direct_file_count, descendant_file_count
    FROM focowiki.generation_tree_directory_stats
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND generation_id = ${generationId}
      AND path = ANY(${directoryPaths})
  `;
  const statistics = new Map(persistedRows.map((row) => [row.path, row] as const));
  const missingPaths = directoryPaths.filter((path) => !statistics.has(path));
  if (missingPaths.length > 0 && !allowCompatibilityFallback) {
    const entriesByPath = new Map(
      entries
        .filter((entry) => entry.path)
        .map((entry) => [entry.path!, entry] as const)
    );
    const unresolvedPaths = missingPaths.filter((path) =>
      !hasCompleteDirectoryStatistics(entriesByPath.get(path)?.payload)
    );
    if (unresolvedPaths.length > 0) {
      throw new Error("Active directory statistics are unavailable");
    }
  }
  if (missingPaths.length > 0 && allowCompatibilityFallback) {
    const fallbackRows = await sql<TreeStatisticsRow[]>`
      WITH requested(path) AS MATERIALIZED (
        SELECT unnest(${missingPaths}::text[])
      ),
      direct_counts AS (
        SELECT child.parent_path AS path,
               count(*) FILTER (
                 WHERE child.payload_json->>'kind' IN ('directory', 'file')
               )::int AS direct_entry_count,
               count(*) FILTER (
                 WHERE child.payload_json->>'kind' = 'directory'
               )::int AS direct_directory_count,
               count(*) FILTER (
                 WHERE child.payload_json->>'kind' = 'file'
               )::int AS direct_file_count
        FROM focowiki.active_projection_records child
        WHERE child.knowledge_base_id = ${knowledgeBaseId}
          AND child.projection_kind = 'tree'
          AND child.parent_path = ANY(${missingPaths})
        GROUP BY child.parent_path
      ),
      descendant_counts AS (
        SELECT requested.path, count(descendant.record_id)::int AS descendant_file_count
        FROM requested
        LEFT JOIN focowiki.active_projection_records descendant
          ON descendant.knowledge_base_id = ${knowledgeBaseId}
         AND descendant.projection_kind = 'tree'
         AND descendant.logical_path >= requested.path || '/'
         AND descendant.logical_path < requested.path || '0'
         AND descendant.payload_json->>'kind' = 'file'
        GROUP BY requested.path
      )
      SELECT requested.path,
             coalesce(direct.direct_entry_count, 0) AS direct_entry_count,
             coalesce(direct.direct_directory_count, 0) AS direct_directory_count,
             coalesce(direct.direct_file_count, 0) AS direct_file_count,
             coalesce(descendant.descendant_file_count, 0) AS descendant_file_count
      FROM requested
      LEFT JOIN direct_counts direct USING (path)
      LEFT JOIN descendant_counts descendant USING (path)
    `;
    for (const row of fallbackRows) statistics.set(row.path, row);
  }

  return entries.map((entry) => {
    const row = entry.path ? statistics.get(entry.path) : null;
    if (!row) return entry;
    return {
      ...entry,
      payload: {
        ...(entry.payload as Record<string, SerializableJson>),
        directEntryCount: Number(row.direct_entry_count),
        directDirectoryCount: Number(row.direct_directory_count),
        directFileCount: Number(row.direct_file_count),
        descendantFileCount: Number(row.descendant_file_count)
      }
    };
  });
}

function hasCompleteDirectoryStatistics(payload: SerializableJson | undefined): boolean {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") return false;
  const object = payload as Record<string, SerializableJson>;
  const directEntryCount = object.directEntryCount;
  const directDirectoryCount = object.directDirectoryCount;
  const directFileCount = object.directFileCount;
  const descendantFileCount = object.descendantFileCount;
  const values = [directEntryCount, directDirectoryCount, directFileCount, descendantFileCount];
  return values.every((value) => Number.isSafeInteger(value) && Number(value) >= 0)
    && Number(directEntryCount) === Number(directDirectoryCount) + Number(directFileCount);
}

function readPayloadString(payload: SerializableJson, key: string): string | null {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") return null;
  const value = (payload as Record<string, SerializableJson>)[key];
  return typeof value === "string" ? value : null;
}

function generatedFileKind(refKind: string, path: string): string {
  if (path === "schema.md") return "schema";
  if (path === "log.md") return "log";
  if (refKind === "directory_root" || refKind === "directory_leaf") return "index";
  if (path.startsWith("_graph/")) return "graph_index";
  if (path.startsWith("_index/")) return "search_index";
  return "index";
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

function matchesQuery(entry: ActiveGenerationProjection, normalizedQuery: string): boolean {
  return `${entry.title ?? ""} ${entry.path ?? ""}`
    .toLocaleLowerCase("en-US")
    .includes(normalizedQuery);
}

function compareTreeEntries(
  left: ActiveGenerationProjection,
  right: ActiveGenerationProjection
): number {
  return left.sortKey.localeCompare(right.sortKey)
    || left.recordId.localeCompare(right.recordId);
}

function isAfterCursor(
  entry: ActiveGenerationProjection,
  cursor: ActiveGenerationCursor | null
): boolean {
  if (!cursor) return true;
  return entry.sortKey > cursor.sortKey
    || (entry.sortKey === cursor.sortKey && entry.recordId > cursor.recordId);
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

function treeAncestorPaths(path: string): string[] {
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  const paths: string[] = [];
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    paths.push(current);
  }
  return paths;
}
