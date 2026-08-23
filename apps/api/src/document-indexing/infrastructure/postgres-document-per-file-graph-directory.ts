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
      const [rows, childRows] = await Promise.all([
        sql<Array<{ page_path: string; title: string }>>`
          SELECT DISTINCT membership.page_path COLLATE "C" AS page_path,
                 record.title
          FROM focowiki.canonical_file_relations relation
          JOIN focowiki.relation_directed_evidence evidence
            ON evidence.knowledge_base_id = relation.knowledge_base_id
           AND evidence.pair_public_id = relation.pair_public_id
           AND (${visibleDocumentGraphEvidence(sql, included, excluded)})
          JOIN focowiki.document_projection_records record
            ON record.knowledge_base_id = relation.knowledge_base_id
           AND record.source_revision_public_id IN (
             relation.first_source_revision_public_id,
             relation.second_source_revision_public_id
           )
           AND (record.source_revision_public_id = ANY(${included}::text[])
             OR (record.active
               AND record.source_file_public_id <> ALL(${excluded}::text[])))
          JOIN focowiki.document_semantic_directory_memberships membership
            ON membership.knowledge_base_id = record.knowledge_base_id
           AND membership.source_revision_public_id
             = record.source_revision_public_id
          WHERE membership.knowledge_base_id = ${input.knowledgeBaseId}
            AND membership.directory_path = ${input.scopePath}
            AND position('/' in substring(membership.page_path
                  from char_length(${input.scopePath}) + 2)) = 0
            AND (${visibleDocumentGraphRelation(sql, included, excluded)})
          ORDER BY page_path
        `,
        sql<Array<{ scope_path: string }>>`
          SELECT DISTINCT (
            ${input.scopePath} || '/' || split_part(
              substring(membership.page_path
                from char_length(${input.scopePath}) + 2), '/', 1
            )
          ) COLLATE "C" AS scope_path
          FROM focowiki.canonical_file_relations relation
          JOIN focowiki.relation_directed_evidence evidence
            ON evidence.knowledge_base_id = relation.knowledge_base_id
           AND evidence.pair_public_id = relation.pair_public_id
           AND (${visibleDocumentGraphEvidence(sql, included, excluded)})
          JOIN focowiki.document_projection_records record
            ON record.knowledge_base_id = relation.knowledge_base_id
           AND record.source_revision_public_id IN (
             relation.first_source_revision_public_id,
             relation.second_source_revision_public_id
           )
           AND (record.source_revision_public_id = ANY(${included}::text[])
             OR (record.active
               AND record.source_file_public_id <> ALL(${excluded}::text[])))
          JOIN focowiki.document_semantic_directory_memberships membership
            ON membership.knowledge_base_id = record.knowledge_base_id
           AND membership.source_revision_public_id
             = record.source_revision_public_id
          WHERE membership.knowledge_base_id = ${input.knowledgeBaseId}
            AND membership.directory_path = ${input.scopePath}
            AND position('/' in substring(membership.page_path
                  from char_length(${input.scopePath}) + 2)) > 0
            AND (${visibleDocumentGraphRelation(sql, included, excluded)})
          ORDER BY scope_path
        `
      ]);
      return {
        relationshipPagePaths: rows.map((row) => row.page_path),
        records: rows.map((row) => ({
          path: portableByFileGraphPath(row.page_path),
          title: row.title
        })),
        childDirectories: childRows.map(({ scope_path: scopePath }) => ({
          title: posix.basename(scopePath),
          scopePath,
          path: `${portableByFileGraphDirectoryPath(scopePath)}/index.md`
        }))
      };
    }
  };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right, "en-US"));
}
