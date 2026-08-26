import { posix } from "node:path";
import type { DatabaseClient } from "../../db/client.js";
import type { DocumentPublicationItemDelta } from
  "../application/document-publication-job-plan.js";

const CONTRIBUTOR_CAP = 256;

export async function readPublicationJobFactDeltas(
  sql: DatabaseClient,
  jobPublicId: string
): Promise<readonly DocumentPublicationItemDelta[]> {
  const rows = await sql<Array<{
    mutation_public_id: string;
    document_job_public_id: string | null;
    source_file_public_id: string;
    source_revision_public_id: string;
    readiness_sequence: number | string;
    operation: DocumentPublicationItemDelta["operation"] | "rename";
    prior_logical_path: string | null;
    next_logical_path: string | null;
    prior_source_revision_public_id: string | null;
    knowledge_base_id: string;
  }>>`
    SELECT item.mutation_public_id, item.document_job_public_id,
           item.source_file_public_id, item.source_revision_public_id,
           item.readiness_sequence, item.operation,
           item.prior_logical_path, item.next_logical_path,
           active.active_source_revision_public_id
             AS prior_source_revision_public_id,
           item.knowledge_base_id
    FROM focowiki.publication_job_items membership
    JOIN focowiki.publication_items item
      ON item.public_id = membership.item_public_id
    LEFT JOIN focowiki.source_file_active_revisions active
      ON active.knowledge_base_id = item.knowledge_base_id
     AND active.source_file_public_id = item.source_file_public_id
    WHERE membership.job_public_id = ${jobPublicId}
    ORDER BY membership.membership_order
    LIMIT ${CONTRIBUTOR_CAP + 1}
  `;
  if (rows.length < 1 || rows.length > CONTRIBUTOR_CAP) {
    throw runtimeError("publication_job_item_limit_invalid");
  }
  const knowledgeBaseIds = new Set(rows.map((row) => row.knowledge_base_id));
  if (knowledgeBaseIds.size !== 1) {
    throw runtimeError("publication_job_knowledge_base_mismatch");
  }
  const revisionIds = [...new Set(rows.flatMap((row) => [
    row.prior_source_revision_public_id,
    row.operation === "delete" ? null : row.source_revision_public_id
  ].flatMap((value) => value ? [value] : [])))];
  const termRows = revisionIds.length === 0 ? [] : await sql<Array<{
    source_revision_public_id: string;
    bucket: string;
  }>>`
    SELECT DISTINCT source_revision_public_id COLLATE "C"
             AS source_revision_public_id,
           bucket COLLATE "C" AS bucket
    FROM focowiki.document_navigation_terms
    WHERE source_revision_public_id IN ${sql(revisionIds)}
    ORDER BY source_revision_public_id COLLATE "C", bucket COLLATE "C"
  `;
  const termsByRevision = groupValues(termRows,
    (row) => row.source_revision_public_id, (row) => row.bucket);
  const requestedSources = rows.map((row) => row.source_file_public_id);
  const desiredRevisions = rows.filter((row) => row.operation !== "delete")
    .map((row) => ({
      source_file_public_id: row.source_file_public_id,
      source_revision_public_id: row.source_revision_public_id
    }));
  const knowledgeBaseId = rows[0]!.knowledge_base_id;
  const relationRows = await sql<Array<{
    source_file_public_id: string;
    related_source_file_public_id: string;
    related_logical_path: string | null;
  }>>`
    WITH requested AS (
      SELECT unnest(${requestedSources}::text[]) AS source_file_public_id
    ), desired AS (
      SELECT source_file_public_id, source_revision_public_id
      FROM jsonb_to_recordset(${sql.json(desiredRevisions as never)})
        AS item(source_file_public_id text, source_revision_public_id text)
    )
    SELECT requested.source_file_public_id COLLATE "C"
             AS source_file_public_id,
           CASE WHEN relation.first_source_file_public_id
                           = requested.source_file_public_id
             THEN relation.second_source_file_public_id
             ELSE relation.first_source_file_public_id END
             AS related_source_file_public_id,
           related_record.logical_path AS related_logical_path
    FROM requested
    JOIN focowiki.canonical_file_relations relation
      ON relation.knowledge_base_id = ${knowledgeBaseId}
     AND (relation.active OR EXISTS (
       SELECT 1 FROM desired
       WHERE desired.source_revision_public_id
         IN (relation.first_source_revision_public_id,
             relation.second_source_revision_public_id)
     ))
     AND (relation.first_source_file_public_id = requested.source_file_public_id
       OR relation.second_source_file_public_id = requested.source_file_public_id)
    LEFT JOIN focowiki.source_file_active_revisions related_active
      ON related_active.knowledge_base_id = relation.knowledge_base_id
     AND related_active.source_file_public_id = CASE
       WHEN relation.first_source_file_public_id = requested.source_file_public_id
         THEN relation.second_source_file_public_id
       ELSE relation.first_source_file_public_id END
    LEFT JOIN desired related_desired
      ON related_desired.source_file_public_id = CASE
        WHEN relation.first_source_file_public_id
               = requested.source_file_public_id
          THEN relation.second_source_file_public_id
        ELSE relation.first_source_file_public_id END
    LEFT JOIN focowiki.document_projection_records related_record
      ON related_record.knowledge_base_id = relation.knowledge_base_id
     AND related_record.source_revision_public_id
           = coalesce(related_desired.source_revision_public_id,
               related_active.active_source_revision_public_id)
    ORDER BY requested.source_file_public_id COLLATE "C",
             CASE WHEN relation.first_source_file_public_id
                            = requested.source_file_public_id
               THEN relation.second_source_file_public_id
               ELSE relation.first_source_file_public_id END COLLATE "C",
             related_record.logical_path COLLATE "C" NULLS LAST
  `;
  const relationsBySource = groupValues(relationRows,
    (row) => row.source_file_public_id,
    (row) => row.related_source_file_public_id);
  const relatedPathsBySource = new Map<string, string[]>();
  for (const row of relationRows) {
    if (!row.related_logical_path) continue;
    const paths = relatedPathsBySource.get(row.source_file_public_id) ?? [];
    if (!paths.includes(row.related_logical_path)) {
      paths.push(row.related_logical_path);
    }
    relatedPathsBySource.set(row.source_file_public_id, paths);
  }
  return rows.map((row) => {
    const related = relationsBySource.get(row.source_file_public_id) ?? [];
    const relatedGraphDirectories = (relatedPathsBySource.get(
      row.source_file_public_id
    ) ?? []).flatMap(graphDirectories);
    return {
      mutationPublicId: row.mutation_public_id,
      documentJobPublicId: row.document_job_public_id,
      sourceFilePublicId: row.source_file_public_id,
      sourceRevisionPublicId: row.source_revision_public_id,
      readinessSequence: Number(row.readiness_sequence),
      operation: row.operation === "rename" ? "move" : row.operation,
      priorLogicalPath: row.prior_logical_path,
      nextLogicalPath: row.next_logical_path,
      priorTermBuckets: row.prior_source_revision_public_id
        ? termsByRevision.get(row.prior_source_revision_public_id) ?? [] : [],
      nextTermBuckets: row.operation === "delete" ? []
        : termsByRevision.get(row.source_revision_public_id) ?? [],
      relatedSourceFilePublicIds: related,
      priorGraphDirectoryPaths: related.length > 0
        ? [...new Set([
            ...graphDirectories(row.prior_logical_path),
            ...relatedGraphDirectories
          ])] : [],
      nextGraphDirectoryPaths: related.length > 0
        ? [...new Set([
            ...graphDirectories(row.next_logical_path),
            ...relatedGraphDirectories
          ])] : []
    };
  });
}

function graphDirectories(logicalPath: string | null): readonly string[] {
  if (!logicalPath) return [];
  const directories: string[] = [];
  let current = posix.dirname(logicalPath.startsWith("pages/")
    ? logicalPath : `pages/${logicalPath}`);
  while (current === "pages" || current.startsWith("pages/")) {
    directories.push(current);
    if (current === "pages") break;
    current = posix.dirname(current);
  }
  return directories;
}

function groupValues<T>(
  rows: readonly T[],
  key: (row: T) => string,
  value: (row: T) => string
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const values = grouped.get(key(row)) ?? [];
    if (!values.includes(value(row))) values.push(value(row));
    grouped.set(key(row), values);
  }
  return grouped;
}

function runtimeError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Publication job delta error: ${code}`), {
    code
  });
}
