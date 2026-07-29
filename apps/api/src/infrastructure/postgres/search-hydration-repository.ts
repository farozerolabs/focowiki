import type { SerializableJson } from "../../application/ports/source-dispatch-repository.js";
import type { SearchHydrationRecord } from "../../search/search-hydration.js";
import type { DatabaseClient } from "../../db/client.js";
import type { TransactionSql } from "postgres";

type ReadSql = DatabaseClient | TransactionSql;

type HydrationRow = {
  source_file_id: string;
  source_revision_id: string;
  file_id: string;
  record_id: string;
  logical_path: string;
  title: string | null;
  summary: string | null;
  payload_json: SerializableJson | null;
};

export async function loadActiveSearchHydrationRecords(input: {
  sql: ReadSql;
  knowledgeBaseId: string;
  sourceFileIds: string[];
  projection: "search" | "graph_node";
}): Promise<SearchHydrationRecord[]> {
  const sourceFileIds = [...new Set(input.sourceFileIds)].slice(0, 2_000);
  if (sourceFileIds.length === 0) return [];
  const rows = await input.sql<HydrationRow[]>`
    WITH requested AS (
      SELECT source_file_id, ordinal
      FROM unnest(${sourceFileIds}::text[])
        WITH ORDINALITY AS item(source_file_id, ordinal)
    )
    SELECT DISTINCT ON (requested.ordinal)
           source.id AS source_file_id,
           source.active_revision_id AS source_revision_id,
           active.file_id,
           coalesce(projection.record_id, 'search-' || source.id) AS record_id,
           active.logical_path,
           coalesce(projection.title, search.title, source.name) AS title,
           coalesce(projection.summary, search.summary) AS summary,
           coalesce(projection.payload_json, search.payload_json, '{}'::jsonb)
             AS payload_json
    FROM requested
    JOIN focowiki.source_files source
      ON source.id = requested.source_file_id
     AND source.knowledge_base_id = ${input.knowledgeBaseId}
     AND source.deleted_at IS NULL
     AND source.task_deleted_at IS NULL
     AND source.deletion_intent_id IS NULL
     AND source.generated_output_status = 'visible'
    JOIN focowiki.active_object_refs active
      ON active.knowledge_base_id = source.knowledge_base_id
     AND active.source_file_id = source.id
     AND active.ref_kind = 'page'
     AND active.logical_path IS NOT NULL
    LEFT JOIN focowiki.active_projection_records projection
      ON projection.knowledge_base_id = source.knowledge_base_id
     AND projection.source_file_id = source.id
     AND projection.projection_kind = ${input.projection}
    LEFT JOIN focowiki.active_projection_records search
      ON search.knowledge_base_id = source.knowledge_base_id
     AND search.source_file_id = source.id
     AND search.projection_kind = 'search'
    ORDER BY requested.ordinal, active.logical_path, active.file_id
  `;
  return rows.map((row) => ({
    sourceFileId: row.source_file_id,
    sourceRevisionId: row.source_revision_id,
    visible: true,
    fileId: row.file_id,
    recordId: row.record_id,
    logicalPath: row.logical_path,
    title: row.title,
    summary: row.summary,
    payload: row.payload_json ?? {}
  }));
}
