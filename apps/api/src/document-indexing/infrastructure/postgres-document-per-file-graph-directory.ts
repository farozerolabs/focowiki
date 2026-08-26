import { posix } from "node:path";
import {
  portableByFileGraphDirectoryPath,
  portableByFileGraphPath
} from "@focowiki/okf";
import type { DatabaseClient } from "../../db/client.js";
import {
  visibleDocumentGraphEvidence,
  visibleDocumentGraphRelation
} from "./postgres-document-graph-visibility.js";

export function createPostgresDocumentPerFileGraphDirectory(
  sql: DatabaseClient
) {
  return {
    async readPerFileGraphDirectoryState(input: {
      knowledgeBaseId: string;
      scopePath: string;
      includedSourceRevisionPublicIds?: readonly string[];
      excludedActiveSourceFilePublicIds?: readonly string[];
    }) {
      const included = sortedUnique(input.includedSourceRevisionPublicIds ?? []);
      const excluded = sortedUnique(input.excludedActiveSourceFilePublicIds ?? []);
      const rows = included.length === 0 && excluded.length === 0
        ? await sql<Array<{ page_path: string; title: string }>>`
            SELECT membership.page_path COLLATE "C" AS page_path, record.title
            FROM focowiki.document_semantic_directory_memberships membership
            JOIN focowiki.document_projection_records record
              ON record.knowledge_base_id = membership.knowledge_base_id
             AND record.source_revision_public_id
                   = membership.source_revision_public_id
            JOIN focowiki.document_graph_degrees degree
              ON degree.knowledge_base_id = record.knowledge_base_id
             AND degree.source_revision_public_id
                   = record.source_revision_public_id
             AND degree.incoming_count + degree.outgoing_count > 0
            WHERE membership.knowledge_base_id = ${input.knowledgeBaseId}
              AND membership.directory_path = ${input.scopePath}
              AND record.active
            ORDER BY page_path
          `
        : await sql<Array<{ page_path: string; title: string }>>`
            SELECT membership.page_path COLLATE "C" AS page_path, record.title
            FROM focowiki.document_semantic_directory_memberships membership
            JOIN focowiki.document_projection_records record
              ON record.knowledge_base_id = membership.knowledge_base_id
             AND record.source_revision_public_id
                   = membership.source_revision_public_id
            WHERE membership.knowledge_base_id = ${input.knowledgeBaseId}
              AND membership.directory_path = ${input.scopePath}
              AND (record.source_revision_public_id = ANY(${included}::text[])
                OR (record.active
                  AND record.source_file_public_id <> ALL(${excluded}::text[])))
              AND EXISTS (
                SELECT 1
                FROM focowiki.canonical_file_relations relation
                WHERE relation.knowledge_base_id = record.knowledge_base_id
                  AND (relation.first_source_revision_public_id
                         = record.source_revision_public_id
                    OR relation.second_source_revision_public_id
                         = record.source_revision_public_id)
                  AND (${visibleDocumentGraphRelation(sql, included, excluded)})
                  AND EXISTS (
                    SELECT 1
                    FROM focowiki.relation_directed_evidence evidence
                    WHERE evidence.knowledge_base_id
                            = relation.knowledge_base_id
                      AND evidence.pair_public_id = relation.pair_public_id
                      AND (${visibleDocumentGraphEvidence(sql, included, excluded)})
                  )
              )
            ORDER BY page_path
          `;
      const directRows = rows.filter((row) =>
        directChildName(input.scopePath, row.page_path) === null);
      const childScopePaths = [...new Set(rows.flatMap((row) => {
        const child = directChildName(input.scopePath, row.page_path);
        return child ? [`${input.scopePath}/${child}`] : [];
      }))].sort((left, right) => left.localeCompare(right, "en-US"));
      return {
        relationshipPagePaths: directRows.map((row) => row.page_path),
        records: directRows.map((row) => ({
          path: portableByFileGraphPath(row.page_path),
          title: row.title
        })),
        childDirectories: childScopePaths.map((scopePath) => ({
          title: posix.basename(scopePath),
          scopePath,
          path: `${portableByFileGraphDirectoryPath(scopePath)}/index.md`
        }))
      };
    },
    async readPerFileGraphDirectoryDeltaState(input: {
      knowledgeBaseId: string;
      scopePath: string;
      includedSourceRevisionPublicIds: readonly string[];
      excludedActiveSourceFilePublicIds: readonly string[];
      affectedSourceFilePublicIds: readonly string[];
      candidateChildScopePaths: readonly string[];
    }) {
      const included = sortedUnique(input.includedSourceRevisionPublicIds);
      const excluded = sortedUnique(input.excludedActiveSourceFilePublicIds);
      const affected = sortedUnique(input.affectedSourceFilePublicIds);
      const candidateChildren = sortedUnique(input.candidateChildScopePaths);
      if (affected.length === 0 || affected.length > 10_000
        || candidateChildren.length > 512) {
        throw new Error("per_file_graph_delta_input_invalid");
      }
      const rows = await sql<Array<{ page_path: string; title: string }>>`
        SELECT membership.page_path COLLATE "C" AS page_path, record.title
        FROM focowiki.document_semantic_directory_memberships membership
        JOIN focowiki.document_projection_records record
          ON record.knowledge_base_id = membership.knowledge_base_id
         AND record.source_revision_public_id
               = membership.source_revision_public_id
        WHERE membership.knowledge_base_id = ${input.knowledgeBaseId}
          AND membership.directory_path = ${input.scopePath}
          AND record.source_file_public_id = ANY(${affected}::text[])
          AND (record.source_revision_public_id = ANY(${included}::text[])
            OR (record.active
              AND record.source_file_public_id <> ALL(${excluded}::text[])))
          AND EXISTS (
            SELECT 1 FROM focowiki.canonical_file_relations relation
            WHERE relation.knowledge_base_id = record.knowledge_base_id
              AND (relation.first_source_revision_public_id
                     = record.source_revision_public_id
                OR relation.second_source_revision_public_id
                     = record.source_revision_public_id)
              AND (${visibleDocumentGraphRelation(sql, included, excluded)})
              AND EXISTS (
                SELECT 1 FROM focowiki.relation_directed_evidence evidence
                WHERE evidence.knowledge_base_id = relation.knowledge_base_id
                  AND evidence.pair_public_id = relation.pair_public_id
                  AND (${visibleDocumentGraphEvidence(sql, included, excluded)})
              )
          )
        ORDER BY page_path
        LIMIT ${affected.length + 1}
      `;
      if (rows.length > affected.length) {
        throw new Error("per_file_graph_delta_record_limit_exceeded");
      }
      const directRows = rows.filter((row) =>
        directChildName(input.scopePath, row.page_path) === null);
      const childRows = candidateChildren.length === 0 ? []
        : await sql<Array<{ scope_path: string }>>`
            SELECT candidate.scope_path COLLATE "C" AS scope_path
            FROM unnest(${candidateChildren}::text[]) candidate(scope_path)
            WHERE EXISTS (
              SELECT 1
              FROM focowiki.document_semantic_directory_memberships membership
              JOIN focowiki.document_projection_records record
                ON record.knowledge_base_id = membership.knowledge_base_id
               AND record.source_revision_public_id
                     = membership.source_revision_public_id
              WHERE membership.knowledge_base_id = ${input.knowledgeBaseId}
                AND membership.directory_path = candidate.scope_path
                AND (record.source_revision_public_id = ANY(${included}::text[])
                  OR (record.active
                    AND record.source_file_public_id <> ALL(${excluded}::text[])))
                AND EXISTS (
                  SELECT 1 FROM focowiki.canonical_file_relations relation
                  WHERE relation.knowledge_base_id = record.knowledge_base_id
                    AND (relation.first_source_revision_public_id
                           = record.source_revision_public_id
                      OR relation.second_source_revision_public_id
                           = record.source_revision_public_id)
                    AND (${visibleDocumentGraphRelation(
                      sql, included, excluded
                    )})
                    AND EXISTS (
                      SELECT 1 FROM focowiki.relation_directed_evidence evidence
                      WHERE evidence.knowledge_base_id
                              = relation.knowledge_base_id
                        AND evidence.pair_public_id = relation.pair_public_id
                        AND (${visibleDocumentGraphEvidence(
                          sql, included, excluded
                        )})
                    )
                )
              LIMIT 1
            )
            ORDER BY scope_path
          `;
      return {
        records: directRows.map((row) => ({
          path: portableByFileGraphPath(row.page_path), title: row.title
        })),
        childDirectories: childRows.map(({ scope_path: scopePath }) => ({
          title: posix.basename(scopePath), scopePath,
          path: `${portableByFileGraphDirectoryPath(scopePath)}/index.md`
        }))
      };
    }
  };
}

function directChildName(scopePath: string, pagePath: string): string | null {
  const prefix = `${scopePath}/`;
  if (!pagePath.startsWith(prefix)) return null;
  const remainder = pagePath.slice(prefix.length);
  const separator = remainder.indexOf("/");
  return separator < 0 ? null : remainder.slice(0, separator);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right, "en-US"));
}
