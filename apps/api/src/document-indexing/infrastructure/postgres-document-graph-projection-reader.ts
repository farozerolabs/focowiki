import { posix } from "node:path";
import { portableGraphDirectoryPath } from "@focowiki/okf";
import type { DatabaseClient } from "../../db/client.js";
import {
  documentRelatedProjectionRecord,
  documentRelationProjectionRecord
} from "../application/document-machine-record.js";
import {
  visibleDocumentGraphEvidence as visibleEvidence,
  visibleDocumentGraphRecord as visibleRecord,
  visibleDocumentGraphRelation as visibleRelation
} from "./postgres-document-graph-visibility.js";
import { createPostgresDocumentPerFileGraphDirectory } from
  "./postgres-document-per-file-graph-directory.js";

const MAXIMUM_DIRECTORY_RECORDS = 10_000;

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

    async readGraphDirectoryState(input: {
      knowledgeBaseId: string;
      scopePath: string;
      includedSourceRevisionPublicIds?: readonly string[];
      excludedActiveSourceFilePublicIds?: readonly string[];
    }) {
      const included = sortedUnique(input.includedSourceRevisionPublicIds ?? []);
      const excluded = sortedUnique(input.excludedActiveSourceFilePublicIds ?? []);
      const rows = await sql<PerFileGraphRow[]>`
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
          ORDER BY char_length(membership.directory_path) DESC
          LIMIT 1
        ) first_page ON true
        JOIN LATERAL (
          SELECT membership.page_path
          FROM focowiki.document_semantic_directory_memberships membership
          WHERE membership.knowledge_base_id = second_record.knowledge_base_id
            AND membership.source_revision_public_id
              = second_record.source_revision_public_id
          ORDER BY char_length(membership.directory_path) DESC
          LIMIT 1
        ) second_page ON true
        WHERE relation.knowledge_base_id = ${input.knowledgeBaseId}
          AND (${visibleRelation(sql, included, excluded)})
          AND EXISTS (
            SELECT 1
            FROM focowiki.document_semantic_directory_memberships membership
            WHERE membership.knowledge_base_id = relation.knowledge_base_id
              AND membership.source_revision_public_id IN (
                first_record.source_revision_public_id,
                second_record.source_revision_public_id
              )
              AND membership.directory_path = ${input.scopePath}
              AND position('/' in substring(membership.page_path
                    from char_length(${input.scopePath}) + 2)) = 0
          )
        ORDER BY relation.public_id COLLATE "C", evidence.public_id COLLATE "C"
        LIMIT ${MAXIMUM_DIRECTORY_RECORDS + 1}
      `;
      if (rows.length > MAXIMUM_DIRECTORY_RECORDS) {
        throw graphReaderError("graph_directory_record_limit_exceeded");
      }
      const childScopes = await readGraphChildScopes(sql, {
        ...input,
        includedSourceRevisionPublicIds: included,
        excludedActiveSourceFilePublicIds: excluded
      });
      return {
        records: directoryRelationships(rows, input.scopePath),
        childDirectories: childScopes.map((scopePath) => ({
          title: posix.basename(scopePath),
          scopePath,
          path: `${portableGraphDirectoryPath(scopePath)}/index.json`
        })),
        resourcePaths: await readMachineResourcePaths(sql, {
          knowledgeBaseId: input.knowledgeBaseId,
          machineDirectory: portableGraphDirectoryPath(input.scopePath)
        })
      };
    },

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
        SELECT logical_path FROM focowiki.generated_page_heads
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_file_public_id = ${input.sourceFilePublicId}
          AND left(normalized_path, char_length('_graph/by-file/'))
            = '_graph/by-file/'
          AND right(normalized_path, 5) = '.json'
        ORDER BY normalized_path COLLATE "C" LIMIT 2
      `;
      if (resourceRows.length > 1) {
        throw graphReaderError("per_file_graph_resource_ambiguous");
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
      includedSourceRevisionPublicIds?: readonly string[];
      excludedActiveSourceFilePublicIds?: readonly string[];
    }) {
      const included = sortedUnique(input.includedSourceRevisionPublicIds ?? []);
      const excluded = sortedUnique(input.excludedActiveSourceFilePublicIds ?? []);
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

function directoryRelationships(
  rows: readonly PerFileGraphRow[],
  scopePath: string
): Record<string, unknown>[] {
  const grouped = new Map<string, {
    record: Record<string, unknown>;
    directions: Set<"incoming" | "outgoing">;
    evidence: Record<string, unknown>[];
    evidenceKeys: Set<string>;
  }>();
  for (const row of rows) {
    const firstInScope = posix.dirname(row.first_path) === scopePath;
    const secondInScope = posix.dirname(row.second_path) === scopePath;
    if (!firstInScope && !secondInScope) {
      throw graphReaderError("graph_directory_endpoint_missing");
    }
    const localIsFirst = firstInScope;
    const evidenceFromFirst = row.evidence_source_file_public_id
      === row.first_source_file_public_id;
    const evidenceRecord = documentRelationProjectionRecord({
      fromPath: sourceLogicalPath(evidenceFromFirst
        ? row.first_path : row.second_path),
      toPath: sourceLogicalPath(evidenceFromFirst
        ? row.second_path : row.first_path),
      fromTitle: evidenceFromFirst ? row.first_title : row.second_title,
      toTitle: evidenceFromFirst ? row.second_title : row.first_title,
      relationType: row.relation_kind,
      evidenceKind: machineEvidenceKind(row.evidence_kind),
      evidenceValue: row.evidence
    });
    const direction = row.evidence_source_file_public_id
      === (localIsFirst
        ? row.first_source_file_public_id
        : row.second_source_file_public_id)
      ? "outgoing" as const : "incoming" as const;
    const key = `${row.relation_public_id}\0${localIsFirst
      ? row.first_source_file_public_id : row.second_source_file_public_id}`;
    const current = grouped.get(key) ?? {
      record: {
        ...evidenceRecord,
        from: localIsFirst ? row.first_path : row.second_path,
        to: localIsFirst ? row.second_path : row.first_path,
        fromTitle: localIsFirst ? row.first_title : row.second_title,
        toTitle: localIsFirst ? row.second_title : row.first_title,
        direction
      },
      directions: new Set<"incoming" | "outgoing">(),
      evidence: [],
      evidenceKeys: new Set<string>()
    };
    current.directions.add(direction);
    for (const item of Array.isArray(evidenceRecord.evidence)
      ? evidenceRecord.evidence : []) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const evidence = item as Record<string, unknown>;
      const evidenceKey = JSON.stringify(evidence);
      if (current.evidenceKeys.has(evidenceKey)) continue;
      current.evidenceKeys.add(evidenceKey);
      current.evidence.push(evidence);
    }
    grouped.set(key, current);
  }
  return [...grouped.values()].map((item): Record<string, unknown> => ({
    ...item.record,
    direction: item.directions.size === 2 ? "bidirectional"
      : item.directions.has("outgoing") ? "outgoing" : "incoming",
    evidence: item.evidence
  })).sort((left, right) =>
    String(left.from).localeCompare(String(right.from), "en-US")
    || String(left.to).localeCompare(String(right.to), "en-US")
    || String(left.relationType).localeCompare(
      String(right.relationType), "en-US"));
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

async function readGraphChildScopes(sql: DatabaseClient, input: {
  knowledgeBaseId: string;
  scopePath: string;
  includedSourceRevisionPublicIds: readonly string[];
  excludedActiveSourceFilePublicIds: readonly string[];
}): Promise<string[]> {
  const included = input.includedSourceRevisionPublicIds;
  const excluded = input.excludedActiveSourceFilePublicIds;
  const rows = await sql<Array<{ directory_path: string }>>`
    SELECT DISTINCT membership.directory_path COLLATE "C" AS directory_path
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
      SELECT endpoint.directory_path
      FROM focowiki.document_semantic_directory_memberships endpoint
      WHERE endpoint.knowledge_base_id = relation.knowledge_base_id
        AND endpoint.source_revision_public_id IN (
          first_record.source_revision_public_id,
          second_record.source_revision_public_id
        )
    ) membership ON true
    WHERE relation.knowledge_base_id = ${input.knowledgeBaseId}
      AND (${visibleRelation(sql, included, excluded)})
      AND left(membership.directory_path, char_length(${input.scopePath}) + 1)
        = ${`${input.scopePath}/`}
    ORDER BY directory_path
    LIMIT ${MAXIMUM_DIRECTORY_RECORDS + 1}
  `;
  if (rows.length > MAXIMUM_DIRECTORY_RECORDS) {
    throw graphReaderError("graph_directory_child_limit_exceeded");
  }
  return [...new Set(rows.flatMap((row) => {
    const relative = row.directory_path.slice(input.scopePath.length + 1);
    const child = relative.split("/")[0];
    return child ? [`${input.scopePath}/${child}`] : [];
  }))].sort();
}

async function readMachineResourcePaths(sql: DatabaseClient, input: {
  knowledgeBaseId: string;
  machineDirectory: string;
}): Promise<string[]> {
  const rows = await sql<Array<{ logical_path: string }>>`
    SELECT logical_path
    FROM focowiki.generated_page_heads
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND left(normalized_path, char_length(${input.machineDirectory}) + 1)
        = ${`${input.machineDirectory}/`}
      AND right(normalized_path, 5) = '.json'
    ORDER BY normalized_path COLLATE "C"
    LIMIT ${MAXIMUM_DIRECTORY_RECORDS + 1}
  `;
  if (rows.length > MAXIMUM_DIRECTORY_RECORDS) {
    throw graphReaderError("machine_resource_path_limit_exceeded");
  }
  return rows.map((row) => row.logical_path).filter((path) =>
    posix.dirname(path) === input.machineDirectory
    && posix.basename(path) !== "index.json");
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
