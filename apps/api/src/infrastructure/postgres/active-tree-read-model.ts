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
  input: TreeInput
): Promise<ActiveGenerationPage<ActiveGenerationProjection, ActiveGenerationCursor>> {
  const query = input.query?.trim() ?? "";
  const [sourceEntries, generatedFiles, generatedDirectories] = await Promise.all([
    listSourceEntries(sql, knowledgeBaseId, generationId, input, query),
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
  const records = new Map(
    rows.map((row) => [row.logical_path!, mapProjection(generationId, row)] as const)
  );
  for (const directory of GENERATED_DIRECTORIES) {
    if (ancestorPaths.includes(directory.path)) {
      records.set(directory.path, generatedDirectoryProjection(generationId, directory));
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
  input: TreeInput,
  query: string
): Promise<ActiveGenerationProjection[]> {
  const queryPattern = `%${escapeLikePattern(query)}%`;
  const rows = await sql<ProjectionRow[]>`
    SELECT projection_kind, record_id, source_file_id,
           related_source_file_id, logical_path, parent_path, sort_key,
           title, summary, NULL::real AS score, payload_json
    FROM focowiki.active_projection_records
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND projection_kind = 'tree'
      AND (${query} <> '' OR coalesce(parent_path, '') = ${input.parentPath})
      AND (${query} = '' OR (
        coalesce(title, '') ILIKE ${queryPattern} ESCAPE '\\'
        OR coalesce(logical_path, '') ILIKE ${queryPattern} ESCAPE '\\'
      ))
      AND (${input.entryType}::text IS NULL OR payload_json->>'kind' = ${input.entryType})
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
        ${input.cursor?.sortKey ?? null}::text IS NULL
        OR (coalesce(sort_key, ''), record_id) >
           (${input.cursor?.sortKey ?? null}, ${input.cursor?.recordId ?? null})
      )
    ORDER BY coalesce(sort_key, ''), record_id
    LIMIT ${input.limit + 1}
  `;
  return rows.map((row) => mapProjection(generationId, row));
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
  const candidatePaths = candidates.map((entry) => entry.path);
  const rows = await sql<Array<{ path: string }>>`
    SELECT candidate.path
    FROM unnest(${candidatePaths}::text[]) AS candidate(path)
    WHERE EXISTS (
      SELECT 1
      FROM focowiki.active_object_refs active
      WHERE active.knowledge_base_id = ${knowledgeBaseId}
        AND active.logical_path >= candidate.path || '/'
        AND active.logical_path < candidate.path || '0'
      LIMIT 1
    )
  `;
  const available = new Set(rows.map((row) => row.path));
  const normalizedQuery = query.toLocaleLowerCase("en-US");
  return candidates
    .filter((entry) => available.has(entry.path))
    .map((entry) => generatedDirectoryProjection(generationId, entry))
    .filter((entry) => !normalizedQuery || matchesQuery(entry, normalizedQuery))
    .filter((entry) => isAfterCursor(entry, input.cursor));
}

function generatedDirectoryProjection(
  generationId: string,
  entry: (typeof GENERATED_DIRECTORIES)[number]
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
      path: entry.path
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
      path: row.logical_path
    }
  };
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
