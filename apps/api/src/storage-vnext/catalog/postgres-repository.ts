import { createHash } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import {
  normalizeSourceDirectoryPath,
  normalizeSourceRelativePath
} from "../../domain/source-path.js";
import type {
  StorageVnextCatalogReadVisibility,
  StorageVnextCatalogRepository,
  StorageVnextCurrentSourceFact,
  StorageVnextDirectoryFact,
  StorageVnextKnowledgeBaseFact,
  StorageVnextSourceFileFact,
  StorageVnextSourceFileStatus,
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
  | "revision_conflict"
  | "immutable_revision_conflict"
  | "object_unverified";

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
  status: StorageVnextSourceFileStatus;
  safe_error_code: string | null;
  safe_error_message: string | null;
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

type ReadSql = DatabaseClient | TransactionSql;

const SOURCE_FILE_COLUMNS = `
  source.public_id, source.knowledge_base_id, source.directory_public_id,
  source.logical_path, source.normalized_path, source.title, source.metadata,
  current_revision.source_revision_public_id AS current_revision_public_id,
  source.status, source.safe_error_code, source.safe_error_message,
  source.revision, source.deleted_at
`;

export function createPostgresStorageVnextCatalogRepository(
  sql: DatabaseClient
): StorageVnextCatalogRepository {
  return {
    async createKnowledgeBase(input) {
      try {
        const rows = await sql<KnowledgeBaseRow[]>`
          INSERT INTO focowiki.knowledge_bases
            (public_id, name, description, revision)
          VALUES (${input.publicId}, ${input.name}, ${input.description}, 1)
          RETURNING public_id, name, description, revision, created_at, updated_at, deleted_at
        `;
        return mapKnowledgeBase(requireRow(rows[0]));
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
            revision = revision + 1,
            updated_at = now()
        WHERE public_id = ${input.knowledgeBaseId}
          AND revision = ${input.revisionCheck.expectedRevision}
          AND deleted_at IS NULL
        RETURNING public_id, name, description, revision, created_at, updated_at, deleted_at
      `;
      if (!rows[0]) throw new StorageVnextCatalogRepositoryError("revision_conflict");
      return mapKnowledgeBase(rows[0]);
    },

    async getKnowledgeBase(input) {
      const visibility = input.visibility ?? "current";
      const rows = await sql<KnowledgeBaseRow[]>`
        SELECT public_id, name, description, revision, created_at, updated_at, deleted_at
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
      const cursor = decodeCursor({
        cursor: input.cursor,
        kind: "knowledge_base",
        scope: `${visibility}:${query ?? ""}`
      });
      const rows = await sql<KnowledgeBaseRow[]>`
        SELECT public_id, name, description, revision, created_at, updated_at, deleted_at
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
          kind: "knowledge_base",
          scope: `${visibility}:${query ?? ""}`,
          normalizedPath: null,
          publicId: row.public_id
        }));
    },

    async createDirectory(input) {
      const path = normalizeSourceDirectoryPath(input.logicalPath);
      await assertDirectoryParent(sql, {
        knowledgeBaseId: input.knowledgeBaseId,
        parentPublicId: input.parentPublicId,
        parentLogicalPath: path.parentPath
      });
      try {
        const rows = await sql<DirectoryRow[]>`
          INSERT INTO focowiki.source_directories
            (public_id, knowledge_base_id, parent_public_id, logical_path,
             normalized_path, title, revision)
          VALUES (${input.publicId}, ${input.knowledgeBaseId}, ${input.parentPublicId},
            ${path.relativePath}, ${path.pathKey}, ${input.title}, 1)
          RETURNING public_id, knowledge_base_id, parent_public_id, logical_path,
                    normalized_path, title, revision, deleted_at
        `;
        return mapDirectory(requireRow(rows[0]));
      } catch (error) {
        throw mapDatabaseError(error);
      }
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
          AND (
            ${cursor?.normalizedPath ?? null}::text IS NULL
            OR normalized_path COLLATE "C" > ${cursor?.normalizedPath ?? null}::text COLLATE "C"
            OR (normalized_path = ${cursor?.normalizedPath ?? null}
              AND public_id COLLATE "C" > ${cursor?.publicId ?? null}::text COLLATE "C")
          )
        ORDER BY normalized_path COLLATE "C", public_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      return pageRows(rows, limit, mapDirectory, (row) =>
        encodeStorageVnextCatalogCursor({
          kind: "directory",
          scope,
          normalizedPath: row.normalized_path,
          publicId: row.public_id
        }));
    },

    async listDirectoriesByPublicIds(input) {
      const limit = assertLimit(input.limit, 2_000);
      const publicIds = [...new Set(input.publicIds)].slice(0, limit);
      if (publicIds.length === 0) return [];
      const rows = await sql<Array<DirectoryRow & { ordinal: number }>>`
        WITH requested AS (
          SELECT public_id, ordinal
          FROM unnest(${publicIds}::text[])
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
         AND EXISTS (
           SELECT 1 FROM focowiki.knowledge_bases knowledge_base
           WHERE knowledge_base.public_id = directory.knowledge_base_id
             AND knowledge_base.deleted_at IS NULL
         )
        ORDER BY requested.ordinal
      `;
      return rows.map(mapDirectory);
    },

    async createSourceFile(input) {
      const path = normalizeSourceRelativePath(input.logicalPath);
      await assertSourceDirectory(sql, {
        knowledgeBaseId: input.knowledgeBaseId,
        directoryPublicId: input.directoryPublicId,
        directoryLogicalPath: path.directoryPath
      });
      try {
        const rows = await sql<SourceFileRow[]>`
          WITH inserted AS (
            INSERT INTO focowiki.source_files
              (public_id, knowledge_base_id, directory_public_id, logical_path,
               normalized_path, title, metadata, status, revision,
               safe_error_code, safe_error_message)
            VALUES (${input.publicId}, ${input.knowledgeBaseId}, ${input.directoryPublicId},
              ${path.relativePath}, ${path.pathKey}, ${input.title},
              ${sql.json(input.metadata as never)}, ${input.status}, 1,
              ${input.safeErrorCode ?? null}, ${input.safeErrorMessage ?? null})
            RETURNING *
          )
          SELECT inserted.public_id, inserted.knowledge_base_id,
                 inserted.directory_public_id, inserted.logical_path,
                 inserted.normalized_path, inserted.title, inserted.metadata,
                 NULL::text AS current_revision_public_id, inserted.status,
                 inserted.safe_error_code, inserted.safe_error_message,
                 inserted.revision, inserted.deleted_at
          FROM inserted
        `;
        return mapSourceFile(requireRow(rows[0]));
      } catch (error) {
        throw mapDatabaseError(error);
      }
    },

    async getSourceFile(input) {
      return getSourceFile(sql, input.knowledgeBaseId, input.publicId, input.visibility ?? "current");
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
        LEFT JOIN focowiki.source_file_current_revisions current_revision
          ON current_revision.knowledge_base_id = source.knowledge_base_id
         AND current_revision.source_file_public_id = source.public_id
        WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
          ${directory}
          ${visibilitySql(sql, "source", visibility)}
          ${knowledgeBaseVisibilitySql(sql, input.knowledgeBaseId, visibility)}
          AND (
            ${cursor?.normalizedPath ?? null}::text IS NULL
            OR source.normalized_path COLLATE "C"
              > ${cursor?.normalizedPath ?? null}::text COLLATE "C"
            OR (source.normalized_path = ${cursor?.normalizedPath ?? null}
              AND source.public_id COLLATE "C"
                > ${cursor?.publicId ?? null}::text COLLATE "C")
          )
        ORDER BY source.normalized_path COLLATE "C", source.public_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      return pageRows(rows, limit, mapSourceFile, (row) =>
        encodeStorageVnextCatalogCursor({
          kind: "source_file",
          scope,
          normalizedPath: row.normalized_path,
          publicId: row.public_id
        }));
    },

    async listSourceFilesByPublicIds(input) {
      const limit = assertLimit(input.limit, 2_000);
      const publicIds = [...new Set(input.publicIds)].slice(0, limit);
      if (publicIds.length === 0) return [];
      const rows = await sql<Array<SourceFileRow & { ordinal: number }>>`
        WITH requested AS (
          SELECT public_id, ordinal
          FROM unnest(${publicIds}::text[])
            WITH ORDINALITY AS item(public_id, ordinal)
        )
        SELECT ${sql.unsafe(SOURCE_FILE_COLUMNS)}, requested.ordinal::int
        FROM requested
        JOIN focowiki.source_files source
          ON source.public_id = requested.public_id
         AND source.knowledge_base_id = ${input.knowledgeBaseId}
         AND source.deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM focowiki.knowledge_bases knowledge_base
           WHERE knowledge_base.public_id = source.knowledge_base_id
             AND knowledge_base.deleted_at IS NULL
         )
        LEFT JOIN focowiki.source_file_current_revisions current_revision
          ON current_revision.knowledge_base_id = source.knowledge_base_id
         AND current_revision.source_file_public_id = source.public_id
        ORDER BY requested.ordinal
      `;
      return rows.map(mapSourceFile);
    },

    async listCurrentSources(input) {
      const limit = assertLimit(input.limit, 1_000);
      const scope = `${input.knowledgeBaseId}:current`;
      const cursor = decodeCursor({
        cursor: input.cursor,
        kind: "current_source",
        scope
      });
      const rows = await sql<CurrentSourceRow[]>`
        SELECT ${sql.unsafe(SOURCE_FILE_COLUMNS)},
               revision.public_id AS source_revision_public_id,
               revision.object_id AS source_revision_object_id,
               revision.checksum_sha256 AS source_revision_checksum_sha256,
               revision.byte_count AS source_revision_byte_count,
               revision.content_type AS source_revision_content_type,
               revision.created_at AS source_revision_created_at
        FROM focowiki.source_files source
        JOIN focowiki.source_file_current_revisions current_revision
          ON current_revision.knowledge_base_id = source.knowledge_base_id
         AND current_revision.source_file_public_id = source.public_id
        JOIN focowiki.source_revisions revision
          ON revision.knowledge_base_id = current_revision.knowledge_base_id
         AND revision.source_file_public_id = current_revision.source_file_public_id
         AND revision.public_id = current_revision.source_revision_public_id
        WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
          AND source.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM focowiki.knowledge_bases knowledge_base
            WHERE knowledge_base.public_id = source.knowledge_base_id
              AND knowledge_base.deleted_at IS NULL
          )
          AND (
            ${cursor?.normalizedPath ?? null}::text IS NULL
            OR source.normalized_path COLLATE "C"
              > ${cursor?.normalizedPath ?? null}::text COLLATE "C"
            OR (source.normalized_path = ${cursor?.normalizedPath ?? null}
              AND source.public_id COLLATE "C"
                > ${cursor?.publicId ?? null}::text COLLATE "C")
          )
        ORDER BY source.normalized_path COLLATE "C", source.public_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      return pageRows(rows, limit, mapCurrentSource, (row) =>
        encodeStorageVnextCatalogCursor({
          kind: "current_source",
          scope,
          normalizedPath: row.normalized_path,
          publicId: row.public_id
        }));
    },

    async updateSourceFileState(input) {
      const rows = await sql<SourceFileRow[]>`
        WITH updated AS (
          UPDATE focowiki.source_files
          SET metadata = ${sql.json(input.metadata as never)},
              status = ${input.status},
              safe_error_code = ${input.safeErrorCode},
              safe_error_message = ${input.safeErrorMessage},
              revision = revision + 1,
              updated_at = now()
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND public_id = ${input.publicId}
            AND revision = ${input.revisionCheck.expectedRevision}
            AND deleted_at IS NULL
          RETURNING *
        )
        SELECT updated.public_id, updated.knowledge_base_id,
               updated.directory_public_id, updated.logical_path,
               updated.normalized_path, updated.title, updated.metadata,
               current_revision.source_revision_public_id AS current_revision_public_id,
               updated.status, updated.safe_error_code, updated.safe_error_message,
               updated.revision, updated.deleted_at
        FROM updated
        LEFT JOIN focowiki.source_file_current_revisions current_revision
          ON current_revision.knowledge_base_id = updated.knowledge_base_id
         AND current_revision.source_file_public_id = updated.public_id
      `;
      if (!rows[0]) throw new StorageVnextCatalogRepositoryError("revision_conflict");
      return mapSourceFile(rows[0]);
    },

    async createImmutableRevision(revision) {
      return createImmutableRevision(sql, revision);
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
        FROM focowiki.source_file_current_revisions current_revision
        JOIN focowiki.source_revisions revision
          ON revision.knowledge_base_id = current_revision.knowledge_base_id
         AND revision.source_file_public_id = current_revision.source_file_public_id
         AND revision.public_id = current_revision.source_revision_public_id
        JOIN focowiki.source_files source
          ON source.knowledge_base_id = current_revision.knowledge_base_id
         AND source.public_id = current_revision.source_file_public_id
         AND source.deleted_at IS NULL
        JOIN focowiki.knowledge_bases knowledge_base
          ON knowledge_base.public_id = source.knowledge_base_id
         AND knowledge_base.deleted_at IS NULL
        WHERE current_revision.knowledge_base_id = ${input.knowledgeBaseId}
          AND current_revision.source_file_public_id = ${input.sourceFilePublicId}
        LIMIT 1
      `;
      return rows[0] ? mapSourceRevision(rows[0]) : null;
    },

    async listSourceRevisions(input) {
      const limit = assertLimit(input.limit, 1_000);
      const cursor = decodeCursor({
        cursor: input.cursor,
        kind: "source_revision",
        scope: input.knowledgeBaseId
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
            OR revision.public_id COLLATE "C"
              > ${cursor?.publicId ?? null}::text COLLATE "C")
        ORDER BY revision.public_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      return pageRows(rows, limit, mapSourceRevision, (row) =>
        encodeStorageVnextCatalogCursor({
          kind: "source_revision",
          scope: input.knowledgeBaseId,
          normalizedPath: null,
          publicId: row.public_id
        }));
    },

    async compareAndSetCurrentRevision(input) {
      return compareAndSetCurrentRevision(sql, input);
    },

    async updateLogicalPath(input) {
      const path = normalizeSourceRelativePath(input.logicalPath);
      try {
        return await sql.begin(async (transaction) => {
          const source = await transaction<Array<{ directory_public_id: string | null }>>`
            SELECT directory_public_id
            FROM focowiki.source_files
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
              AND public_id = ${input.publicId}
              AND revision = ${input.revisionCheck.expectedRevision}
              AND deleted_at IS NULL
            FOR UPDATE
          `;
          if (!source[0]) throw new StorageVnextCatalogRepositoryError("revision_conflict");
          await assertSourceDirectory(transaction, {
            knowledgeBaseId: input.knowledgeBaseId,
            directoryPublicId: source[0].directory_public_id,
            directoryLogicalPath: path.directoryPath
          });
          const rows = await transaction<SourceFileRow[]>`
            WITH updated AS (
              UPDATE focowiki.source_files
              SET logical_path = ${path.relativePath}, normalized_path = ${path.pathKey},
                  revision = revision + 1, updated_at = now()
              WHERE knowledge_base_id = ${input.knowledgeBaseId}
                AND public_id = ${input.publicId}
                AND revision = ${input.revisionCheck.expectedRevision}
                AND deleted_at IS NULL
              RETURNING *
            )
            SELECT updated.public_id, updated.knowledge_base_id,
                   updated.directory_public_id, updated.logical_path,
                   updated.normalized_path, updated.title, updated.metadata,
                   current_revision.source_revision_public_id AS current_revision_public_id,
                   updated.status, updated.safe_error_code, updated.safe_error_message,
                   updated.revision, updated.deleted_at
            FROM updated
            LEFT JOIN focowiki.source_file_current_revisions current_revision
              ON current_revision.knowledge_base_id = updated.knowledge_base_id
             AND current_revision.source_file_public_id = updated.public_id
          `;
          if (!rows[0]) throw new StorageVnextCatalogRepositoryError("revision_conflict");
          return mapSourceFile(rows[0]);
        }) as StorageVnextSourceFileFact;
      } catch (error) {
        throw mapDatabaseError(error);
      }
    },

    async moveSourceFile(input) {
      const path = normalizeSourceRelativePath(input.logicalPath);
      try {
        return await sql.begin(async (transaction) => {
          const sources = await transaction<Array<{ public_id: string }>>`
            SELECT public_id
            FROM focowiki.source_files
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
              AND public_id = ${input.publicId}
              AND revision = ${input.revisionCheck.expectedRevision}
              AND deleted_at IS NULL
            FOR UPDATE
          `;
          if (!sources[0]) {
            throw new StorageVnextCatalogRepositoryError("revision_conflict");
          }
          await assertSourceDirectory(transaction, {
            knowledgeBaseId: input.knowledgeBaseId,
            directoryPublicId: input.directoryPublicId,
            directoryLogicalPath: path.directoryPath
          });
          const rows = await transaction<SourceFileRow[]>`
            WITH updated AS (
              UPDATE focowiki.source_files
              SET directory_public_id = ${input.directoryPublicId},
                  logical_path = ${path.relativePath},
                  normalized_path = ${path.pathKey},
                  revision = revision + 1,
                  updated_at = now()
              WHERE knowledge_base_id = ${input.knowledgeBaseId}
                AND public_id = ${input.publicId}
                AND revision = ${input.revisionCheck.expectedRevision}
                AND deleted_at IS NULL
              RETURNING *
            )
            SELECT updated.public_id, updated.knowledge_base_id,
                   updated.directory_public_id, updated.logical_path,
                   updated.normalized_path, updated.title, updated.metadata,
                   current_revision.source_revision_public_id AS current_revision_public_id,
                   updated.status, updated.safe_error_code, updated.safe_error_message,
                   updated.revision, updated.deleted_at
            FROM updated
            LEFT JOIN focowiki.source_file_current_revisions current_revision
              ON current_revision.knowledge_base_id = updated.knowledge_base_id
             AND current_revision.source_file_public_id = updated.public_id
          `;
          if (!rows[0]) {
            throw new StorageVnextCatalogRepositoryError("revision_conflict");
          }
          return mapSourceFile(rows[0]);
        }) as StorageVnextSourceFileFact;
      } catch (error) {
        throw mapDatabaseError(error);
      }
    },

    async markSourceFileDeleted(input) {
      await markDeleted(sql, "source_files", input);
    },

    async markDirectoryDeleted(input) {
      await markDeleted(sql, "source_directories", input);
    },

    async markKnowledgeBaseDeleted(input) {
      const rows = await sql`
        UPDATE focowiki.knowledge_bases
        SET deleted_at = ${input.deletedAt}, revision = revision + 1, updated_at = now()
        WHERE public_id = ${input.knowledgeBaseId}
          AND revision = ${input.revisionCheck.expectedRevision}
          AND deleted_at IS NULL
        RETURNING public_id
      `;
      if (!rows[0]) throw new StorageVnextCatalogRepositoryError("revision_conflict");
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
    LEFT JOIN focowiki.source_file_current_revisions current_revision
      ON current_revision.knowledge_base_id = source.knowledge_base_id
     AND current_revision.source_file_public_id = source.public_id
    WHERE source.knowledge_base_id = ${knowledgeBaseId}
      AND source.public_id = ${publicId}
      ${visibilitySql(sql, "source", visibility)}
      ${knowledgeBaseVisibilitySql(sql, knowledgeBaseId, visibility)}
    LIMIT 1
  `;
  return rows[0] ? mapSourceFile(rows[0]) : null;
}

async function createImmutableRevision(
  sql: DatabaseClient,
  revision: StorageVnextSourceRevisionFact
): Promise<StorageVnextSourceRevisionFact> {
  return sql.begin(async (transaction) => {
    const existing = await readRevision(transaction, revision.knowledgeBaseId, revision.publicId);
    if (existing) {
      if (sameRevision(existing, revision)) return existing;
      throw new StorageVnextCatalogRepositoryError("immutable_revision_conflict");
    }
    const objects = await transaction<Array<{ object_id: string }>>`
      SELECT object_id
      FROM focowiki.object_registrations
      WHERE object_id = ${revision.objectId}
        AND checksum_sha256 = ${revision.checksum}
        AND byte_count = ${revision.byteCount}
        AND content_type = ${revision.contentType}
        AND object_format = 'source-markdown-v1'
        AND state = 'verified'
      LIMIT 1
    `;
    if (!objects[0]) throw new StorageVnextCatalogRepositoryError("object_unverified");
    try {
      const rows = await transaction<SourceRevisionRow[]>`
        INSERT INTO focowiki.source_revisions
          (public_id, knowledge_base_id, source_file_public_id, object_id,
           checksum_sha256, byte_count, content_type, revision_role,
           expires_at, created_at)
        VALUES (${revision.publicId}, ${revision.knowledgeBaseId},
          ${revision.sourceFilePublicId}, ${revision.objectId}, ${revision.checksum},
          ${revision.byteCount}, ${revision.contentType}, 'candidate',
          ${candidateExpiry(revision.createdAt)}, ${revision.createdAt})
        ON CONFLICT (public_id) DO NOTHING
        RETURNING public_id, source_file_public_id, knowledge_base_id, object_id,
                  checksum_sha256, byte_count, content_type, created_at
      `;
      const stored = rows[0]
        ? mapSourceRevision(rows[0])
        : await readRevision(transaction, revision.knowledgeBaseId, revision.publicId);
      if (!stored || !sameRevision(stored, revision)) {
        throw new StorageVnextCatalogRepositoryError("immutable_revision_conflict");
      }
      await transaction`
        INSERT INTO focowiki.object_owners
          (public_id, knowledge_base_id, object_id, owner_kind,
           source_revision_public_id)
        VALUES (${sourceRevisionOwnerId(stored)}, ${stored.knowledgeBaseId},
          ${stored.objectId}, 'source_revision', ${stored.publicId})
        ON CONFLICT (object_id, owner_kind, owner_public_id) DO NOTHING
      `;
      return stored;
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }) as Promise<StorageVnextSourceRevisionFact>;
}

async function compareAndSetCurrentRevision(
  sql: DatabaseClient,
  input: {
    knowledgeBaseId: string;
    sourceFilePublicId: string;
    revisionPublicId: string;
    revisionCheck: { expectedRevision: number };
  }
): Promise<StorageVnextSourceFileFact> {
  await sql.begin(async (transaction) => {
    const revisions = await transaction<Array<{ public_id: string }>>`
      SELECT revision.public_id
      FROM focowiki.source_revisions revision
      JOIN focowiki.object_registrations object_registration
        ON object_registration.object_id = revision.object_id
       AND object_registration.state = 'verified'
      JOIN focowiki.object_owners owner
        ON owner.knowledge_base_id = revision.knowledge_base_id
       AND owner.source_revision_public_id = revision.public_id
       AND owner.object_id = revision.object_id
       AND owner.owner_kind = 'source_revision'
      WHERE revision.knowledge_base_id = ${input.knowledgeBaseId}
        AND revision.source_file_public_id = ${input.sourceFilePublicId}
        AND revision.public_id = ${input.revisionPublicId}
      LIMIT 1
    `;
    if (!revisions[0]) throw new StorageVnextCatalogRepositoryError("object_unverified");
    const previous = await transaction<Array<{ source_revision_public_id: string }>>`
      SELECT source_revision_public_id
      FROM focowiki.source_file_current_revisions
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND source_file_public_id = ${input.sourceFilePublicId}
    `;
    const updated = await transaction<Array<{ revision: number }>>`
      UPDATE focowiki.source_files
      SET revision = revision + 1, updated_at = now()
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND public_id = ${input.sourceFilePublicId}
        AND revision = ${input.revisionCheck.expectedRevision}
        AND deleted_at IS NULL
      RETURNING revision
    `;
    if (!updated[0]) throw new StorageVnextCatalogRepositoryError("revision_conflict");
    await transaction`
      INSERT INTO focowiki.source_file_current_revisions
        (knowledge_base_id, source_file_public_id, source_revision_public_id, revision)
      VALUES (${input.knowledgeBaseId}, ${input.sourceFilePublicId},
        ${input.revisionPublicId}, 1)
      ON CONFLICT (knowledge_base_id, source_file_public_id)
      DO UPDATE SET source_revision_public_id = excluded.source_revision_public_id,
                    revision = focowiki.source_file_current_revisions.revision + 1
    `;
    const previousRevisionId = previous[0]?.source_revision_public_id;
    if (previousRevisionId && previousRevisionId !== input.revisionPublicId) {
      await transaction`
        UPDATE focowiki.source_revisions
        SET revision_role = 'rollback', expires_at = now() + interval '24 hours'
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_file_public_id = ${input.sourceFilePublicId}
          AND public_id = ${previousRevisionId}
      `;
    }
    await transaction`
      UPDATE focowiki.source_revisions
      SET revision_role = 'current', expires_at = NULL
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND source_file_public_id = ${input.sourceFilePublicId}
        AND public_id = ${input.revisionPublicId}
    `;
  });
  const source = await getSourceFile(sql, input.knowledgeBaseId, input.sourceFilePublicId, "current");
  if (!source) throw new StorageVnextCatalogRepositoryError("revision_conflict");
  return source;
}

async function readRevision(
  sql: ReadSql,
  knowledgeBaseId: string,
  publicId: string
): Promise<StorageVnextSourceRevisionFact | null> {
  const rows = await sql<SourceRevisionRow[]>`
    SELECT public_id, source_file_public_id, knowledge_base_id, object_id,
           checksum_sha256, byte_count, content_type, created_at
    FROM focowiki.source_revisions
    WHERE knowledge_base_id = ${knowledgeBaseId} AND public_id = ${publicId}
    LIMIT 1
  `;
  return rows[0] ? mapSourceRevision(rows[0]) : null;
}

async function assertDirectoryParent(
  sql: DatabaseClient,
  input: {
    knowledgeBaseId: string;
    parentPublicId: string | null;
    parentLogicalPath: string;
  }
): Promise<void> {
  if (!input.parentPublicId) {
    if (input.parentLogicalPath) throw new StorageVnextCatalogRepositoryError("scope_conflict");
    return;
  }
  const rows = await sql<Array<{ logical_path: string }>>`
    SELECT logical_path
    FROM focowiki.source_directories
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND public_id = ${input.parentPublicId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!rows[0] || rows[0].logical_path !== input.parentLogicalPath) {
    throw new StorageVnextCatalogRepositoryError("scope_conflict");
  }
}

async function assertSourceDirectory(
  sql: ReadSql,
  input: {
    knowledgeBaseId: string;
    directoryPublicId: string | null;
    directoryLogicalPath: string;
  }
): Promise<void> {
  if (!input.directoryPublicId) {
    if (input.directoryLogicalPath) throw new StorageVnextCatalogRepositoryError("scope_conflict");
    return;
  }
  const rows = await sql<Array<{ logical_path: string }>>`
    SELECT logical_path
    FROM focowiki.source_directories
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND public_id = ${input.directoryPublicId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!rows[0] || rows[0].logical_path !== input.directoryLogicalPath) {
    throw new StorageVnextCatalogRepositoryError("scope_conflict");
  }
}

async function markDeleted(
  sql: DatabaseClient,
  table: "source_files" | "source_directories",
  input: {
    knowledgeBaseId: string;
    publicId: string;
    revisionCheck: { expectedRevision: number };
    deletedAt: string;
  }
): Promise<void> {
  const rows = await sql`
    UPDATE ${sql.unsafe(`focowiki.${table}`)}
    SET deleted_at = ${input.deletedAt}, revision = revision + 1
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND public_id = ${input.publicId}
      AND revision = ${input.revisionCheck.expectedRevision}
      AND deleted_at IS NULL
    RETURNING public_id
  `;
  if (!rows[0]) throw new StorageVnextCatalogRepositoryError("revision_conflict");
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
    status: row.status,
    safeErrorCode: row.safe_error_code,
    safeErrorMessage: row.safe_error_message,
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

function candidateExpiry(createdAt: string): string {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) {
    throw new StorageVnextCatalogRepositoryError("invalid_input");
  }
  return new Date(created.getTime() + 86_400_000).toISOString();
}

function sourceRevisionOwnerId(revision: StorageVnextSourceRevisionFact): string {
  return `source-owner-${createHash("sha256")
    .update(`${revision.knowledgeBaseId}:${revision.publicId}`)
    .digest("hex")}`;
}

function sameRevision(
  left: StorageVnextSourceRevisionFact,
  right: StorageVnextSourceRevisionFact
): boolean {
  return left.publicId === right.publicId
    && left.knowledgeBaseId === right.knowledgeBaseId
    && left.sourceFilePublicId === right.sourceFilePublicId
    && left.objectId === right.objectId
    && left.checksum === right.checksum
    && left.byteCount === right.byteCount
    && left.contentType === right.contentType;
}

function requireRow<T>(row: T | undefined): T {
  if (!row) throw new StorageVnextCatalogRepositoryError("resource_conflict");
  return row;
}

function mapDatabaseError(error: unknown): StorageVnextCatalogRepositoryError {
  const code = databaseErrorCode(error);
  const constraint = databaseConstraint(error);
  if (code === "23505" && constraint?.endsWith("_path_key")) {
    return new StorageVnextCatalogRepositoryError("normalized_path_conflict");
  }
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
    && typeof error.code === "string"
    ? error.code
    : null;
}

function databaseConstraint(error: unknown): string | null {
  return error && typeof error === "object" && "constraint_name" in error
    && typeof error.constraint_name === "string"
    ? error.constraint_name
    : null;
}
