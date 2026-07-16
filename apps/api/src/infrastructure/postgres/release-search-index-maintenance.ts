import type { DatabaseClient } from "../../db/client.js";

const RELEASE_READ_MODEL_GIN_INDEXES = [
  "bundle_file_search_documents_search_text_trgm_idx",
  "bundle_file_search_documents_metadata_text_trgm_idx",
  "bundle_file_search_documents_path_text_trgm_idx",
  "knowledge_file_tree_nodes_name_trgm_idx",
  "knowledge_file_tree_nodes_path_trgm_idx",
  "knowledge_file_tree_nodes_search_text_trgm_idx",
  "knowledge_graph_edges_reason_trgm_idx",
  "knowledge_graph_nodes_profile_text_trgm_idx",
  "knowledge_graph_search_documents_search_text_trgm_idx",
  "knowledge_graph_search_documents_neighbor_text_trgm_idx"
] as const;

export type ReleaseSearchIndexMaintenanceResult = {
  indexCount: number;
  pagesCleaned: number;
};

export async function cleanReleaseReadModelGinPendingLists(
  sql: DatabaseClient
): Promise<ReleaseSearchIndexMaintenanceResult> {
  let pagesCleaned = 0;

  for (const indexName of RELEASE_READ_MODEL_GIN_INDEXES) {
    const rows = await sql.unsafe<Array<{ pages_cleaned: string | number }>>(
      `SELECT pg_catalog.gin_clean_pending_list('focowiki.${indexName}'::regclass) AS pages_cleaned`
    );
    pagesCleaned += Number(rows[0]?.pages_cleaned ?? 0);
  }

  return {
    indexCount: RELEASE_READ_MODEL_GIN_INDEXES.length,
    pagesCleaned
  };
}
