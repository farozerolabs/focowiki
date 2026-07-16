import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryPath = resolve(import.meta.dirname, "../src/db/admin-repositories.ts");
const servicePath = resolve(import.meta.dirname, "../src/developer-openapi/services.ts");
const migrationPath = resolve(import.meta.dirname, "../migrations/001_production_admin_web.sql");
const indexMaintenancePath = resolve(
  import.meta.dirname,
  "../src/infrastructure/postgres/release-search-index-maintenance.ts"
);

function normalized(path: string): string {
  return readFileSync(path, "utf8").replace(/\s+/g, " ").toLowerCase();
}

function section(source: string, start: string, end: string): string {
  return source.slice(source.indexOf(start), source.indexOf(end));
}

describe("release search read-model contract", () => {
  it("serves file search from bounded flat documents without request-time JSON scans", () => {
    const repository = normalized(repositoryPath);
    const search = section(
      repository,
      "async searchbundlefiles",
      "async rebuildreleasegraphprojection"
    );

    expect(search).toContain("from focowiki.bundle_file_search_documents document");
    expect(search).toContain("limit ${candidatelimit}");
    expect(search).toContain("limit ${limit + 1}");
    expect(search).not.toContain("tags_json::text");
    expect(search).not.toContain("frontmatter_json::text");
    expect(search).not.toContain(" offset ");
  });

  it("serves graph search from bounded flat text and one release summary", () => {
    const repository = normalized(repositoryPath);
    const graphSearch = section(
      repository,
      "async searchbundlegraphfiles",
      "async listpublicationloghistory"
    );
    const service = normalized(servicePath);

    expect(graphSearch).toContain("from focowiki.knowledge_graph_search_documents document");
    expect(graphSearch).toContain("document.neighbor_text ilike");
    expect(graphSearch).toContain("limit ${candidatelimit}");
    expect(graphSearch).not.toContain("top_neighbors_json::text");
    expect(graphSearch).not.toContain("evidence_json::text");
    expect(service).toContain("getreleasereadsummary");
    expect(service).not.toContain("countbundlegraphsearchdocuments");
    expect(service).not.toContain("countbundlegraphrelationships");
  });

  it("keeps canonical graph insight fields authoritative over stored payload fields", () => {
    const repository = normalized(repositoryPath);
    const graphInsights = section(
      repository,
      "async getreleasegraphinsights",
      "async createbundletreeentries"
    );

    expect(graphInsights).toContain(
      "insight.payload_json || jsonb_build_object( 'insightid', insight.id"
    );
    expect(graphInsights).not.toContain(
      ") || insight.payload_json order by insight.created_at"
    );
  });

  it("defines release-scoped search, cursor, graph, and summary indexes in the final schema", () => {
    const migration = normalized(migrationPath);

    expect(migration).toContain("create table focowiki.bundle_file_search_documents");
    expect(migration).toContain("create table focowiki.release_read_summaries");
    expect(migration).toContain("bundle_file_search_documents_search_text_trgm_idx");
    expect(migration).toContain("bundle_file_search_documents_metadata_text_trgm_idx");
    expect(migration).toContain("bundle_file_search_documents_path_text_trgm_idx");
    expect(migration).toContain("bundle_file_search_documents_release_cursor_idx");
    expect(migration).toContain("knowledge_graph_search_documents_search_text_trgm_idx");
    expect(migration).toContain("knowledge_graph_search_documents_neighbor_text_trgm_idx");
    expect(migration).toContain("knowledge_graph_search_documents_kb_file_idx");
    expect(migration).toContain("knowledge_graph_search_documents_release_cursor_idx");
    expect(migration.match(/with \(fastupdate = on, gin_pending_list_limit = 65536\)/g)).toHaveLength(10);
    expect(migration).not.toContain("fastupdate = off");
    expect(migration).toContain("release_read_summaries_knowledge_base_idx");
  });

  it("finalizes every immutable release GIN index before activation", () => {
    const maintenance = normalized(indexMaintenancePath);

    expect(maintenance).toContain("pg_catalog.gin_clean_pending_list");
    expect(maintenance).toContain("bundle_file_search_documents_search_text_trgm_idx");
    expect(maintenance).toContain("knowledge_file_tree_nodes_search_text_trgm_idx");
    expect(maintenance).toContain("knowledge_graph_edges_reason_trgm_idx");
    expect(maintenance).toContain("knowledge_graph_nodes_profile_text_trgm_idx");
    expect(maintenance).toContain("knowledge_graph_search_documents_neighbor_text_trgm_idx");
  });
});
