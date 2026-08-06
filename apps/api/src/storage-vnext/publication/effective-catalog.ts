import type { DatabaseClient } from "../../db/client.js";
import type { StorageVnextEffectiveCatalogEntry } from "./types.js";

export type StorageVnextEffectiveCatalogPort = {
  listEffectiveCatalogEntries(input: {
    knowledgeBaseId: string;
    candidatePublicId: string;
    limit: number;
    cursor: string | null;
  }): Promise<{ items: StorageVnextEffectiveCatalogEntry[]; nextCursor: string | null }>;
  findMissingLogicalPaths(input: {
    knowledgeBaseId: string;
    candidatePublicId: string;
    logicalPaths: readonly string[];
  }): Promise<readonly string[]>;
};

type EffectiveEntryRow = {
  logical_path: string;
  entry_kind: StorageVnextEffectiveCatalogEntry["kind"];
  source_file_public_id: string | null;
  checksum_sha256: string;
  object_id: string;
  byte_count: number | string;
  ordinal: number | string;
  candidate_owned: boolean;
  sort_class: number | string;
};

export function createPostgresStorageVnextEffectiveCatalog(
  sql: DatabaseClient
): StorageVnextEffectiveCatalogPort {
  return {
    async listEffectiveCatalogEntries(input) {
      assertInput(input);
      const cursor = decodeCursor(input.cursor, input.candidatePublicId);
      const rows = await sql<EffectiveEntryRow[]>`
        WITH candidate_scope AS MATERIALIZED (
          SELECT candidate_root_public_id, expected_active_root_public_id
          FROM focowiki.release_candidates candidate
          WHERE candidate.public_id = ${input.candidatePublicId}
            AND candidate.knowledge_base_id = ${input.knowledgeBaseId}
            AND candidate.state IN ('building', 'validating', 'ready')
            AND EXISTS (
              SELECT 1 FROM focowiki.knowledge_bases knowledge_base
              WHERE knowledge_base.public_id = candidate.knowledge_base_id
                AND knowledge_base.deleted_at IS NULL
            )
        ), effective AS MATERIALIZED (
          SELECT entry.logical_path, entry.entry_kind,
                 entry.source_file_public_id, entry.checksum_sha256,
                 entry.object_id, entry.byte_count, entry.ordinal,
                 entry.root_owned AS candidate_owned
          FROM candidate_scope scope
          CROSS JOIN LATERAL focowiki.resolve_release_catalog(
            scope.candidate_root_public_id
          ) entry
          WHERE entry.source_file_public_id IS NULL
             OR EXISTS (
               SELECT 1 FROM focowiki.source_files source
               WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
                 AND source.public_id = entry.source_file_public_id
                 AND source.deleted_at IS NULL
             )
        ), ordered AS MATERIALIZED (
          SELECT effective.*,
                 CASE logical_path
                   WHEN 'index.md' THEN 0
                   WHEN 'pages/index.md' THEN 1
                   WHEN 'schema.md' THEN 2
                   WHEN 'log.md' THEN 3
                   WHEN '_index/index.md' THEN 4
                   WHEN '_graph/index.md' THEN 5
                   WHEN '_index/catalog.json' THEN 6
                   ELSE CASE
                     WHEN logical_path LIKE 'pages/%' THEN 7
                     WHEN logical_path LIKE '_index/%' THEN 8
                     WHEN logical_path LIKE '_graph/%' THEN 9
                     ELSE 10
                   END
                 END AS sort_class
          FROM effective
        )
        SELECT logical_path, entry_kind, source_file_public_id,
               checksum_sha256, object_id, byte_count, ordinal,
               candidate_owned, sort_class
        FROM ordered
        WHERE (
          ${cursor?.sortClass ?? null}::integer IS NULL
          OR (sort_class, logical_path COLLATE "C") >
             (${cursor?.sortClass ?? null}::integer, ${cursor?.logicalPath ?? null}::text COLLATE "C")
        )
        ORDER BY sort_class, logical_path COLLATE "C"
        LIMIT ${input.limit + 1}
      `;
      const items = rows.slice(0, input.limit).map(mapEntry);
      const last = items.at(-1);
      return {
        items,
        nextCursor: rows.length > input.limit && last
          ? encodeCursor({
              scope: input.candidatePublicId,
              sortClass: storageVnextEffectiveCatalogSortClass(last.logicalPath),
              logicalPath: last.logicalPath
            })
          : null
      };
    },

    async findMissingLogicalPaths(input) {
      if (
        !input.knowledgeBaseId
        || !input.candidatePublicId
        || input.logicalPaths.length > 1_000
        || input.logicalPaths.some((path) => !path)
      ) throw new Error("Storage vNext effective catalog input is invalid");
      if (input.logicalPaths.length === 0) return [];
      const rows = await sql<Array<{ logical_path: string }>>`
        WITH candidate_scope AS MATERIALIZED (
          SELECT candidate_root_public_id, expected_active_root_public_id
          FROM focowiki.release_candidates candidate
          WHERE candidate.public_id = ${input.candidatePublicId}
            AND candidate.knowledge_base_id = ${input.knowledgeBaseId}
            AND candidate.state IN ('building', 'validating', 'ready')
            AND EXISTS (
              SELECT 1 FROM focowiki.knowledge_bases knowledge_base
              WHERE knowledge_base.public_id = candidate.knowledge_base_id
                AND knowledge_base.deleted_at IS NULL
            )
        )
        SELECT entry.logical_path
        FROM candidate_scope scope
        CROSS JOIN LATERAL focowiki.resolve_release_catalog(
          scope.candidate_root_public_id
        ) entry
        WHERE entry.logical_path = ANY(${input.logicalPaths})
          AND (
            entry.source_file_public_id IS NULL
            OR EXISTS (
              SELECT 1 FROM focowiki.source_files source
              WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
                AND source.public_id = entry.source_file_public_id
                AND source.deleted_at IS NULL
            )
          )
      `;
      const existing = new Set(rows.map((row) => row.logical_path));
      return input.logicalPaths.filter((path) => !existing.has(path));
    }
  };
}

function assertInput(input: {
  knowledgeBaseId: string;
  candidatePublicId: string;
  limit: number;
}): void {
  if (
    !input.knowledgeBaseId
    || !input.candidatePublicId
    || !Number.isSafeInteger(input.limit)
    || input.limit < 1
    || input.limit > 1_000
  ) throw new Error("Storage vNext effective catalog input is invalid");
}

function mapEntry(row: EffectiveEntryRow): StorageVnextEffectiveCatalogEntry {
  return {
    logicalPath: row.logical_path,
    kind: row.entry_kind,
    sourceFilePublicId: row.source_file_public_id,
    checksum: row.checksum_sha256,
    objectId: row.object_id,
    byteCount: Number(row.byte_count),
    ordinal: Number(row.ordinal),
    candidateOwned: row.candidate_owned
  };
}

type EffectiveCursor = { scope: string; sortClass: number; logicalPath: string };

function encodeCursor(cursor: EffectiveCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | null, scope: string): EffectiveCursor | null {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !cursor
      || typeof cursor !== "object"
      || cursor.scope !== scope
      || !Number.isSafeInteger(cursor.sortClass)
      || cursor.sortClass < 0
      || typeof cursor.logicalPath !== "string"
      || !cursor.logicalPath
    ) throw new Error("invalid");
    return cursor as EffectiveCursor;
  } catch {
    throw new Error("Storage vNext effective catalog cursor is invalid");
  }
}

export function storageVnextEffectiveCatalogSortClass(logicalPath: string): number {
  const required = [
    "index.md",
    "pages/index.md",
    "schema.md",
    "log.md",
    "_index/index.md",
    "_graph/index.md",
    "_index/catalog.json"
  ];
  const requiredIndex = required.indexOf(logicalPath);
  if (requiredIndex >= 0) return requiredIndex;
  if (logicalPath.startsWith("pages/")) return 7;
  if (logicalPath.startsWith("_index/")) return 8;
  if (logicalPath.startsWith("_graph/")) return 9;
  return 10;
}

export function compareStorageVnextEffectiveCatalogPaths(
  left: string,
  right: string
): number {
  const classDifference = storageVnextEffectiveCatalogSortClass(left)
    - storageVnextEffectiveCatalogSortClass(right);
  return classDifference === 0
    ? Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
    : classDifference;
}
