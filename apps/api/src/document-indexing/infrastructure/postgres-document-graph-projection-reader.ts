import type { DatabaseClient } from "../../db/client.js";
import { documentRelatedProjectionRecord } from
  "../application/document-machine-record.js";
import {
  visibleDocumentGraphEvidence as visibleEvidence,
  visibleDocumentGraphRecord as visibleRecord,
  visibleDocumentGraphRelation as visibleRelation
} from "./postgres-document-graph-visibility.js";
import { createPostgresDocumentPerFileGraphDirectory } from
  "./postgres-document-per-file-graph-directory.js";
import { createPostgresDocumentGraphDirectoryScanner } from
  "./postgres-document-graph-directory-scanner.js";

const MAXIMUM_DIRECTORY_RECORDS = 10_000;
const MAXIMUM_PER_FILE_GRAPH_RESOURCE_PATHS = 256;

export type PerFileGraphRow = {
  relation_public_id: string;
  evidence_public_id: string;
  first_path: string;
  first_title: string;
  second_path: string;
  second_title: string;
  first_source_file_public_id: string;
  second_source_file_public_id: string;
  evidence_source_file_public_id: string;
  relation_kind: "references" | "related";
  evidence_kind: "explicit_reference" | "title_alias" | "first_layer" | "graphrag";
  evidence: Record<string, unknown>;
};

export function createPostgresDocumentGraphProjectionReader(sql: DatabaseClient) {
  return {
    ...createPostgresDocumentPerFileGraphDirectory(sql),
    ...createPostgresDocumentGraphDirectoryScanner(sql),

    async readPerFileGraphState(input: {
      knowledgeBaseId: string;
      sourceFilePublicId: string;
      includedSourceRevisionPublicIds?: readonly string[];
      excludedActiveSourceFilePublicIds?: readonly string[];
    }) {
      const included = sortedUnique(input.includedSourceRevisionPublicIds ?? []);
      const excluded = sortedUnique(input.excludedActiveSourceFilePublicIds ?? []);
      const sourceRows = await sql<Array<{ page_path: string; title: string }>>`
        SELECT page.page_path, record.title
        FROM focowiki.document_projection_records record
        JOIN LATERAL (
          SELECT membership.page_path
          FROM focowiki.document_semantic_directory_memberships membership
          WHERE membership.knowledge_base_id = record.knowledge_base_id
            AND membership.source_revision_public_id
              = record.source_revision_public_id
          ORDER BY char_length(membership.directory_path) DESC
          LIMIT 1
        ) page ON true
        WHERE record.knowledge_base_id = ${input.knowledgeBaseId}
          AND record.source_file_public_id = ${input.sourceFilePublicId}
          AND (record.source_revision_public_id = ANY(${included}::text[])
            OR (record.active
              AND record.source_file_public_id <> ALL(${excluded}::text[])))
        ORDER BY (record.source_revision_public_id = ANY(${included}::text[])) DESC,
          record.source_revision_public_id COLLATE "C"
        LIMIT 2
      `;
      if (sourceRows.length > 1) {
        throw graphReaderError("per_file_graph_source_ambiguous");
      }
      const rows = await sql<Array<PerFileGraphRow>>`
        SELECT relation.public_id AS relation_public_id,
               evidence.public_id AS evidence_public_id,
               first_page.page_path AS first_path,
               first_record.title AS first_title,
               second_page.page_path AS second_path,
               second_record.title AS second_title,
               relation.first_source_file_public_id,
               relation.second_source_file_public_id,
               evidence.source_file_public_id AS evidence_source_file_public_id,
               relation.relation_kind, evidence.evidence_kind, evidence.evidence
        FROM focowiki.canonical_file_relations relation
        JOIN focowiki.relation_directed_evidence evidence
          ON evidence.knowledge_base_id = relation.knowledge_base_id
         AND evidence.pair_public_id = relation.pair_public_id
         AND (${visibleEvidence(sql, included, excluded)})
        JOIN focowiki.document_projection_records first_record
          ON first_record.knowledge_base_id = relation.knowledge_base_id
         AND first_record.source_revision_public_id
           = relation.first_source_revision_public_id
         AND (${visibleRecord(sql, "first_record", included, excluded)})
        JOIN focowiki.document_projection_records second_record
          ON second_record.knowledge_base_id = relation.knowledge_base_id
         AND second_record.source_revision_public_id
           = relation.second_source_revision_public_id
         AND (${visibleRecord(sql, "second_record", included, excluded)})
        JOIN LATERAL (
          SELECT membership.page_path
          FROM focowiki.document_semantic_directory_memberships membership
          WHERE membership.knowledge_base_id = first_record.knowledge_base_id
            AND membership.source_revision_public_id
              = first_record.source_revision_public_id
          ORDER BY char_length(membership.directory_path) DESC LIMIT 1
        ) first_page ON true
        JOIN LATERAL (
          SELECT membership.page_path
          FROM focowiki.document_semantic_directory_memberships membership
          WHERE membership.knowledge_base_id = second_record.knowledge_base_id
            AND membership.source_revision_public_id
              = second_record.source_revision_public_id
          ORDER BY char_length(membership.directory_path) DESC LIMIT 1
        ) second_page ON true
        WHERE relation.knowledge_base_id = ${input.knowledgeBaseId}
          AND (relation.first_source_file_public_id = ${input.sourceFilePublicId}
            OR relation.second_source_file_public_id = ${input.sourceFilePublicId})
          AND (${visibleRelation(sql, included, excluded)})
        ORDER BY relation.public_id COLLATE "C", evidence.public_id COLLATE "C"
        LIMIT ${MAXIMUM_DIRECTORY_RECORDS + 1}
      `;
      if (rows.length > MAXIMUM_DIRECTORY_RECORDS) {
        throw graphReaderError("per_file_graph_record_limit_exceeded");
      }
      const resourceRows = await sql<Array<{ logical_path: string }>>`
        SELECT head.logical_path
        FROM focowiki.generated_page_heads head
        JOIN focowiki.projection_artifact_owners owner
          ON owner.knowledge_base_id = head.knowledge_base_id
         AND owner.normalized_path = head.normalized_path
        WHERE head.knowledge_base_id = ${input.knowledgeBaseId}
          AND owner.owner_scope_identity
            = ${`_graph:${input.sourceFilePublicId}`}
          AND left(head.normalized_path, char_length('_graph/by-file/'))
            = '_graph/by-file/'
          AND right(head.normalized_path, 5) = '.json'
        ORDER BY head.normalized_path COLLATE "C"
        LIMIT ${MAXIMUM_PER_FILE_GRAPH_RESOURCE_PATHS + 1}
      `;
      if (resourceRows.length > MAXIMUM_PER_FILE_GRAPH_RESOURCE_PATHS) {
        throw graphReaderError("per_file_graph_resource_path_limit_exceeded");
      }
      return {
        source: sourceRows[0]
          ? { path: sourceRows[0].page_path, title: sourceRows[0].title }
          : null,
        relationships: perFileRelationships(rows, input.sourceFilePublicId),
        resourcePaths: resourceRows.map((row) => row.logical_path)
      };
    },

    async readGraphCatalogState(input: {
      knowledgeBaseId: string;
      publicationGenerationPublicId?: string;
      includedSourceRevisionPublicIds?: readonly string[];
      excludedActiveSourceFilePublicIds?: readonly string[];
    }) {
      const included = sortedUnique(input.includedSourceRevisionPublicIds ?? []);
      const excluded = sortedUnique(input.excludedActiveSourceFilePublicIds ?? []);
      if (input.publicationGenerationPublicId) {
        const statistics = await sql<Array<{
          relationship_count: number | string;
        }>>`
          SELECT relationship_count
          FROM focowiki.projection_generation_statistics
          WHERE publication_generation_public_id
                  = ${input.publicationGenerationPublicId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
        `;
        const relationshipCount = Number(
          statistics[0]?.relationship_count ?? -1
        );
        if (!Number.isSafeInteger(relationshipCount)
          || relationshipCount < 0) {
          throw graphReaderError("graph_catalog_statistics_missing");
        }
        return { relationshipCount };
      }
      const rows = await sql<Array<{ relationship_count: number | string }>>`
        SELECT count(DISTINCT relation.public_id) AS relationship_count
        FROM focowiki.canonical_file_relations relation
        JOIN focowiki.relation_directed_evidence evidence
          ON evidence.knowledge_base_id = relation.knowledge_base_id
         AND evidence.pair_public_id = relation.pair_public_id
         AND (${visibleEvidence(sql, included, excluded)})
        JOIN focowiki.document_projection_records first_record
          ON first_record.knowledge_base_id = relation.knowledge_base_id
         AND first_record.source_revision_public_id
           = relation.first_source_revision_public_id
         AND (${visibleRecord(sql, "first_record", included, excluded)})
        JOIN focowiki.document_projection_records second_record
          ON second_record.knowledge_base_id = relation.knowledge_base_id
         AND second_record.source_revision_public_id
           = relation.second_source_revision_public_id
         AND (${visibleRecord(sql, "second_record", included, excluded)})
        WHERE relation.knowledge_base_id = ${input.knowledgeBaseId}
          AND (${visibleRelation(sql, included, excluded)})
      `;
      const relationshipCount = Number(rows[0]?.relationship_count ?? 0);
      if (!Number.isSafeInteger(relationshipCount) || relationshipCount < 0) {
        throw graphReaderError("graph_catalog_count_invalid");
      }
      return { relationshipCount };
    }
  };
}

export function perFileRelationships(
  rows: readonly PerFileGraphRow[],
  sourceFilePublicId: string
): Record<string, unknown>[] {
  const grouped = new Map<string, {
    row: PerFileGraphRow;
    directions: Set<"incoming" | "outgoing">;
  }>();
  for (const row of rows) {
    const sourceIsFirst = row.first_source_file_public_id === sourceFilePublicId;
    const targetSourceFilePublicId = sourceIsFirst
      ? row.second_source_file_public_id : row.first_source_file_public_id;
    const current = grouped.get(targetSourceFilePublicId) ?? {
      row,
      directions: new Set<"incoming" | "outgoing">()
    };
    current.directions.add(row.evidence_source_file_public_id === sourceFilePublicId
      ? "outgoing" : "incoming");
    grouped.set(targetSourceFilePublicId, current);
  }
  return [...grouped.values()].map(({ row, directions }) => {
    const evidenceFromFirst = row.evidence_source_file_public_id
      === row.first_source_file_public_id;
    const relation = {
      fromPath: sourceLogicalPath(evidenceFromFirst
        ? row.first_path : row.second_path),
      toPath: sourceLogicalPath(evidenceFromFirst
        ? row.second_path : row.first_path),
      fromTitle: evidenceFromFirst ? row.first_title : row.second_title,
      toTitle: evidenceFromFirst ? row.second_title : row.first_title,
      relationType: row.relation_kind,
      evidenceKind: machineEvidenceKind(row.evidence_kind),
      evidenceValue: row.evidence
    } as const;
    const sourcePath = row.first_source_file_public_id === sourceFilePublicId
      ? row.first_path : row.second_path;
    return {
      ...documentRelatedProjectionRecord(relation, sourceLogicalPath(sourcePath)),
      direction: directions.size === 2 ? "bidirectional"
        : directions.has("outgoing") ? "outgoing" : "incoming"
    };
  }).sort((left, right) => String(left.targetPath)
    .localeCompare(String(right.targetPath), "en-US"));
}

function machineEvidenceKind(value: PerFileGraphRow["evidence_kind"]):
  "markdown_link" | "stable_alias" | "semantic" {
  if (value === "explicit_reference") return "markdown_link";
  if (value === "title_alias") return "stable_alias";
  return "semantic";
}

function sourceLogicalPath(pagePath: string): string {
  return pagePath.startsWith("pages/") ? pagePath.slice("pages/".length) : pagePath;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right, "en-US"));
}

function graphReaderError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Document graph projection reader error: ${code}`),
    { code }
  );
}
