import { posix } from "node:path";
import type { DatabaseClient } from "../../db/client.js";
import { documentDirectoryEntryId } from
  "../domain/document-directory-entry-identity.js";
import { mapDocumentProjectionRecord } from
  "./document-projection-record.js";

export function createPostgresDocumentSemanticDirectoryReader(
  sql: DatabaseClient
) {
  return {
    async readSemanticDirectoryState(input: {
      knowledgeBaseId: string;
      scopePath: string;
      includedSourceRevisionPublicIds?: readonly string[];
      excludedActiveSourceFilePublicIds?: readonly string[];
    }) {
      const included = sortedUnique(
        input.includedSourceRevisionPublicIds ?? []);
      const excluded = sortedUnique(
        input.excludedActiveSourceFilePublicIds ?? []);
      const rows = await sql<DocumentRecordRow[]>`
        SELECT membership.page_path, record.title, record.summary,
               record.metadata, record.headings, record.entities,
               record.content_type, record.checksum_sha256, record.byte_count,
               0 AS relationship_count
        FROM focowiki.document_semantic_directory_memberships membership
        JOIN focowiki.document_projection_records record
          ON record.knowledge_base_id = membership.knowledge_base_id
         AND record.source_revision_public_id
               = membership.source_revision_public_id
        WHERE membership.knowledge_base_id = ${input.knowledgeBaseId}
          AND membership.directory_path = ${input.scopePath}
          AND position('/' in substring(membership.page_path
                from char_length(${input.scopePath}) + 2)) = 0
          AND (record.source_revision_public_id = ANY(${included}::text[])
            OR (record.active
              AND record.source_file_public_id <> ALL(${excluded}::text[])))
        ORDER BY record.normalized_path COLLATE "C"
      `;
      const descendantRows = await sql<Array<{ directory_path: string }>>`
        SELECT DISTINCT (
          ${input.scopePath} || '/' || split_part(
            substring(membership.directory_path
              from char_length(${input.scopePath}) + 2), '/', 1
          )
        ) COLLATE "C" AS directory_path
        FROM focowiki.document_semantic_directory_memberships membership
        JOIN focowiki.document_projection_records record
          ON record.knowledge_base_id = membership.knowledge_base_id
         AND record.source_revision_public_id
               = membership.source_revision_public_id
        WHERE membership.knowledge_base_id = ${input.knowledgeBaseId}
          AND left(membership.directory_path, char_length(${input.scopePath}) + 1)
            = ${`${input.scopePath}/`}
          AND (record.source_revision_public_id = ANY(${included}::text[])
            OR (record.active
              AND record.source_file_public_id <> ALL(${excluded}::text[])))
        ORDER BY directory_path
      `;
      return {
        records: rows.map(mapDocumentProjectionRecord),
        childDirectories: descendantRows.map(({ directory_path: scopePath }) => ({
          title: posix.basename(scopePath),
          scopePath,
          path: `${scopePath}/index.md`
        }))
      };
    },

    async readSemanticDirectoryDeltaState(input: {
      knowledgeBaseId: string;
      scopePath: string;
      affectedSourceFilePublicIds: readonly string[];
      includedSourceRevisionPublicIds: readonly string[];
    }) {
      const affected = sortedUnique(input.affectedSourceFilePublicIds);
      const included = sortedUnique(input.includedSourceRevisionPublicIds);
      if (affected.length === 0) {
        return {
          records: [] as Record<string, unknown>[],
          childDirectories: [] as DirectoryEntry[],
          navigationCandidateEntryIds: [] as string[]
        };
      }
      if (affected.length > 256) {
        throw semanticReaderError(
          "semantic_directory_navigation_candidate_limit_exceeded"
        );
      }
      const rows = await sql<Array<Omit<DocumentRecordRow,
        "relationship_count"> & {
          visible: boolean;
        }>>`
        WITH affected_records AS (
          SELECT record.*,
                 (
                   SELECT min(membership.page_path COLLATE "C")
                   FROM focowiki.document_semantic_directory_memberships
                        membership
                   WHERE membership.knowledge_base_id
                           = record.knowledge_base_id
                     AND membership.source_revision_public_id
                           = record.source_revision_public_id
                 ) AS page_path,
                 record.source_revision_public_id = ANY(${included}::text[])
                   AS visible,
                 row_number() OVER (
                   PARTITION BY record.source_file_public_id
                   ORDER BY
                     (record.source_revision_public_id
                        = ANY(${included}::text[])) DESC,
                     record.active DESC,
                     record.created_at DESC,
                     record.source_revision_public_id COLLATE "C" DESC
                 ) AS source_rank
          FROM focowiki.document_projection_records record
          WHERE record.knowledge_base_id = ${input.knowledgeBaseId}
            AND record.source_file_public_id = ANY(${affected}::text[])
        )
        SELECT record.page_path, record.title, record.summary,
               record.metadata, record.headings, record.entities,
               record.content_type, record.checksum_sha256, record.byte_count,
               record.visible
        FROM affected_records record
        WHERE record.visible OR record.active OR record.source_rank = 1
        ORDER BY record.normalized_path COLLATE "C",
                 record.source_revision_public_id COLLATE "C"
        LIMIT ${affected.length + included.length + 1}
      `;
      if (rows.length > affected.length + included.length) {
        throw semanticReaderError(
          "semantic_directory_navigation_revision_limit_exceeded"
        );
      }
      const candidateTargets = rows.flatMap((row) =>
        candidateTarget(input.scopePath, row.page_path));
      const navigationCandidateEntryIds = [...new Set(candidateTargets.map(
        (target) => documentDirectoryEntryId(target.kind, target.path)
      ))].sort();
      const candidateChildScopePaths = [...new Set(candidateTargets.flatMap(
        (target) => target.kind === "directory"
          ? [posix.dirname(target.path)] : []
      ))].sort();
      const visibleChildRows = candidateChildScopePaths.length === 0 ? []
        : await sql<Array<{ directory_path: string }>>`
            SELECT DISTINCT membership.directory_path COLLATE "C"
                   AS directory_path
            FROM focowiki.document_semantic_directory_memberships membership
            JOIN focowiki.document_projection_records record
              ON record.knowledge_base_id = membership.knowledge_base_id
             AND record.source_revision_public_id
                   = membership.source_revision_public_id
            WHERE membership.knowledge_base_id = ${input.knowledgeBaseId}
              AND membership.directory_path
                    = ANY(${candidateChildScopePaths}::text[])
              AND (record.source_revision_public_id = ANY(${included}::text[])
                OR (record.active
                  AND record.source_file_public_id <> ALL(${affected}::text[])))
            ORDER BY directory_path
          `;
      return {
        records: rows.flatMap((row) => {
          return row.visible && posix.dirname(row.page_path) === input.scopePath
            ? [mapDocumentProjectionRecord({
                ...row, relationship_count: 0
              })] : [];
        }),
        childDirectories: visibleChildRows.map(({ directory_path: scopePath }) => ({
          title: posix.basename(scopePath), scopePath,
          path: `${scopePath}/index.md`
        })),
        navigationCandidateEntryIds
      };
    }
  };
}

type DocumentRecordRow = {
  page_path: string;
  title: string;
  summary: string;
  metadata: Record<string, unknown>;
  headings: string[];
  entities: string[];
  content_type: string;
  checksum_sha256: string;
  byte_count: number | string;
  relationship_count: number | string;
};

type DirectoryEntry = { title: string; scopePath: string; path: string };

function candidateTarget(
  scopePath: string,
  pagePath: string
): Array<{ kind: "file" | "directory"; path: string }> {
  const relative = pagePath.startsWith(`${scopePath}/`)
    ? pagePath.slice(scopePath.length + 1) : null;
  if (!relative) return [];
  const separator = relative.indexOf("/");
  return separator < 0
    ? [{ kind: "file", path: pagePath }]
    : [{
        kind: "directory",
        path: `${scopePath}/${relative.slice(0, separator)}/index.md`
      }];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right, "en-US"));
}

function semanticReaderError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Document semantic directory reader error: ${code}`),
    { code }
  );
}
