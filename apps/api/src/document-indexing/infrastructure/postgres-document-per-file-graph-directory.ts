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

const MAXIMUM_DIRECTORY_RECORDS = 10_000;

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
      const rows = await sql<Array<{ page_path: string; title: string }>>`
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
         AND membership.source_revision_public_id = record.source_revision_public_id
        WHERE membership.knowledge_base_id = ${input.knowledgeBaseId}
          AND membership.directory_path = ${input.scopePath}
          AND (${visibleDocumentGraphRelation(sql, included, excluded)})
        ORDER BY page_path
        LIMIT ${MAXIMUM_DIRECTORY_RECORDS + 1}
      `;
      if (rows.length > MAXIMUM_DIRECTORY_RECORDS) {
        throw directoryReaderError("per_file_graph_directory_limit_exceeded");
      }
      const childScopes = [...new Set(rows.flatMap((row) => {
        const directory = posix.dirname(row.page_path);
        if (directory === input.scopePath) return [];
        const relative = directory.slice(input.scopePath.length + 1);
        const child = relative.split("/")[0];
        return child ? [`${input.scopePath}/${child}`] : [];
      }))].sort();
      return {
        relationshipPagePaths: rows.map((row) => row.page_path),
        records: rows.filter((row) => posix.dirname(row.page_path)
          === input.scopePath).map((row) => ({
          path: portableByFileGraphPath(row.page_path),
          title: row.title
        })),
        childDirectories: childScopes.map((scopePath) => ({
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

function directoryReaderError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Document graph directory reader error: ${code}`),
    { code }
  );
}
