import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryPath = resolve(
  import.meta.dirname,
  "../src/infrastructure/postgres/active-generation-read-repository.ts"
);
const searchRepositoryPath = resolve(
  import.meta.dirname,
  "../src/infrastructure/postgres/active-projection-search.ts"
);
const migrationPath = resolve(import.meta.dirname, "../migrations/001_production_admin_web.sql");
const runtimeMigrationPath = resolve(
  import.meta.dirname,
  "../migrations/008_large_scale_ingestion_runtime.sql"
);
const readRepairMigrationPath = resolve(
  import.meta.dirname,
  "../migrations/010_generation_consistent_read_repair.sql"
);

function normalized(path: string): string {
  return readFileSync(path, "utf8").replace(/\s+/g, " ").toLowerCase();
}

function functionBody(source: string, name: string, nextName: string): string {
  const start = source.indexOf(`function ${name.toLowerCase()}`);
  const end = source.indexOf(`function ${nextName.toLowerCase()}`, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("active generation search read-model contract", () => {
  it("searches active file and graph projections with direct file continuity", () => {
    const repository = normalized(repositoryPath);
    const search = normalized(searchRepositoryPath);
    expect(repository).toContain("searchactiveprojections");
    expect(search).toContain("retrieveexactcandidates");
    expect(search).toContain("retrievefulltextcandidates");
    expect(search).toContain("retrievetrigramcandidates");
    expect(search).toContain("focowiki.similarity(");
    expect(search).not.toMatch(/(?<!focowiki\.)\bsimilarity\(/u);
    expect(search).toContain("lower(coalesce(record.searchable_text, '')) like");
    expect(search).toContain("limit ${input.candidatelimit}");
    expect(search).toContain("join focowiki.active_object_refs file");
    expect(search).toContain("file.ref_kind = 'page'");
    expect(search).toContain("'fileid', file.file_id");
    expect(search).toContain("'path', file.logical_path");
    expect(search).toContain("limit ${input.limit + 1}");
    expect(search).not.toMatch(/and \( to_tsvector[^;]{0,300} or lower/u);
    expect(search).not.toContain(" offset ");
  });

  it("bounds full-text and fuzzy candidates before relevance scoring", () => {
    const search = normalized(searchRepositoryPath);
    const candidateRetrieval = functionBody(
      search,
      "retrieveexactcandidates",
      "hydratesearchcandidates"
    );

    expect(candidateRetrieval.match(/with bounded_candidates as materialized/gu)).toHaveLength(4);
    expect(candidateRetrieval).toContain("limit ${input.candidatelimit}");
    expect(candidateRetrieval).not.toContain("order by ts_rank_cd(");
    expect(candidateRetrieval).not.toContain("order by focowiki.similarity(");
    expect(search).toContain("ts_rank_cd(");
    expect(search).toContain("focowiki.similarity(");
  });

  it("uses literal file and graph candidate families so partial indexes remain usable", () => {
    const search = normalized(searchRepositoryPath);
    expect(search).toContain("retrievefilecandidates");
    expect(search).toContain("retrievegraphcandidates");
    expect(search).toContain("record.projection_kind = 'search'");
    expect(search).toContain("record.projection_kind in ('graph_node', 'graph_edge')");
    expect(search).not.toContain("${input.mode} in ('file', 'hybrid')");
    expect(search).not.toContain("${input.mode} in ('graph', 'hybrid')");
  });

  it("bounds graph edge traversal with forward and reverse endpoint indexes", () => {
    const repository = `${normalized(repositoryPath)} ${normalized(searchRepositoryPath)}`;
    const migration = `${normalized(migrationPath)} ${normalized(runtimeMigrationPath)} ${normalized(readRepairMigrationPath)}`;
    expect(repository).toContain("edge.source_file_id = ${input.sourcefileid}");
    expect(repository).toContain("edge.related_source_file_id = ${input.sourcefileid}");
    expect(migration).toContain("active_projection_records_graph_edge_source_weight_idx");
    expect(migration).toContain("active_projection_records_graph_edge_related_weight_idx");
    expect(migration).toContain("active_projection_records_search_source_idx");
  });

  it("filters tombstoned endpoints from search and related traversal", () => {
    const repository = `${normalized(repositoryPath)} ${normalized(searchRepositoryPath)}`;
    expect(repository).toContain("source.deleted_at is null");
    expect(repository).toContain("source.deletion_intent_id is null");
    expect(repository).toContain("related.deleted_at is null");
    expect(repository).toContain("related.deletion_intent_id is null");
  });

  it("defines active file, tree, file-search, and graph-search indexes", () => {
    const migration = `${normalized(migrationPath)} ${normalized(runtimeMigrationPath)} ${normalized(readRepairMigrationPath)}`;
    expect(migration).toContain("active_object_refs_path_idx");
    expect(migration).toContain("active_object_refs_file_idx");
    expect(migration).toContain("active_projection_records_tree_idx");
    expect(migration).toContain("active_projection_records_tree_search_trgm_idx");
    expect(migration).toContain("active_projection_records_search_fts_idx");
    expect(migration).toContain("active_projection_records_search_trgm_idx");
    expect(migration).toContain("active_projection_records_graph_search_fts_idx");
    expect(migration).toContain("active_projection_records_graph_search_trgm_idx");
    expect(migration).toContain("active_projection_records_search_title_exact_idx");
    expect(migration).toContain("active_projection_records_graph_title_exact_idx");
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
