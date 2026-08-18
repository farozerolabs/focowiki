import type { DatabaseClient } from "../../db/client.js";
import type {
  StorageVnextCatalogReadVisibility,
  StorageVnextCatalogRepository,
  StorageVnextCurrentSourceFact,
  StorageVnextDirectoryFact,
  StorageVnextKnowledgeBaseFact,
  StorageVnextSourceFileFact,
  StorageVnextSourceRevisionFact
} from "./ports.js";
import {
  decodeStorageVnextCatalogCursor,
  encodeStorageVnextCatalogCursor
} from "./cursor.js";

export type StorageVnextCatalogRepositoryErrorCode =
  | "invalid_input"
  | "invalid_cursor"
  | "resource_conflict"
  | "normalized_path_conflict"
  | "scope_conflict"
  | "revision_conflict";

export class StorageVnextCatalogRepositoryError extends Error {
  public constructor(public readonly code: StorageVnextCatalogRepositoryErrorCode) {
    super(`Storage vNext catalog repository error: ${code}`);
    this.name = "StorageVnextCatalogRepositoryError";
  }
}

type KnowledgeBaseRow = {
  public_id: string;
  name: string;
  description: string | null;
  revision: number | string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

type DirectoryRow = {
  public_id: string;
  knowledge_base_id: string;
  parent_public_id: string | null;
  logical_path: string;
  normalized_path: string;
  title: string;
  revision: number | string;
  deleted_at: Date | null;
};

type SourceFileRow = {
  public_id: string;
  knowledge_base_id: string;
  directory_public_id: string | null;
  logical_path: string;
  normalized_path: string;
  title: string;
  metadata: Record<string, boolean | number | string | null>;
  current_revision_public_id: string | null;
  revision: number | string;
  deleted_at: Date | null;
};

type SourceRevisionRow = {
  public_id: string;
  source_file_public_id: string;
  knowledge_base_id: string;
  object_id: string;
  checksum_sha256: string;
  byte_count: number | string;
  content_type: string;
  created_at: Date;
};

type CurrentSourceRow = SourceFileRow & {
  source_revision_public_id: string;
  source_revision_object_id: string;
  source_revision_checksum_sha256: string;
  source_revision_byte_count: number | string;
  source_revision_content_type: string;
  source_revision_created_at: Date;
};

const SOURCE_FILE_COLUMNS = `
  source.public_id, source.knowledge_base_id, source.directory_public_id,
  source.logical_path, source.normalized_path, source.title, source.metadata,
  active.current_source_revision_public_id AS current_revision_public_id,
  source.revision, source.deleted_at
`;

export function createPostgresStorageVnextCatalogRepository(
  sql: DatabaseClient
): StorageVnextCatalogRepository {
  return {
    async createKnowledgeBase(input) {
      try {
        return await sql.begin(async (transaction) => {
          const rows = await transaction<KnowledgeBaseRow[]>`
            INSERT INTO focowiki.knowledge_bases
              (public_id, name, description, revision)
            VALUES (${input.publicId}, ${input.name}, ${input.description}, 1)
            RETURNING public_id, name, description, revision,
                      created_at, updated_at, deleted_at
          `;
          await transaction`
            INSERT INTO focowiki.knowledge_base_sequences (
              knowledge_base_id, current_sequence
            ) VALUES (${input.publicId}, 0)
          `;
          return mapKnowledgeBase(requireRow(rows[0]));
        }) as StorageVnextKnowledgeBaseFact;
      } catch (error) {
        throw mapDatabaseError(error);
      }
    },

    async updateKnowledgeBase(input) {
      const rows = await sql<KnowledgeBaseRow[]>`
        UPDATE focowiki.knowledge_bases
        SET name = coalesce(${input.name ?? null}, name),
            description = CASE WHEN ${input.description === undefined}
              THEN description ELSE ${input.description ?? null} END,
            revision = revision + 1, updated_at = now()
        WHERE public_id = ${input.knowledgeBaseId}
          AND revision = ${input.revisionCheck.expectedRevision}
          AND deleted_at IS NULL
        RETURNING public_id, name, description, revision,
                  created_at, updated_at, deleted_at
      `;
      if (!rows[0]) throw new StorageVnextCatalogRepositoryError("revision_conflict");
      return mapKnowledgeBase(rows[0]);
    },

    async getKnowledgeBase(input) {
      const visibility = input.visibility ?? "current";
      const rows = await sql<KnowledgeBaseRow[]>`
        SELECT public_id, name, description, revision,
               created_at, updated_at, deleted_at
        FROM focowiki.knowledge_bases knowledge_base
        WHERE public_id = ${input.knowledgeBaseId}
          ${visibilitySql(sql, "knowledge_base", visibility)}
        LIMIT 1
      `;
      return rows[0] ? mapKnowledgeBase(rows[0]) : null;
    },

    async listKnowledgeBases(input) {
      const limit = assertLimit(input.limit, 1_000);
      const visibility = input.visibility ?? "current";
      const query = input.query?.trim().toLocaleLowerCase("en-US") || null;
      const scope = `${visibility}:${query ?? ""}`;
      const cursor = decodeCursor({ cursor: input.cursor, kind: "knowledge_base", scope });
      const rows = await sql<KnowledgeBaseRow[]>`
        SELECT public_id, name, description, revision,
               created_at, updated_at, deleted_at
        FROM focowiki.knowledge_bases knowledge_base
        WHERE (${query}::text IS NULL OR strpos(
            lower(public_id || ' ' || name || ' ' || coalesce(description, '')),
            ${query}
          ) > 0)
          AND (${cursor?.publicId ?? null}::text IS NULL
            OR public_id COLLATE "C" > ${cursor?.publicId ?? null}::text COLLATE "C")
          ${visibilitySql(sql, "knowledge_base", visibility)}
        ORDER BY public_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      return pageRows(rows, limit, mapKnowledgeBase, (row) =>
        encodeStorageVnextCatalogCursor({
          kind: "knowledge_base", scope, normalizedPath: null, publicId: row.public_id
        }));
    },

    async getDirectory(input) {
      const visibility = input.visibility ?? "current";
      const rows = await sql<DirectoryRow[]>`
        SELECT public_id, knowledge_base_id, parent_public_id, logical_path,
               normalized_path, title, revision, deleted_at
        FROM focowiki.source_directories directory
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND public_id = ${input.publicId}
          ${visibilitySql(sql, "directory", visibility)}
          ${knowledgeBaseVisibilitySql(sql, input.knowledgeBaseId, visibility)}
        LIMIT 1
      `;
      return rows[0] ? mapDirectory(rows[0]) : null;
    },

    async listDirectories(input) {
      const limit = assertLimit(input.limit, 1_000);
      const visibility = input.visibility ?? "current";
      const scope = `${input.knowledgeBaseId}:${input.parentPublicId === undefined
        ? "*" : input.parentPublicId ?? "root"}:${visibility}`;
      const cursor = decodeCursor({ cursor: input.cursor, kind: "directory", scope });
      const parent = input.parentPublicId === undefined
        ? sql``
        : sql`AND parent_public_id IS NOT DISTINCT FROM ${input.parentPublicId}`;
      const rows = await sql<DirectoryRow[]>`
        SELECT public_id, knowledge_base_id, parent_public_id, logical_path,
               normalized_path, title, revision, deleted_at
        FROM focowiki.source_directories directory
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          ${parent}
          ${visibilitySql(sql, "directory", visibility)}
          ${knowledgeBaseVisibilitySql(sql, input.knowledgeBaseId, visibility)}
          AND (${cursor?.normalizedPath ?? null}::text IS NULL
            OR normalized_path COLLATE "C"
              > ${cursor?.normalizedPath ?? null}::text COLLATE "C"
            OR (normalized_path = ${cursor?.normalizedPath ?? null}
              AND public_id COLLATE "C" > ${cursor?.publicId ?? null}::text COLLATE "C"))
        ORDER BY normalized_path COLLATE "C", public_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      return pageRows(rows, limit, mapDirectory, (row) =>
        encodeStorageVnextCatalogCursor({
          kind: "directory", scope,
          normalizedPath: row.normalized_path, publicId: row.public_id
        }));
    },

    async listDirectoriesByPublicIds(input) {
      const limit = assertLimit(input.limit, 2_000);
      const publicIds = [...new Set(input.publicIds)].slice(0, limit);
      if (publicIds.length === 0) return [];
      const rows = await sql<Array<DirectoryRow & { ordinal: number }>>`
        WITH requested AS (
          SELECT public_id, ordinal FROM unnest(${publicIds}::text[])
            WITH ORDINALITY AS item(public_id, ordinal)
        )
        SELECT directory.public_id, directory.knowledge_base_id,
               directory.parent_public_id, directory.logical_path,
               directory.normalized_path, directory.title, directory.revision,
               directory.deleted_at, requested.ordinal::int
        FROM requested
        JOIN focowiki.source_directories directory
          ON directory.public_id = requested.public_id
         AND directory.knowledge_base_id = ${input.knowledgeBaseId}
         AND directory.deleted_at IS NULL
        JOIN focowiki.knowledge_bases knowledge_base
          ON knowledge_base.public_id = directory.knowledge_base_id
         AND knowledge_base.deleted_at IS NULL
        ORDER BY requested.ordinal
      `;
      return rows.map(mapDirectory);
    },

    async getSourceFile(input) {
      return getSourceFile(sql, input.knowledgeBaseId, input.publicId,
        input.visibility ?? "current");
    },

    async listSourceFiles(input) {
      const limit = assertLimit(input.limit, 1_000);
      const visibility = input.visibility ?? "current";
      const scope = `${input.knowledgeBaseId}:${input.directoryPublicId === undefined
        ? "*" : input.directoryPublicId ?? "root"}:${visibility}`;
      const cursor = decodeCursor({ cursor: input.cursor, kind: "source_file", scope });
      const directory = input.directoryPublicId === undefined
        ? sql``
        : sql`AND source.directory_public_id IS NOT DISTINCT FROM ${input.directoryPublicId}`;
      const rows = await sql<SourceFileRow[]>`
        SELECT ${sql.unsafe(SOURCE_FILE_COLUMNS)}
        FROM focowiki.source_files source
        LEFT JOIN focowiki.source_file_active_revisions active
          ON active.knowledge_base_id = source.knowledge_base_id
         AND active.source_file_public_id = source.public_id
        WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
          ${directory}
          ${visibilitySql(sql, "source", visibility)}
          ${knowledgeBaseVisibilitySql(sql, input.knowledgeBaseId, visibility)}
          AND (${cursor?.normalizedPath ?? null}::text IS NULL
            OR source.normalized_path COLLATE "C"
              > ${cursor?.normalizedPath ?? null}::text COLLATE "C"
            OR (source.normalized_path = ${cursor?.normalizedPath ?? null}
              AND source.public_id COLLATE "C" > ${cursor?.publicId ?? null}::text COLLATE "C"))
        ORDER BY source.normalized_path COLLATE "C", source.public_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      return pageRows(rows, limit, mapSourceFile, (row) =>
        encodeStorageVnextCatalogCursor({
          kind: "source_file", scope,
          normalizedPath: row.normalized_path, publicId: row.public_id
        }));
    },

    async listSourceFilesByPublicIds(input) {
      const limit = assertLimit(input.limit, 2_000);
      const publicIds = [...new Set(input.publicIds)].slice(0, limit);
      if (publicIds.length === 0) return [];
      const rows = await sql<Array<SourceFileRow & { ordinal: number }>>`
        WITH requested AS (
          SELECT public_id, ordinal FROM unnest(${publicIds}::text[])
            WITH ORDINALITY AS item(public_id, ordinal)
        )
        SELECT ${sql.unsafe(SOURCE_FILE_COLUMNS)}, requested.ordinal::int
        FROM requested
        JOIN focowiki.source_files source
          ON source.public_id = requested.public_id
         AND source.knowledge_base_id = ${input.knowledgeBaseId}
         AND source.deleted_at IS NULL
        JOIN focowiki.knowledge_bases knowledge_base
          ON knowledge_base.public_id = source.knowledge_base_id
         AND knowledge_base.deleted_at IS NULL
        LEFT JOIN focowiki.source_file_active_revisions active
          ON active.knowledge_base_id = source.knowledge_base_id
         AND active.source_file_public_id = source.public_id
        ORDER BY requested.ordinal
      `;
      return rows.map(mapSourceFile);
    },

    async listCurrentSources(input) {
      const limit = assertLimit(input.limit, 1_000);
      const scope = `${input.knowledgeBaseId}:current`;
      const cursor = decodeCursor({ cursor: input.cursor, kind: "current_source", scope });
      const rows = await sql<CurrentSourceRow[]>`
        SELECT ${sql.unsafe(SOURCE_FILE_COLUMNS)},
               revision.public_id AS source_revision_public_id,
               revision.object_id AS source_revision_object_id,
               revision.checksum_sha256 AS source_revision_checksum_sha256,
               revision.byte_count AS source_revision_byte_count,
               revision.content_type AS source_revision_content_type,
               revision.created_at AS source_revision_created_at
        FROM focowiki.source_files source
        JOIN focowiki.source_file_active_revisions active
          ON active.knowledge_base_id = source.knowledge_base_id
         AND active.source_file_public_id = source.public_id
        JOIN focowiki.source_revisions revision
          ON revision.knowledge_base_id = active.knowledge_base_id
         AND revision.source_file_public_id = active.source_file_public_id
         AND revision.public_id = active.current_source_revision_public_id
        JOIN focowiki.knowledge_bases knowledge_base
          ON knowledge_base.public_id = source.knowledge_base_id
         AND knowledge_base.deleted_at IS NULL
        WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
          AND source.deleted_at IS NULL
          AND (${cursor?.normalizedPath ?? null}::text IS NULL
            OR source.normalized_path COLLATE "C"
              > ${cursor?.normalizedPath ?? null}::text COLLATE "C"
            OR (source.normalized_path = ${cursor?.normalizedPath ?? null}
              AND source.public_id COLLATE "C" > ${cursor?.publicId ?? null}::text COLLATE "C"))
        ORDER BY source.normalized_path COLLATE "C", source.public_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      return pageRows(rows, limit, mapCurrentSource, (row) =>
        encodeStorageVnextCatalogCursor({
          kind: "current_source", scope,
          normalizedPath: row.normalized_path, publicId: row.public_id
        }));
    },

    async getSourceRevision(input) {
      const rows = await sql<SourceRevisionRow[]>`
        SELECT revision.public_id, revision.source_file_public_id,
               revision.knowledge_base_id, revision.object_id,
               revision.checksum_sha256, revision.byte_count,
               revision.content_type, revision.created_at
        FROM focowiki.source_revisions revision
        JOIN focowiki.source_files source
          ON source.knowledge_base_id = revision.knowledge_base_id
         AND source.public_id = revision.source_file_public_id
         AND source.deleted_at IS NULL
        JOIN focowiki.knowledge_bases knowledge_base
          ON knowledge_base.public_id = revision.knowledge_base_id
         AND knowledge_base.deleted_at IS NULL
        WHERE revision.knowledge_base_id = ${input.knowledgeBaseId}
          AND revision.public_id = ${input.publicId}
        LIMIT 1
      `;
      return rows[0] ? mapSourceRevision(rows[0]) : null;
    },

    async getCurrentSourceRevision(input) {
      const rows = await sql<SourceRevisionRow[]>`
        SELECT revision.public_id, revision.source_file_public_id,
               revision.knowledge_base_id, revision.object_id,
               revision.checksum_sha256, revision.byte_count,
               revision.content_type, revision.created_at
        FROM focowiki.source_file_active_revisions active
        JOIN focowiki.source_revisions revision
          ON revision.knowledge_base_id = active.knowledge_base_id
         AND revision.source_file_public_id = active.source_file_public_id
         AND revision.public_id = active.current_source_revision_public_id
        JOIN focowiki.source_files source
          ON source.knowledge_base_id = active.knowledge_base_id
         AND source.public_id = active.source_file_public_id
         AND source.deleted_at IS NULL
        JOIN focowiki.knowledge_bases knowledge_base
          ON knowledge_base.public_id = source.knowledge_base_id
         AND knowledge_base.deleted_at IS NULL
        WHERE active.knowledge_base_id = ${input.knowledgeBaseId}
          AND active.source_file_public_id = ${input.sourceFilePublicId}
        LIMIT 1
      `;
      return rows[0] ? mapSourceRevision(rows[0]) : null;
    },

    async listSourceRevisions(input) {
      const limit = assertLimit(input.limit, 1_000);
      const cursor = decodeCursor({
        cursor: input.cursor, kind: "source_revision", scope: input.knowledgeBaseId
      });
      const rows = await sql<SourceRevisionRow[]>`
        SELECT revision.public_id, revision.source_file_public_id,
               revision.knowledge_base_id, revision.object_id,
               revision.checksum_sha256, revision.byte_count,
               revision.content_type, revision.created_at
        FROM focowiki.source_revisions revision
        JOIN focowiki.source_files source
          ON source.knowledge_base_id = revision.knowledge_base_id
         AND source.public_id = revision.source_file_public_id
         AND source.deleted_at IS NULL
        JOIN focowiki.knowledge_bases knowledge_base
          ON knowledge_base.public_id = revision.knowledge_base_id
         AND knowledge_base.deleted_at IS NULL
        WHERE revision.knowledge_base_id = ${input.knowledgeBaseId}
          AND (${cursor?.publicId ?? null}::text IS NULL
            OR revision.public_id COLLATE "C" > ${cursor?.publicId ?? null}::text COLLATE "C")
        ORDER BY revision.public_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      return pageRows(rows, limit, mapSourceRevision, (row) =>
        encodeStorageVnextCatalogCursor({
          kind: "source_revision", scope: input.knowledgeBaseId,
          normalizedPath: null, publicId: row.public_id
        }));
    }
  };
}

async function getSourceFile(
  sql: DatabaseClient,
  knowledgeBaseId: string,
  publicId: string,
  visibility: StorageVnextCatalogReadVisibility
): Promise<StorageVnextSourceFileFact | null> {
  const rows = await sql<SourceFileRow[]>`
    SELECT ${sql.unsafe(SOURCE_FILE_COLUMNS)}
    FROM focowiki.source_files source
    LEFT JOIN focowiki.source_file_active_revisions active
      ON active.knowledge_base_id = source.knowledge_base_id
     AND active.source_file_public_id = source.public_id
    WHERE source.knowledge_base_id = ${knowledgeBaseId}
      AND source.public_id = ${publicId}
      ${visibilitySql(sql, "source", visibility)}
      ${knowledgeBaseVisibilitySql(sql, knowledgeBaseId, visibility)}
    LIMIT 1
  `;
  return rows[0] ? mapSourceFile(rows[0]) : null;
}

function visibilitySql(
  sql: DatabaseClient,
  alias: string,
  visibility: StorageVnextCatalogReadVisibility
) {
  if (visibility === "all") return sql``;
  return visibility === "current"
    ? sql`AND ${sql.unsafe(`${alias}.deleted_at`)} IS NULL`
    : sql`AND ${sql.unsafe(`${alias}.deleted_at`)} IS NOT NULL`;
}

function knowledgeBaseVisibilitySql(
  sql: DatabaseClient,
  knowledgeBaseId: string,
  visibility: StorageVnextCatalogReadVisibility
) {
  if (visibility !== "current") return sql``;
  return sql`AND EXISTS (
    SELECT 1 FROM focowiki.knowledge_bases knowledge_base
    WHERE knowledge_base.public_id = ${knowledgeBaseId}
      AND knowledge_base.deleted_at IS NULL
  )`;
}

function mapKnowledgeBase(row: KnowledgeBaseRow): StorageVnextKnowledgeBaseFact {
  return {
    publicId: row.public_id,
    name: row.name,
    description: row.description,
    revision: Number(row.revision),
    visibility: row.deleted_at ? "deleted" : "current",
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapDirectory(row: DirectoryRow): StorageVnextDirectoryFact {
  return {
    publicId: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    parentPublicId: row.parent_public_id,
    logicalPath: row.logical_path,
    normalizedPath: row.normalized_path,
    title: row.title,
    revision: Number(row.revision),
    visibility: row.deleted_at ? "deleted" : "current"
  };
}

function mapSourceFile(row: SourceFileRow): StorageVnextSourceFileFact {
  return {
    publicId: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    directoryPublicId: row.directory_public_id,
    logicalPath: row.logical_path,
    normalizedPath: row.normalized_path,
    title: row.title,
    metadata: row.metadata,
    currentRevisionPublicId: row.current_revision_public_id,
    revision: Number(row.revision),
    visibility: row.deleted_at ? "deleted" : "current"
  };
}

function mapSourceRevision(row: SourceRevisionRow): StorageVnextSourceRevisionFact {
  return {
    publicId: row.public_id,
    sourceFilePublicId: row.source_file_public_id,
    knowledgeBaseId: row.knowledge_base_id,
    objectId: row.object_id,
    checksum: row.checksum_sha256,
    byteCount: Number(row.byte_count),
    contentType: row.content_type,
    createdAt: row.created_at.toISOString()
  };
}

function mapCurrentSource(row: CurrentSourceRow): StorageVnextCurrentSourceFact {
  return {
    sourceFile: mapSourceFile(row),
    sourceRevision: mapSourceRevision({
      public_id: row.source_revision_public_id,
      source_file_public_id: row.public_id,
      knowledge_base_id: row.knowledge_base_id,
      object_id: row.source_revision_object_id,
      checksum_sha256: row.source_revision_checksum_sha256,
      byte_count: row.source_revision_byte_count,
      content_type: row.source_revision_content_type,
      created_at: row.source_revision_created_at
    })
  };
}

function pageRows<T, R>(
  rows: T[],
  limit: number,
  map: (row: T) => R,
  cursor: (row: T) => string
) {
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map(map),
    nextCursor: rows.length > limit && last ? cursor(last) : null
  };
}

function decodeCursor(input: Parameters<typeof decodeStorageVnextCatalogCursor>[0]) {
  try {
    return decodeStorageVnextCatalogCursor(input);
  } catch {
    throw new StorageVnextCatalogRepositoryError("invalid_cursor");
  }
}

function assertLimit(limit: number, maximum: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new StorageVnextCatalogRepositoryError("invalid_input");
  }
  return limit;
}

function requireRow<T>(row: T | undefined): T {
  if (!row) throw new StorageVnextCatalogRepositoryError("resource_conflict");
  return row;
}

function mapDatabaseError(error: unknown): StorageVnextCatalogRepositoryError {
  const code = databaseErrorCode(error);
  if (code === "23503") return new StorageVnextCatalogRepositoryError("scope_conflict");
  if (code === "23514" || code === "22001" || code === "22P02") {
    return new StorageVnextCatalogRepositoryError("invalid_input");
  }
  if (code === "23505") return new StorageVnextCatalogRepositoryError("resource_conflict");
  return error instanceof StorageVnextCatalogRepositoryError
    ? error
    : new StorageVnextCatalogRepositoryError("resource_conflict");
}

function databaseErrorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error
    && typeof error.code === "string" ? error.code : null;
}
