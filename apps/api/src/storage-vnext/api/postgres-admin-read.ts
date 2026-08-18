import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import type { StorageVnextCatalogReadPort } from "../catalog/ports.js";
import type { StorageVnextSearchQueryPort } from "../search/ports.js";
import type {
  StorageVnextAdminApplicationResult,
  StorageVnextAdminKnowledgeBase,
  StorageVnextAdminTreeEntry,
  StorageVnextAdminTreeSearchItem
} from "./admin-ports.js";
import type { StorageVnextAdminReadApplication } from "./admin-read-application.js";

type TreeRow = {
  record_id: string;
  logical_path: string;
  parent_path: string;
  entry_type: "file" | "directory";
  source_file_public_id: string | null;
  source_directory_public_id: string | null;
  entry_kind: string | null;
  direct_directory_count: number | string;
  direct_file_count: number | string;
  descendant_file_count: number | string;
  resource_revision: number | string | null;
};

type TreeCursor = {
  version: 1;
  scope: string;
  logicalPath: string;
  recordId: string;
};

type TreeSearchCursor = {
  version: 1;
  scope: string;
  phase: "directories" | "generated-files" | "files";
  logicalPath: string | null;
  recordId: string | null;
  fileCursor: string | null;
};

export function createPostgresStorageVnextAdminRead(input: {
  sql: DatabaseClient;
  catalog: StorageVnextCatalogReadPort;
  search: StorageVnextSearchQueryPort | null;
}): StorageVnextAdminReadApplication {
  return {
    async listKnowledgeBases(request) {
      try {
        const page = await input.catalog.listKnowledgeBases({
          query: request.query,
          limit: request.limit,
          cursor: request.cursor
        });
        const revisions = await readActivationRevisions(
          input.sql,
          page.items.map((knowledgeBase) => knowledgeBase.publicId)
        );
        const items = page.items.map((knowledgeBase) => toKnowledgeBase(
          knowledgeBase,
          revisions.get(knowledgeBase.publicId) ?? 0
        ));
        return success({ items, nextCursor: page.nextCursor });
      } catch {
        return request.cursor ? invalidPagination() : unavailable();
      }
    },

    async getKnowledgeBase(request) {
      const knowledgeBase = await input.catalog.getKnowledgeBase(request);
      if (!knowledgeBase) return success(null);
      return success(toKnowledgeBase(
        knowledgeBase,
        await readActivationRevision(input.sql, knowledgeBase.publicId)
      ));
    },

    async listTree(request) {
      const knowledgeBase = await input.catalog.getKnowledgeBase(request);
      if (!knowledgeBase) return notFound();
      const activationRevision = await readActivationRevision(
        input.sql,
        request.knowledgeBaseId
      );
      const scope = treeScope(request, activationRevision);
      let cursor: TreeCursor | null;
      try {
        cursor = decodeTreeCursor(request.cursor, scope);
      } catch {
        return invalidPagination();
      }
      const rows = await input.sql<TreeRow[]>`
        WITH page_heads AS MATERIALIZED (
          SELECT page.logical_path, page.entry_kind,
                 page.source_file_public_id, page.source_revision_public_id,
                 CASE WHEN strpos(page.logical_path, '/') = 0 THEN ''
                   ELSE regexp_replace(page.logical_path, '/[^/]+$', '')
                 END AS parent_path
          FROM focowiki.generated_page_heads page
          LEFT JOIN focowiki.source_file_active_revisions active
            ON active.knowledge_base_id = page.knowledge_base_id
           AND active.source_file_public_id = page.source_file_public_id
          WHERE page.knowledge_base_id = ${request.knowledgeBaseId}
            AND (page.source_file_public_id IS NULL
              OR active.active_source_revision_public_id = page.source_revision_public_id)
        ), directory_paths AS MATERIALIZED (
          SELECT DISTINCT array_to_string(parts[1:depth], '/') AS logical_path
          FROM (
            SELECT string_to_array(logical_path, '/') AS parts
            FROM page_heads
          ) page
          CROSS JOIN LATERAL generate_series(
            1,
            greatest(coalesce(array_length(parts, 1), 0) - 1, 0)
          ) depth
        ), directory_entries AS (
          SELECT
            coalesce(
              directory.public_id,
              focowiki.public_generated_directory_id(
                ${request.knowledgeBaseId}, path.logical_path
              )
            ) AS record_id,
            path.logical_path,
            CASE WHEN strpos(path.logical_path, '/') = 0 THEN ''
              ELSE regexp_replace(path.logical_path, '/[^/]+$', '')
            END AS parent_path,
            directory.public_id AS source_directory_public_id,
            (SELECT count(*) FROM directory_paths child
             WHERE CASE WHEN strpos(child.logical_path, '/') = 0 THEN ''
               ELSE regexp_replace(child.logical_path, '/[^/]+$', '') END
               = path.logical_path) AS direct_directory_count,
            (SELECT count(*) FROM page_heads child
             WHERE child.parent_path = path.logical_path) AS direct_file_count,
            (SELECT count(*) FROM page_heads child
             WHERE child.logical_path LIKE path.logical_path || '/%'
               AND child.source_file_public_id IS NOT NULL)
              AS descendant_file_count,
            coalesce(directory.revision, 0) AS resource_revision
          FROM directory_paths path
          LEFT JOIN focowiki.source_directories directory
            ON directory.knowledge_base_id = ${request.knowledgeBaseId}
           AND directory.deleted_at IS NULL
           AND path.logical_path LIKE 'pages/%'
           AND directory.logical_path = substring(path.logical_path FROM 7)
        ), tree_entries AS (
          SELECT
            directory.record_id, directory.logical_path, directory.parent_path,
            'directory'::text AS entry_type,
            NULL::text AS source_file_public_id,
            directory.source_directory_public_id,
            NULL::text AS entry_kind,
            directory.direct_directory_count, directory.direct_file_count,
            directory.descendant_file_count, directory.resource_revision
          FROM directory_entries directory

          UNION ALL

          SELECT
            coalesce(
              page.source_file_public_id,
              focowiki.public_generated_file_id(
                ${request.knowledgeBaseId},
                page.logical_path
              )
            ),
            page.logical_path, page.parent_path,
            'file'::text AS entry_type,
            page.source_file_public_id,
            NULL::text AS source_directory_public_id,
            page.entry_kind,
            0::bigint AS direct_directory_count,
            0::bigint AS direct_file_count,
            0::bigint AS descendant_file_count,
            source.revision AS resource_revision
          FROM page_heads page
          LEFT JOIN focowiki.source_files source
            ON source.knowledge_base_id = ${request.knowledgeBaseId}
           AND source.public_id = page.source_file_public_id
           AND source.deleted_at IS NULL
          WHERE page.source_file_public_id IS NULL OR source.public_id IS NOT NULL
        )
        SELECT record_id, logical_path, parent_path, entry_type,
               source_file_public_id, source_directory_public_id, entry_kind,
               direct_directory_count, direct_file_count, descendant_file_count,
               resource_revision
        FROM tree_entries
        WHERE parent_path = ${request.parentPath}
          AND (${request.entryType}::text IS NULL OR entry_type = ${request.entryType})
          AND (${request.query?.trim() || null}::text IS NULL OR strpos(
            lower(logical_path), lower(${request.query?.trim() || null})
          ) > 0)
          AND (
            ${cursor?.logicalPath ?? null}::text IS NULL
            OR (logical_path, record_id) >
               (${cursor?.logicalPath ?? null}::text, ${cursor?.recordId ?? null}::text)
          )
        ORDER BY logical_path COLLATE "C", record_id COLLATE "C"
        LIMIT ${request.limit + 1}
      `;
      const pageRows = rows.slice(0, request.limit);
      return success({
        items: pageRows.map(toTreeEntry),
        nextCursor: rows.length > request.limit && pageRows.at(-1)
          ? encodeTreeCursor({
              version: 1,
              scope,
              logicalPath: pageRows.at(-1)!.logical_path,
              recordId: pageRows.at(-1)!.record_id
            })
          : null
      });
    },

    async searchFiles(request) {
      const knowledgeBase = await input.catalog.getKnowledgeBase(request);
      if (!knowledgeBase) return notFound();
      if (!input.search) return unavailable();
      const activationRevision = await readActivationRevision(
        input.sql,
        request.knowledgeBaseId
      );
      const scope = treeSearchScope(request, activationRevision);
      try {
        const cursor = decodeTreeSearchCursor(request.cursor, scope);
        if (cursor.phase === "files") {
          return success(await searchFilePage({
            search: input.search,
            catalog: input.catalog,
            knowledgeBaseId: request.knowledgeBaseId,
            query: request.query,
            limit: request.limit,
            cursor: cursor.fileCursor,
            scope
          }));
        }

        if (cursor.phase === "generated-files") {
          return success(await searchGeneratedFilePage({
            sql: input.sql,
            search: input.search,
            catalog: input.catalog,
            knowledgeBaseId: request.knowledgeBaseId,
            query: request.query,
            limit: request.limit,
            logicalPath: cursor.logicalPath,
            recordId: cursor.recordId,
            scope
          }));
        }

        const directoryRows = await listMatchingDirectories({
          sql: input.sql,
          knowledgeBaseId: request.knowledgeBaseId,
          query: request.query,
          limit: request.limit + 1,
          logicalPath: cursor.logicalPath,
          recordId: cursor.recordId
        });
        const visibleDirectories = directoryRows.slice(0, request.limit);
        const directoryItems = visibleDirectories.map((row) =>
          toDirectorySearchItem(row, request.knowledgeBaseId)
        );

        if (directoryRows.length > request.limit) {
          const last = visibleDirectories.at(-1)!;
          return success({
            items: directoryItems,
            nextCursor: encodeTreeSearchCursor({
              version: 1,
              scope,
              phase: "directories",
              logicalPath: last.logical_path,
              recordId: last.record_id,
              fileCursor: null
            })
          });
        }

        const remaining = request.limit - directoryItems.length;
        if (remaining === 0) {
          return success({
            items: directoryItems,
            nextCursor: encodeTreeSearchCursor(generatedFilePhaseCursor(scope, null, null))
          });
        }

        const filePage = await searchGeneratedFilePage({
          sql: input.sql,
          search: input.search,
          catalog: input.catalog,
          knowledgeBaseId: request.knowledgeBaseId,
          query: request.query,
          limit: remaining,
          logicalPath: null,
          recordId: null,
          scope
        });
        return success({
          items: [...directoryItems, ...filePage.items],
          nextCursor: filePage.nextCursor
        });
      } catch (error) {
        return hasCode(error, "INVALID_SEARCH_CURSOR")
          ? invalidPagination()
          : unavailable();
      }
    }
  };
}

function toKnowledgeBase(
  record: Awaited<ReturnType<StorageVnextCatalogReadPort["getKnowledgeBase"]>> extends infer T
    ? Exclude<T, null>
    : never,
  activationRevision: number
): StorageVnextAdminKnowledgeBase {
  return {
    id: record.publicId,
    name: record.name,
    description: record.description,
    activeVersionId: activationRevision > 0
      ? `activation-revision-${activationRevision}` : null,
    resourceRevision: record.revision,
    catalogVersion: activationRevision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

async function readActivationRevision(
  sql: DatabaseClient,
  knowledgeBaseId: string
): Promise<number> {
  return (await readActivationRevisions(sql, [knowledgeBaseId]))
    .get(knowledgeBaseId) ?? 0;
}

async function readActivationRevisions(
  sql: DatabaseClient,
  knowledgeBaseIds: readonly string[]
): Promise<Map<string, number>> {
  if (knowledgeBaseIds.length === 0) return new Map();
  const rows = await sql<Array<{
    knowledge_base_id: string;
    activation_revision: number | string;
  }>>`
    SELECT knowledge_base_id, current_sequence AS activation_revision
    FROM focowiki.knowledge_base_sequences
    WHERE knowledge_base_id = ANY(${knowledgeBaseIds}::text[])
  `;
  return new Map(rows.map((row) => [
    row.knowledge_base_id,
    toCount(row.activation_revision)
  ]));
}

function toTreeEntry(row: TreeRow): StorageVnextAdminTreeEntry {
  const directDirectoryCount = toCount(row.direct_directory_count);
  const directFileCount = toCount(row.direct_file_count);
  return {
    id: row.record_id,
    parentPath: row.parent_path,
    name: row.logical_path.split("/").at(-1) ?? row.logical_path,
    logicalPath: row.logical_path,
    sortKey: `${row.logical_path}:${row.record_id}`,
    entryType: row.entry_type,
    generatedFileId: row.entry_type === "file" ? row.record_id : null,
    sourceFileId: row.source_file_public_id,
    sourceDirectoryId: row.source_directory_public_id,
    fileKind: row.entry_type === "file" ? fileKind(row) : null,
    directEntryCount: directDirectoryCount + directFileCount,
    directDirectoryCount,
    directFileCount,
    descendantFileCount: toCount(row.descendant_file_count),
    resourceRevision: row.resource_revision === null
      ? null
      : toCount(row.resource_revision),
    deletable: Boolean(row.source_file_public_id || row.source_directory_public_id)
  };
}

function toSearchItem(
  item: Awaited<ReturnType<StorageVnextSearchQueryPort["search"]>>["items"][number],
  revision: number | null,
  knowledgeBaseId: string
): StorageVnextAdminTreeSearchItem {
  const parentPath = parentPathOf(item.logicalPath);
  const entry: StorageVnextAdminTreeEntry = {
    id: item.publicId,
    parentPath,
    name: item.logicalPath.split("/").at(-1) ?? item.logicalPath,
    logicalPath: item.logicalPath,
    sortKey: `${item.logicalPath}:${item.publicId}`,
    entryType: "file",
    generatedFileId: item.publicId,
    sourceFileId: item.sourceFilePublicId,
    sourceDirectoryId: null,
    fileKind: "page",
    directEntryCount: 0,
    directDirectoryCount: 0,
    directFileCount: 0,
    descendantFileCount: 0,
    resourceRevision: revision,
    deletable: true
  };
  return {
    entry,
    ancestors: ancestorPaths(parentPath).map((logicalPath) => ({
      ...entry,
      id: stableGeneratedDirectoryId(knowledgeBaseId, logicalPath),
      parentPath: parentPathOf(logicalPath),
      name: logicalPath.split("/").at(-1) ?? logicalPath,
      logicalPath,
      sortKey: logicalPath,
      entryType: "directory",
      generatedFileId: null,
      sourceFileId: null,
      sourceDirectoryId: null,
      fileKind: null,
      resourceRevision: null,
      deletable: false
    }))
  };
}

function toDirectorySearchItem(
  row: TreeRow,
  knowledgeBaseId: string
): StorageVnextAdminTreeSearchItem {
  const entry = toTreeEntry(row);
  return {
    entry,
    ancestors: ancestorPaths(row.parent_path).map((logicalPath) => ({
      ...entry,
      id: stableGeneratedDirectoryId(knowledgeBaseId, logicalPath),
      parentPath: parentPathOf(logicalPath),
      name: logicalPath.split("/").at(-1) ?? logicalPath,
      logicalPath,
      sortKey: logicalPath,
      entryType: "directory",
      generatedFileId: null,
      sourceFileId: null,
      sourceDirectoryId: null,
      fileKind: null,
      directEntryCount: 0,
      directDirectoryCount: 0,
      directFileCount: 0,
      descendantFileCount: 0,
      resourceRevision: null,
      deletable: false
    }))
  };
}

function toGeneratedFileSearchItem(
  row: TreeRow,
  knowledgeBaseId: string
): StorageVnextAdminTreeSearchItem {
  const entry = toTreeEntry(row);
  return {
    entry,
    ancestors: ancestorPaths(row.parent_path).map((logicalPath) => ({
      ...entry,
      id: stableGeneratedDirectoryId(knowledgeBaseId, logicalPath),
      parentPath: parentPathOf(logicalPath),
      name: logicalPath.split("/").at(-1) ?? logicalPath,
      logicalPath,
      sortKey: logicalPath,
      entryType: "directory",
      generatedFileId: null,
      sourceFileId: null,
      sourceDirectoryId: null,
      fileKind: null,
      directEntryCount: 0,
      directDirectoryCount: 0,
      directFileCount: 0,
      descendantFileCount: 0,
      resourceRevision: null,
      deletable: false
    }))
  };
}

async function listMatchingDirectories(input: {
  sql: DatabaseClient;
  knowledgeBaseId: string;
  query: string;
  limit: number;
  logicalPath: string | null;
  recordId: string | null;
}): Promise<TreeRow[]> {
  return input.sql<TreeRow[]>`
    WITH page_heads AS MATERIALIZED (
      SELECT page.logical_path,
             CASE WHEN strpos(page.logical_path, '/') = 0 THEN ''
               ELSE regexp_replace(page.logical_path, '/[^/]+$', '')
             END AS parent_path
      FROM focowiki.generated_page_heads page
      LEFT JOIN focowiki.source_file_active_revisions active
        ON active.knowledge_base_id = page.knowledge_base_id
       AND active.source_file_public_id = page.source_file_public_id
      WHERE page.knowledge_base_id = ${input.knowledgeBaseId}
        AND (page.source_file_public_id IS NULL
          OR active.active_source_revision_public_id = page.source_revision_public_id)
    ), directory_paths AS MATERIALIZED (
      SELECT DISTINCT array_to_string(parts[1:depth], '/') AS logical_path
      FROM (
        SELECT string_to_array(logical_path, '/') AS parts FROM page_heads
      ) page
      CROSS JOIN LATERAL generate_series(
        1,
        greatest(coalesce(array_length(parts, 1), 0) - 1, 0)
      ) depth
    )
    SELECT
      coalesce(
        directory.public_id,
        focowiki.public_generated_directory_id(
          ${input.knowledgeBaseId},
          path.logical_path
        )
      ) AS record_id,
      path.logical_path,
      CASE
        WHEN strpos(path.logical_path, '/') = 0 THEN ''
        ELSE regexp_replace(path.logical_path, '/[^/]+$', '')
      END AS parent_path,
      'directory'::text AS entry_type,
      NULL::text AS source_file_public_id,
      directory.public_id AS source_directory_public_id,
      NULL::text AS entry_kind,
      (SELECT count(*) FROM directory_paths child
       WHERE CASE WHEN strpos(child.logical_path, '/') = 0 THEN ''
         ELSE regexp_replace(child.logical_path, '/[^/]+$', '') END
         = path.logical_path) AS direct_directory_count,
      (SELECT count(*) FROM page_heads child
       WHERE child.parent_path = path.logical_path) AS direct_file_count,
      (SELECT count(*) FROM page_heads child
       WHERE child.logical_path LIKE path.logical_path || '/%')
        AS descendant_file_count,
      coalesce(directory.revision, 0) AS resource_revision
    FROM directory_paths path
    LEFT JOIN focowiki.source_directories directory
      ON directory.knowledge_base_id = ${input.knowledgeBaseId}
     AND directory.deleted_at IS NULL
     AND path.logical_path LIKE 'pages/%'
     AND directory.logical_path = substring(path.logical_path FROM 7)
    WHERE strpos(lower(path.logical_path), lower(${input.query.trim()})) > 0
      AND (
        ${input.logicalPath}::text IS NULL
        OR (
          path.logical_path,
          coalesce(
            directory.public_id,
            focowiki.public_generated_directory_id(
              ${input.knowledgeBaseId},
              path.logical_path
            )
          )
        ) >
           (${input.logicalPath}::text, ${input.recordId}::text)
      )
    ORDER BY path.logical_path COLLATE "C",
             coalesce(
               directory.public_id,
               focowiki.public_generated_directory_id(
                 ${input.knowledgeBaseId},
                 path.logical_path
               )
             ) COLLATE "C"
    LIMIT ${input.limit}
  `;
}

async function listMatchingGeneratedFiles(input: {
  sql: DatabaseClient;
  knowledgeBaseId: string;
  query: string;
  limit: number;
  logicalPath: string | null;
  recordId: string | null;
}): Promise<TreeRow[]> {
  return input.sql<TreeRow[]>`
    SELECT
      focowiki.public_generated_file_id(
        ${input.knowledgeBaseId},
        page.logical_path
      ) AS record_id,
      page.logical_path,
      CASE
        WHEN strpos(page.logical_path, '/') = 0 THEN ''
        ELSE regexp_replace(page.logical_path, '/[^/]+$', '')
      END AS parent_path,
      'file'::text AS entry_type,
      NULL::text AS source_file_public_id,
      NULL::text AS source_directory_public_id,
      page.entry_kind,
      0::bigint AS direct_directory_count,
      0::bigint AS direct_file_count,
      0::bigint AS descendant_file_count,
      NULL::bigint AS resource_revision
    FROM focowiki.generated_page_heads page
    WHERE page.knowledge_base_id = ${input.knowledgeBaseId}
      AND page.source_file_public_id IS NULL
      AND strpos(lower(page.logical_path), lower(${input.query.trim()})) > 0
      AND (
        ${input.logicalPath}::text IS NULL
        OR (
          page.logical_path,
          focowiki.public_generated_file_id(
            ${input.knowledgeBaseId},
            page.logical_path
          )
        ) > (${input.logicalPath}::text, ${input.recordId}::text)
      )
    ORDER BY page.logical_path COLLATE "C",
             focowiki.public_generated_file_id(
               ${input.knowledgeBaseId},
               page.logical_path
             ) COLLATE "C"
    LIMIT ${input.limit}
  `;
}

async function searchGeneratedFilePage(input: {
  sql: DatabaseClient;
  search: StorageVnextSearchQueryPort;
  catalog: StorageVnextCatalogReadPort;
  knowledgeBaseId: string;
  query: string;
  limit: number;
  logicalPath: string | null;
  recordId: string | null;
  scope: string;
}) {
  const rows = await listMatchingGeneratedFiles({
    sql: input.sql,
    knowledgeBaseId: input.knowledgeBaseId,
    query: input.query,
    limit: input.limit + 1,
    logicalPath: input.logicalPath,
    recordId: input.recordId
  });
  const visibleRows = rows.slice(0, input.limit);
  const generatedItems = visibleRows.map((row) =>
    toGeneratedFileSearchItem(row, input.knowledgeBaseId)
  );
  if (rows.length > input.limit) {
    const last = visibleRows.at(-1)!;
    return {
      items: generatedItems,
      nextCursor: encodeTreeSearchCursor(generatedFilePhaseCursor(
        input.scope,
        last.logical_path,
        last.record_id
      ))
    };
  }

  const remaining = input.limit - generatedItems.length;
  if (remaining === 0) {
    const probe = await input.search.search({
      knowledgeBaseId: input.knowledgeBaseId,
      query: input.query,
      kinds: ["file"],
      limit: 1,
      cursor: null
    });
    return {
      items: generatedItems,
      nextCursor: probe.items.length > 0
        ? encodeTreeSearchCursor(filePhaseCursor(input.scope, null))
        : null
    };
  }

  const sourcePage = await searchFilePage({
    search: input.search,
    catalog: input.catalog,
    knowledgeBaseId: input.knowledgeBaseId,
    query: input.query,
    limit: remaining,
    cursor: null,
    scope: input.scope
  });
  return {
    items: [...generatedItems, ...sourcePage.items],
    nextCursor: sourcePage.nextCursor
  };
}

async function searchFilePage(input: {
  search: StorageVnextSearchQueryPort;
  catalog: StorageVnextCatalogReadPort;
  knowledgeBaseId: string;
  query: string;
  limit: number;
  cursor: string | null;
  scope: string;
}) {
  const page = await input.search.search({
    knowledgeBaseId: input.knowledgeBaseId,
    query: input.query,
    kinds: ["file"],
    limit: input.limit,
    cursor: input.cursor
  });
  const sources = await input.catalog.listSourceFilesByPublicIds({
    knowledgeBaseId: input.knowledgeBaseId,
    publicIds: page.items.map((item) => item.sourceFilePublicId),
    limit: input.limit
  });
  const revisions = new Map(sources.map((source) => [source.publicId, source.revision]));
  return {
    items: page.items
      .filter((item) => revisions.has(item.sourceFilePublicId))
      .map((item) => toSearchItem(
        item,
        revisions.get(item.sourceFilePublicId)!,
        input.knowledgeBaseId
      )),
    nextCursor: page.nextCursor
      ? encodeTreeSearchCursor(filePhaseCursor(input.scope, page.nextCursor))
      : null
  };
}

function treeScope(
  request: Parameters<StorageVnextAdminReadApplication["listTree"]>[0],
  activationRevision: number
) {
  return JSON.stringify({
    knowledgeBaseId: request.knowledgeBaseId,
    activationRevision,
    parentPath: request.parentPath,
    entryType: request.entryType,
    query: request.query?.trim().toLocaleLowerCase("en-US") ?? ""
  });
}

function treeSearchScope(
  request: Parameters<StorageVnextAdminReadApplication["searchFiles"]>[0],
  activationRevision: number
) {
  return JSON.stringify({
    knowledgeBaseId: request.knowledgeBaseId,
    activationRevision,
    query: request.query.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US")
  });
}

function encodeTreeCursor(cursor: TreeCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeTreeCursor(value: string | null, scope: string): TreeCursor | null {
  if (!value) return null;
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as TreeCursor;
  if (
    parsed.version !== 1 || parsed.scope !== scope || !parsed.logicalPath || !parsed.recordId
  ) throw new Error("Invalid storage vNext tree cursor");
  return parsed;
}

function filePhaseCursor(scope: string, fileCursor: string | null): TreeSearchCursor {
  return {
    version: 1,
    scope,
    phase: "files",
    logicalPath: null,
    recordId: null,
    fileCursor
  };
}

function generatedFilePhaseCursor(
  scope: string,
  logicalPath: string | null,
  recordId: string | null
): TreeSearchCursor {
  return {
    version: 1,
    scope,
    phase: "generated-files",
    logicalPath,
    recordId,
    fileCursor: null
  };
}

function encodeTreeSearchCursor(cursor: TreeSearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeTreeSearchCursor(value: string | null, scope: string): TreeSearchCursor {
  if (!value) {
    return {
      version: 1,
      scope,
      phase: "directories",
      logicalPath: null,
      recordId: null,
      fileCursor: null
    };
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as TreeSearchCursor;
    const validDirectoryCursor = parsed.phase === "directories"
      && typeof parsed.logicalPath === "string"
      && parsed.logicalPath.length > 0
      && typeof parsed.recordId === "string"
      && parsed.recordId.length > 0
      && parsed.fileCursor === null;
    const validGeneratedFileCursor = parsed.phase === "generated-files"
      && (
        (parsed.logicalPath === null && parsed.recordId === null)
        || (
          typeof parsed.logicalPath === "string"
          && parsed.logicalPath.length > 0
          && typeof parsed.recordId === "string"
          && parsed.recordId.length > 0
        )
      )
      && parsed.fileCursor === null;
    const validFileCursor = parsed.phase === "files"
      && parsed.logicalPath === null
      && parsed.recordId === null
      && (parsed.fileCursor === null || typeof parsed.fileCursor === "string");
    if (
      parsed.version !== 1
      || parsed.scope !== scope
      || (!validDirectoryCursor && !validGeneratedFileCursor && !validFileCursor)
    ) throw new Error("Invalid storage vNext tree search cursor");
    return parsed;
  } catch {
    const error = new Error("Invalid storage vNext tree search cursor") as Error & {
      code: string;
    };
    error.code = "INVALID_SEARCH_CURSOR";
    throw error;
  }
}

function fileKind(row: TreeRow): string {
  if (row.source_file_public_id) return "page";
  if (row.logical_path === "index.md") return "index";
  if (row.logical_path === "log.md") return "log";
  if (row.logical_path.startsWith("_graph/")) return "graph_index";
  if (row.logical_path.startsWith("_index/")) return "search_index";
  return row.entry_kind === "directory" ? "index" : row.entry_kind ?? "index";
}

function parentPathOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function ancestorPaths(path: string): string[] {
  if (!path) return [];
  const segments = path.split("/").filter(Boolean);
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

function stableGeneratedDirectoryId(
  knowledgeBaseId: string,
  logicalPath: string
): string {
  return `generated-directory-${createHash("md5")
    .update(`${knowledgeBaseId}:${logicalPath}`)
    .digest("hex")}`;
}

function toCount(value: number | string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid storage vNext count");
  return count;
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error
    && (error as { code?: unknown }).code === code);
}

function success<T>(value: T): StorageVnextAdminApplicationResult<T> {
  return { ok: true, value };
}

function unavailable(): StorageVnextAdminApplicationResult<never> {
  return { ok: false, code: "DATABASE_REPOSITORY_UNAVAILABLE" };
}

function invalidPagination(): StorageVnextAdminApplicationResult<never> {
  return { ok: false, code: "INVALID_PAGINATION" };
}

function notFound(): StorageVnextAdminApplicationResult<never> {
  return { ok: false, code: "NOT_FOUND" };
}
