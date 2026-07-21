import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryPath = resolve(
  import.meta.dirname,
  "../src/infrastructure/postgres/active-generation-read-repository.ts"
);
const migrationPath = resolve(import.meta.dirname, "../migrations/001_production_admin_web.sql");
const runtimeMigrationPath = resolve(
  import.meta.dirname,
  "../migrations/008_large_scale_ingestion_runtime.sql"
);

function normalized(path: string): string {
  return readFileSync(path, "utf8").replace(/\s+/g, " ").toLowerCase();
}

describe("active generation search read-model contract", () => {
  it("searches active file and graph projections with direct file continuity", () => {
    const repository = normalized(repositoryPath);
    expect(repository).toContain("const search_candidate_multiplier = 10");
    expect(repository).toContain("with file_matches as materialized");
    expect(repository).toContain("graph_matches as materialized");
    expect(repository).toContain("lower(coalesce(record.searchable_text, '')) like");
    expect(repository).toContain("limit ${candidatelimit}");
    expect(repository).toContain("from focowiki.active_projection_records record");
    expect(repository).toContain("join focowiki.active_object_refs file");
    expect(repository).toContain("file.ref_kind = 'page'");
    expect(repository).toContain("'fileid', file.file_id");
    expect(repository).toContain("'path', file.logical_path");
    expect(repository).toContain("limit ${input.limit + 1}");
    expect(repository).not.toContain(" offset ");
  });

  it("bounds graph edge traversal with forward and reverse endpoint indexes", () => {
    const repository = normalized(repositoryPath);
    const migration = `${normalized(migrationPath)} ${normalized(runtimeMigrationPath)}`;
    expect(repository).toContain("edge.source_file_id = ${input.sourcefileid}");
    expect(repository).toContain("edge.related_source_file_id = ${input.sourcefileid}");
    expect(migration).toContain("active_projection_records_graph_edge_source_weight_idx");
    expect(migration).toContain("active_projection_records_graph_edge_related_weight_idx");
    expect(migration).toContain("active_projection_records_search_source_idx");
  });

  it("filters tombstoned endpoints from search and related traversal", () => {
    const repository = normalized(repositoryPath);
    expect(repository).toContain("source.deleted_at is null");
    expect(repository).toContain("source.deletion_intent_id is null");
    expect(repository).toContain("related.deleted_at is null");
    expect(repository).toContain("related.deletion_intent_id is null");
  });

  it("defines active file, tree, file-search, and graph-search indexes", () => {
    const migration = `${normalized(migrationPath)} ${normalized(runtimeMigrationPath)}`;
    expect(migration).toContain("active_object_refs_path_idx");
    expect(migration).toContain("active_object_refs_file_idx");
    expect(migration).toContain("active_projection_records_tree_idx");
    expect(migration).toContain("active_projection_records_tree_search_trgm_idx");
    expect(migration).toContain("active_projection_records_search_fts_idx");
    expect(migration).toContain("active_projection_records_search_trgm_idx");
    expect(migration).toContain("active_projection_records_graph_search_fts_idx");
    expect(migration).toContain("active_projection_records_graph_search_trgm_idx");
    expect(migration).toContain("active_generation_read_format_idx");
    expect(migration).toContain("source_directory_statistics_directory_idx");
    expect(migration).toContain("active_generated_directory_stats_lookup_idx");
  });

  it("contains no release-scoped or bundle-scoped search tables", () => {
    const repository = normalized(repositoryPath);
    const migration = normalized(migrationPath);
    for (const source of [repository, migration]) {
      expect(source).not.toContain("bundle_file_search_documents");
      expect(source).not.toContain("knowledge_graph_search_documents");
      expect(source).not.toContain("release_read_summaries");
    }
  });
});
