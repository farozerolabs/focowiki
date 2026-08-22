import { posix } from "node:path";
import type { DatabaseClient } from "../../db/client.js";
import type { DocumentPublicationFactDelta } from
  "../application/document-publication-planner.js";

const CONTRIBUTOR_CAP = 256;

export async function readGenerationFactDeltas(
  sql: DatabaseClient,
  generationPublicId: string
): Promise<readonly DocumentPublicationFactDelta[]> {
  const rows = await sql<Array<{
    mutation_public_id: string;
    document_job_public_id: string | null;
    source_file_public_id: string;
    source_revision_public_id: string;
    fact_epoch: number | string;
    fact_kind: string;
    prior_logical_path: string | null;
    next_logical_path: string | null;
    prior_source_revision_public_id: string | null;
  }>>`
    SELECT document.mutation_public_id, document.document_job_public_id,
           document.source_file_public_id,
           document.source_revision_public_id, document.fact_epoch,
           epoch.fact_kind, prior.logical_path AS prior_logical_path,
           CASE WHEN epoch.fact_kind = 'delete' THEN NULL
             ELSE successor.logical_path END AS next_logical_path,
           coalesce(
             active.active_source_revision_public_id,
             CASE WHEN epoch.fact_kind = 'delete'
               THEN document.source_revision_public_id END
           ) AS prior_source_revision_public_id
    FROM focowiki.projection_generation_documents document
    JOIN focowiki.projection_publication_generations generation
      ON generation.public_id = document.generation_public_id
    JOIN focowiki.projection_fact_epochs epoch
      ON epoch.knowledge_base_id = generation.knowledge_base_id
     AND epoch.mutation_public_id = document.mutation_public_id
     AND epoch.fact_epoch = document.fact_epoch
    LEFT JOIN focowiki.source_file_active_revisions active
      ON active.knowledge_base_id = generation.knowledge_base_id
     AND active.source_file_public_id = epoch.source_file_public_id
    LEFT JOIN focowiki.document_projection_records prior
      ON prior.knowledge_base_id = generation.knowledge_base_id
     AND prior.source_revision_public_id
           = coalesce(
             active.active_source_revision_public_id,
             CASE WHEN epoch.fact_kind = 'delete'
               THEN document.source_revision_public_id END
           )
    LEFT JOIN focowiki.document_projection_records successor
      ON successor.knowledge_base_id = generation.knowledge_base_id
     AND successor.source_revision_public_id
           = document.source_revision_public_id
    WHERE document.generation_public_id = ${generationPublicId}
      AND epoch.source_file_public_id IS NOT NULL
    ORDER BY document.fact_epoch, document.mutation_public_id COLLATE "C"
    LIMIT 257
  `;
  if (rows.length > CONTRIBUTOR_CAP) throw runtimeError("generation_delta_limit");
  const revisionIds = [...new Set(rows.flatMap((row) => [
    row.prior_source_revision_public_id,
    row.source_revision_public_id
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
    LIMIT 10001
  `;
  if (termRows.length > 10_000) throw runtimeError("generation_term_limit");
  const termsByRevision = groupValues(termRows,
    (row) => row.source_revision_public_id, (row) => row.bucket);
  const relationInputs = rows.map((row) => ({
    source_file_public_id: row.source_file_public_id,
    prior_source_revision_public_id: row.prior_source_revision_public_id,
    next_source_revision_public_id: row.fact_kind === "delete"
      ? null : row.source_revision_public_id
  }));
  const relationRows = relationInputs.length === 0 ? [] : await sql<Array<{
    source_file_public_id: string;
    related_source_file_public_id: string;
    related_logical_path: string | null;
  }>>`
    SELECT requested.source_file_public_id COLLATE "C"
             AS source_file_public_id,
           (CASE WHEN relation.first_source_file_public_id
                         = requested.source_file_public_id
             THEN relation.second_source_file_public_id
             ELSE relation.first_source_file_public_id END) COLLATE "C"
             AS related_source_file_public_id,
           related_record.logical_path AS related_logical_path
    FROM jsonb_to_recordset(${sql.json(relationInputs as never)}::jsonb)
      AS requested(
        source_file_public_id text,
        prior_source_revision_public_id text,
        next_source_revision_public_id text
      )
    JOIN focowiki.projection_publication_generations requested_generation
      ON requested_generation.public_id = ${generationPublicId}
    JOIN focowiki.canonical_file_relations relation
      ON relation.first_source_file_public_id = requested.source_file_public_id
      OR relation.second_source_file_public_id = requested.source_file_public_id
    LEFT JOIN focowiki.document_projection_records related_record
      ON related_record.knowledge_base_id
           = requested_generation.knowledge_base_id
     AND related_record.source_file_public_id = CASE
       WHEN relation.first_source_file_public_id
              = requested.source_file_public_id
         THEN relation.second_source_file_public_id
       ELSE relation.first_source_file_public_id END
     AND related_record.source_revision_public_id = CASE
       WHEN relation.first_source_file_public_id
              = requested.source_file_public_id
         THEN relation.second_source_revision_public_id
       ELSE relation.first_source_revision_public_id END
    WHERE (CASE
      WHEN relation.first_source_file_public_id = requested.source_file_public_id
        THEN relation.first_source_revision_public_id
      ELSE relation.second_source_revision_public_id
    END) = ANY(ARRAY[
      requested.prior_source_revision_public_id,
      requested.next_source_revision_public_id
    ]::text[])
      AND (
        EXISTS (
          SELECT 1
          FROM focowiki.source_file_active_revisions related_active
          WHERE related_active.knowledge_base_id
                  = requested_generation.knowledge_base_id
            AND related_active.source_file_public_id = CASE
              WHEN relation.first_source_file_public_id
                    = requested.source_file_public_id
                THEN relation.second_source_file_public_id
              ELSE relation.first_source_file_public_id END
            AND related_active.active_source_revision_public_id = CASE
              WHEN relation.first_source_file_public_id
                    = requested.source_file_public_id
                THEN relation.second_source_revision_public_id
              ELSE relation.first_source_revision_public_id END
        )
        OR EXISTS (
          SELECT 1
          FROM focowiki.projection_generation_documents related_document
          WHERE related_document.generation_public_id = ${generationPublicId}
            AND related_document.source_file_public_id = CASE
              WHEN relation.first_source_file_public_id
                    = requested.source_file_public_id
                THEN relation.second_source_file_public_id
              ELSE relation.first_source_file_public_id END
            AND related_document.source_revision_public_id = CASE
              WHEN relation.first_source_file_public_id
                    = requested.source_file_public_id
                THEN relation.second_source_revision_public_id
              ELSE relation.first_source_revision_public_id END
        )
      )
    ORDER BY source_file_public_id, related_source_file_public_id,
             related_record.logical_path COLLATE "C" NULLS LAST
    LIMIT 10001
  `;
  if (relationRows.length > 10_000) {
    throw runtimeError("generation_relation_limit");
  }
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
      factEpoch: Number(row.fact_epoch),
      operation: normalizeOperation(row.fact_kind),
      priorLogicalPath: row.prior_logical_path,
      nextLogicalPath: row.next_logical_path,
      priorTermBuckets: row.prior_source_revision_public_id
        ? termsByRevision.get(row.prior_source_revision_public_id) ?? [] : [],
      nextTermBuckets: row.fact_kind === "delete" ? []
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

function normalizeOperation(
  value: string
): DocumentPublicationFactDelta["operation"] {
  return ["create", "replace", "move", "delete", "repair"].includes(value)
    ? value as DocumentPublicationFactDelta["operation"] : "repair";
}

function graphDirectories(logicalPath: string | null): readonly string[] {
  if (!logicalPath) return [];
  const directories: string[] = [];
  let current = posix.dirname(`pages/${logicalPath}`);
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
  return Object.assign(new Error(`Publication coordinator error: ${code}`), {
    code
  });
}
