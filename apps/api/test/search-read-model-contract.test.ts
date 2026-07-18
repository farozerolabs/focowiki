import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryPath = resolve(
  import.meta.dirname,
  "../src/infrastructure/postgres/active-generation-read-repository.ts"
);
const migrationPath = resolve(import.meta.dirname, "../migrations/001_production_admin_web.sql");

function normalized(path: string): string {
  return readFileSync(path, "utf8").replace(/\s+/g, " ").toLowerCase();
}

describe("active generation search read-model contract", () => {
  it("searches active file and graph projections with direct file continuity", () => {
    const repository = normalized(repositoryPath);
    expect(repository).toContain("from focowiki.active_projection_records record");
    expect(repository).toContain("join focowiki.active_object_refs file");
    expect(repository).toContain("file.ref_kind = 'page'");
    expect(repository).toContain("'fileid', file.file_id");
    expect(repository).toContain("'path', file.logical_path");
    expect(repository).toContain("limit ${input.limit + 1}");
    expect(repository).not.toContain(" offset ");
  });

  it("filters tombstoned endpoints from search and related traversal", () => {
    const repository = normalized(repositoryPath);
    expect(repository).toContain("source.deleted_at is null");
    expect(repository).toContain("source.deletion_intent_id is null");
    expect(repository).toContain("related.deleted_at is null");
    expect(repository).toContain("related.deletion_intent_id is null");
  });

  it("defines active file, tree, file-search, and graph-search indexes", () => {
    const migration = normalized(migrationPath);
    expect(migration).toContain("active_object_refs_path_idx");
    expect(migration).toContain("active_object_refs_file_idx");
    expect(migration).toContain("active_projection_records_tree_idx");
    expect(migration).toContain("active_projection_records_tree_search_trgm_idx");
    expect(migration).toContain("active_projection_records_search_fts_idx");
    expect(migration).toContain("active_projection_records_search_trgm_idx");
    expect(migration).toContain("active_projection_records_graph_search_fts_idx");
    expect(migration).toContain("active_projection_records_graph_search_trgm_idx");
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
