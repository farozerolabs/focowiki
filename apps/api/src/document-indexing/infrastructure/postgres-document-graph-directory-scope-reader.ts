import { posix } from "node:path";
import type { DatabaseClient } from "../../db/client.js";
import {
  visibleDocumentGraphEvidence as visibleEvidence,
  visibleDocumentGraphRecord as visibleRecord,
  visibleDocumentGraphRelation as visibleRelation
} from "./postgres-document-graph-visibility.js";

const MAXIMUM_DIRECTORY_RECORDS = 10_000;

export async function readBaseGraphDirectoryRecordKeys(
  sql: DatabaseClient,
  input: Readonly<{
    knowledgeBaseId: string;
    scopePath: string;
    affectedSourceFilePublicIds: readonly string[];
    baseDeterministicChangedAt: string;
  }>
): Promise<string[]> {
  const rows = await sql<Array<{
    first_path: string;
    second_path: string;
    relation_kind: string;
  }>>`
    SELECT DISTINCT first_page.page_path COLLATE "C" AS first_path,
           second_page.page_path COLLATE "C" AS second_path,
           relation.relation_kind::text COLLATE "C" AS relation_kind
    FROM focowiki.canonical_file_relations relation
    JOIN focowiki.document_projection_records first_record
      ON first_record.knowledge_base_id = relation.knowledge_base_id
     AND first_record.source_revision_public_id
           = relation.first_source_revision_public_id
    JOIN focowiki.document_projection_records second_record
      ON second_record.knowledge_base_id = relation.knowledge_base_id
     AND second_record.source_revision_public_id
           = relation.second_source_revision_public_id
    JOIN LATERAL (
      SELECT membership.page_path, membership.directory_path
      FROM focowiki.document_semantic_directory_memberships membership
      WHERE membership.knowledge_base_id = first_record.knowledge_base_id
        AND membership.source_revision_public_id
              = first_record.source_revision_public_id
      ORDER BY char_length(membership.directory_path) DESC
      LIMIT 1
    ) first_page ON true
    JOIN LATERAL (
      SELECT membership.page_path, membership.directory_path
      FROM focowiki.document_semantic_directory_memberships membership
      WHERE membership.knowledge_base_id = second_record.knowledge_base_id
        AND membership.source_revision_public_id
              = second_record.source_revision_public_id
      ORDER BY char_length(membership.directory_path) DESC
      LIMIT 1
    ) second_page ON true
    WHERE relation.knowledge_base_id = ${input.knowledgeBaseId}
      AND (relation.first_source_file_public_id
             = ANY(${input.affectedSourceFilePublicIds}::text[])
        OR relation.second_source_file_public_id
             = ANY(${input.affectedSourceFilePublicIds}::text[]))
      AND relation.created_at <= ${input.baseDeterministicChangedAt}
      AND (relation.retired_at IS NULL
        OR relation.retired_at > ${input.baseDeterministicChangedAt})
      AND (
        (first_page.directory_path = ${input.scopePath}
          AND position('/' in substring(first_page.page_path
            from char_length(${input.scopePath}) + 2)) = 0)
        OR
        (second_page.directory_path = ${input.scopePath}
          AND position('/' in substring(second_page.page_path
            from char_length(${input.scopePath}) + 2)) = 0)
      )
    ORDER BY first_path, second_path, relation_kind
    LIMIT ${MAXIMUM_DIRECTORY_RECORDS + 1}
  `;
  if (rows.length > MAXIMUM_DIRECTORY_RECORDS) {
    throw scopeReadError("graph_directory_delta_record_limit_exceeded");
  }
  return rows.map((row) => [
    row.first_path, row.second_path, row.relation_kind
  ].join("\0"));
}

export async function readGraphChildScopes(sql: DatabaseClient, input: {
  knowledgeBaseId: string;
  scopePath: string;
  includedSourceRevisionPublicIds: readonly string[];
  excludedActiveSourceFilePublicIds: readonly string[];
  affectedSourceFilePublicIds: readonly string[] | null;
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
      AND (${input.affectedSourceFilePublicIds === null}
        OR relation.first_source_file_public_id
             = ANY(${input.affectedSourceFilePublicIds ?? []}::text[])
        OR relation.second_source_file_public_id
             = ANY(${input.affectedSourceFilePublicIds ?? []}::text[]))
      AND left(membership.directory_path, char_length(${input.scopePath}) + 1)
        = ${`${input.scopePath}/`}
    ORDER BY directory_path
    LIMIT ${MAXIMUM_DIRECTORY_RECORDS + 1}
  `;
  if (rows.length > MAXIMUM_DIRECTORY_RECORDS) {
    throw scopeReadError("graph_directory_child_limit_exceeded");
  }
  return [...new Set(rows.flatMap((row) => {
    const relative = row.directory_path.slice(input.scopePath.length + 1);
    const child = relative.split("/")[0];
    return child ? [`${input.scopePath}/${child}`] : [];
  }))].sort();
}

export async function readAffectedGraphChildScopes(
  sql: DatabaseClient,
  input: {
    knowledgeBaseId: string;
    scopePath: string;
    affectedLogicalPaths: readonly string[];
    includedSourceRevisionPublicIds: readonly string[];
    excludedActiveSourceFilePublicIds: readonly string[];
  }
): Promise<string[]> {
  const children = [...new Set(input.affectedLogicalPaths.flatMap((path) => {
    const normalized = path.startsWith("pages/") ? path : `pages/${path}`;
    if (!normalized.startsWith(`${input.scopePath}/`)) return [];
    const relative = normalized.slice(input.scopePath.length + 1);
    const child = relative.split("/")[0];
    return child && relative.includes("/")
      ? [`${input.scopePath}/${child}`] : [];
  }))].sort();
  if (children.length === 0) return [];
  const included = input.includedSourceRevisionPublicIds;
  const excluded = input.excludedActiveSourceFilePublicIds;
  const rows = await sql<Array<{ scope_path: string }>>`
    SELECT desired.scope_path
    FROM unnest(${children}::text[]) desired(scope_path)
    WHERE EXISTS (
      SELECT 1
      FROM focowiki.document_semantic_directory_memberships membership
      JOIN focowiki.document_projection_records source_record
        ON source_record.knowledge_base_id = membership.knowledge_base_id
       AND source_record.source_revision_public_id
             = membership.source_revision_public_id
       AND (${visibleRecord(sql, "source_record", included, excluded)})
      JOIN focowiki.canonical_file_relations relation
        ON relation.knowledge_base_id = source_record.knowledge_base_id
       AND source_record.source_revision_public_id IN (
         relation.first_source_revision_public_id,
         relation.second_source_revision_public_id
       )
       AND (${visibleRelation(sql, included, excluded)})
      JOIN focowiki.relation_directed_evidence evidence
        ON evidence.knowledge_base_id = relation.knowledge_base_id
       AND evidence.pair_public_id = relation.pair_public_id
       AND (${visibleEvidence(sql, included, excluded)})
      WHERE membership.knowledge_base_id = ${input.knowledgeBaseId}
        AND (membership.directory_path = desired.scope_path
          OR left(
            membership.directory_path,
            char_length(desired.scope_path) + 1
          ) = desired.scope_path || '/')
      LIMIT 1
    )
    ORDER BY desired.scope_path COLLATE "C"
  `;
  return rows.map((row) => row.scope_path);
}

export async function readMachineResourcePaths(sql: DatabaseClient, input: {
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
    throw scopeReadError("machine_resource_path_limit_exceeded");
  }
  return rows.map((row) => row.logical_path).filter((path) =>
    posix.dirname(path) === input.machineDirectory
    && posix.basename(path) !== "index.json");
}

function scopeReadError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Graph directory scope read error: ${code}`), {
    code
  });
}
