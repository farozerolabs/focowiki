import type { DatabaseClient } from "../../db/client.js";
import type { DocumentPublicationFactDelta } from
  "../application/document-publication-planner.js";

export async function replacePostgresDocumentGenerationStatistics(input: {
  transaction: DatabaseClient;
  generationPublicId: string;
  baseGenerationPublicId: string | null;
  knowledgeBaseId: string;
  documents: readonly DocumentPublicationFactDelta[];
  createdAt: string;
}): Promise<void> {
  const sql = input.transaction;
  const excludedSources = [...new Set(input.documents.map((document) =>
    document.sourceFilePublicId))].sort();
  const sourceDelta = input.documents.reduce((total, document) =>
    total + (document.operation === "create" ? 1
      : document.operation === "delete" ? -1 : 0), 0);
  const priorRootKeys = new Set(input.documents.flatMap((document) =>
    document.priorLogicalPath
      ? [rootEntryKey(document.priorLogicalPath, document.sourceFilePublicId)]
      : []));
  const nextRootKeys = new Set(input.documents.flatMap((document) =>
    document.nextLogicalPath
      ? [rootEntryKey(document.nextLogicalPath, document.sourceFilePublicId)]
      : []));
  const touchedRootKeys = [...new Set([
    ...priorRootKeys, ...nextRootKeys
  ])].sort();
  const unaffectedRootRows = input.baseGenerationPublicId === null
    || touchedRootKeys.length === 0 ? []
    : await sql<Array<{ root_key: string }>>`
        SELECT root_key
        FROM unnest(${touchedRootKeys}::text[]) root(root_key)
        WHERE left(root_key, 10) = 'directory:'
          AND EXISTS (
            SELECT 1
            FROM focowiki.document_projection_records record
            WHERE record.knowledge_base_id = ${input.knowledgeBaseId}
              AND record.active
              AND record.source_file_public_id
                    <> ALL(${excludedSources}::text[])
              AND position('/' in record.logical_path) > 0
              AND split_part(record.logical_path, '/', 1)
                    = substring(root_key from 11)
          )
        ORDER BY root_key COLLATE "C"
      `;
  const unaffectedRootKeys = new Set(unaffectedRootRows.map((row) =>
    row.root_key));
  const priorTouchedRootCount = new Set([
    ...unaffectedRootKeys, ...priorRootKeys
  ]).size;
  const nextTouchedRootCount = new Set([
    ...unaffectedRootKeys, ...nextRootKeys
  ]).size;
  const rows = await sql<Array<{
    base_source_count: number | string;
    base_relationship_count: number | string;
    base_root_entry_count: number | string;
    prior_degree_sum: number | string;
    candidate_degree_sum: number | string;
  }>>`
    WITH base AS (
      SELECT source_file_count, relationship_count, root_entry_count
      FROM focowiki.projection_generation_statistics
      WHERE publication_generation_public_id
              = ${input.baseGenerationPublicId}
    ), overlay_revision AS (
      SELECT source_revision_public_id
      FROM focowiki.projection_generation_graph_degrees
      WHERE publication_generation_public_id = ${input.generationPublicId}
    ), prior_revision AS (
      SELECT record.source_revision_public_id
      FROM focowiki.document_projection_records record
      WHERE record.knowledge_base_id = ${input.knowledgeBaseId}
        AND record.active
        AND (record.source_file_public_id = ANY(${excludedSources}::text[])
          OR record.source_revision_public_id IN (
            SELECT source_revision_public_id FROM overlay_revision
          ))
    )
    SELECT coalesce((SELECT source_file_count FROM base), 0)
             AS base_source_count,
           coalesce((SELECT relationship_count FROM base), 0)
             AS base_relationship_count,
           coalesce((SELECT root_entry_count FROM base), 0)
             AS base_root_entry_count,
           coalesce((
             SELECT sum(degree.incoming_count + degree.outgoing_count)
             FROM focowiki.document_graph_degrees degree
             WHERE degree.knowledge_base_id = ${input.knowledgeBaseId}
               AND degree.source_revision_public_id IN (
                 SELECT source_revision_public_id FROM prior_revision
               )
           ), 0) AS prior_degree_sum,
           coalesce((
             SELECT sum(degree.incoming_count + degree.outgoing_count)
             FROM focowiki.projection_generation_graph_degrees degree
             WHERE degree.publication_generation_public_id
                     = ${input.generationPublicId}
           ), 0) AS candidate_degree_sum
  `;
  const row = rows[0]!;
  const degreeDelta = Number(row.candidate_degree_sum)
    - Number(row.prior_degree_sum);
  if (degreeDelta % 2 !== 0) {
    throw statisticsError("projection_relationship_degree_delta_invalid");
  }
  const sourceFileCount = Number(row.base_source_count) + sourceDelta;
  const relationshipCount = Number(row.base_relationship_count)
    + degreeDelta / 2;
  if (sourceFileCount < 0 || relationshipCount < 0) {
    throw statisticsError("projection_generation_statistics_invalid");
  }
  await sql`
    INSERT INTO focowiki.projection_generation_statistics (
      publication_generation_public_id, knowledge_base_id,
      source_file_count, relationship_count, root_entry_count, created_at
    ) VALUES (
      ${input.generationPublicId}, ${input.knowledgeBaseId},
      ${sourceFileCount}, ${relationshipCount},
      ${Number(row.base_root_entry_count) + nextTouchedRootCount
        - priorTouchedRootCount}, ${input.createdAt}
    )
    ON CONFLICT (publication_generation_public_id) DO UPDATE
    SET source_file_count = excluded.source_file_count,
        relationship_count = excluded.relationship_count,
        root_entry_count = excluded.root_entry_count,
        created_at = excluded.created_at
  `;
}

function rootEntryKey(logicalPath: string, sourceFilePublicId: string): string {
  const normalized = logicalPath.startsWith("pages/")
    ? logicalPath.slice("pages/".length) : logicalPath;
  const separator = normalized.indexOf("/");
  return separator === -1 ? `file:${sourceFilePublicId}`
    : `directory:${normalized.slice(0, separator)}`;
}

function statisticsError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Projection statistics error: ${code}`), {
    code
  });
}
