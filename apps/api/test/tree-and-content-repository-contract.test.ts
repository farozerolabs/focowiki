import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryPath = resolve(
  import.meta.dirname,
  "../src/infrastructure/postgres/active-generation-read-repository.ts"
);
const treeReadModelPath = resolve(
  import.meta.dirname,
  "../src/infrastructure/postgres/active-tree-read-model.ts"
);
const treeStatisticsPath = resolve(
  import.meta.dirname,
  "../src/infrastructure/postgres/active-tree-statistics.ts"
);
const routesPath = resolve(import.meta.dirname, "../src/developer-openapi/routes.ts");
const projectionWriterPath = resolve(
  import.meta.dirname,
  "../src/publication/required-projection-writer.ts"
);
const sourceResourceRepositoryPath = resolve(
  import.meta.dirname,
  "../src/infrastructure/postgres/source-resource-repository.ts"
);
const largeScaleMigrationPath = resolve(
  import.meta.dirname,
  "../migrations/008_large_scale_ingestion_runtime.sql"
);

function normalized(path: string): string {
  return readFileSync(path, "utf8").replace(/\s+/g, " ").toLowerCase();
}

describe("active tree and generated-content repository contract", () => {
  it("resolves one active generation inside a repeatable-read request scope", () => {
    const repository = normalized(repositoryPath);
    expect(repository).toContain("isolation level repeatable read read only");
    expect(repository).toContain("join focowiki.publication_generations generation");
    expect(repository).toContain("generation.state = 'active'");
    expect(repository).toContain("generation.format_version");
    expect(repository).toContain("knowledge_base_optimization_migrations migration");
    expect(repository).toContain(
      "return reader(createscope(transaction, knowledgebaseid, active.active_generation_id"
    );
  });

  it("keeps optimized reads on active materialized projections with one bounded fallback", () => {
    const repository = normalized(repositoryPath);
    const statistics = normalized(treeStatisticsPath);
    expect(repository).toContain("coalesce(migration.state, 'legacy_readable') as optimization_state");
    expect(repository).toContain("active graph summary is unavailable");
    expect(statistics).toContain("with requested(path) as materialized");
    expect(statistics).toContain("child.parent_path = any(${unresolvedpaths})");
    expect(statistics).toContain("descendant.logical_path >= requested.path || '/'");
    expect(repository).not.toContain("from focowiki.projection_segments");
    expect(repository).not.toContain("from focowiki.generation_projection_segments");
    expect(statistics).not.toContain("from focowiki.projection_segments");
  });

  it("lists and searches active tree projections with keyset pagination", () => {
    const treeReadModel = normalized(treeReadModelPath);
    expect(treeReadModel).toContain("projection_kind = 'tree'");
    expect(treeReadModel).toContain("coalesce(record.parent_path, '') = ${input.parentpath}");
    expect(treeReadModel).toContain("(coalesce(record.sort_key, ''), record.record_id) >");
    expect(treeReadModel).toContain("order by coalesce(record.sort_key, ''), record.record_id");
    expect(treeReadModel).toContain("source.id = record.source_file_id");
    expect(treeReadModel).toContain("limit ${input.limit + 1}");
    expect(treeReadModel).toContain("logical_path in ${sql(ancestorpaths)}");
    expect(treeReadModel).toContain("from focowiki.active_object_refs");
    expect(treeReadModel).not.toContain(" offset ");
  });

  it("reads persisted directory counts without request-time corpus traversal", () => {
    const treeReadModel = normalized(treeReadModelPath);
    const sourceResources = normalized(sourceResourceRepositoryPath);
    const directoryReads = sourceResources.slice(
      sourceResources.indexOf("async listdirectories(input)"),
      sourceResources.indexOf("async listsourcefiles(input)")
    );

    expect(treeReadModel).toContain("from focowiki.active_generated_directory_stats");
    expect(treeReadModel).not.toContain("select count(*)::int from focowiki.active_object_refs");
    expect(directoryReads).toContain("focowiki.source_directory_statistics");
    expect(directoryReads).toContain("with directory_page as materialized");
    expect(directoryReads).not.toContain("with recursive");
    expect(directoryReads).not.toContain("select count(*)::int from focowiki.source_files");
  });

  it("does not scan generated-object references below source page directories", () => {
    const treeReadModel = normalized(treeReadModelPath);
    const migration = normalized(largeScaleMigrationPath);
    expect(treeReadModel).toContain("ref_kind not in ('page', 'generation_manifest')");
    expect(migration).toContain("active_object_refs_generated_path_idx");
    expect(migration).toContain(
      "where logical_path is not null and ref_kind not in ('page', 'generation_manifest')"
    );
  });

  it("indexes the exact source-tree parent and sort expressions used by pagination", () => {
    const migration = normalized(largeScaleMigrationPath);
    expect(migration).toContain("active_projection_records_tree_page_idx");
    expect(migration).toContain(
      "on focowiki.active_projection_records ( knowledge_base_id, (coalesce(parent_path, '')), (coalesce(sort_key, '')), record_id )"
    );
    expect(migration).toContain("where projection_kind = 'tree'");
  });

  it("looks up generated files directly by active file ID or logical path", () => {
    const repository = normalized(repositoryPath);
    expect(repository).toContain("active.file_id = ${input.fileid}");
    expect(repository).toContain("active.logical_path = ${input.path}");
    expect(repository).toContain("from focowiki.active_object_refs active");
    expect(repository).toContain("join focowiki.immutable_objects object");
    expect(repository).not.toContain("bundle_files");
  });

  it("builds the immutable Developer OpenAPI document once during registration", () => {
    const routes = normalized(routesPath);
    const registration = routes.slice(
      routes.indexOf("export function registerdeveloperopenapiroutes"),
      routes.indexOf("app.get(\"/openapi/v2/knowledge-bases\"")
    );
    expect(registration).toContain("const openapidocument = createdeveloperopenapidocument()");
    expect(registration).toContain(
      "app.get(\"/openapi/v2/openapi.json\", (context) => context.json(openapidocument))"
    );
  });

  it("writes generation-local projection records and immutable object references", () => {
    const writer = normalized(projectionWriterPath);
    expect(writer).toContain("records.stageupsert");
    expect(writer).toContain("input.references.stageupsert");
    expect(writer).toContain("impact.projectionkind === \"tree\"");
    expect(writer).toContain("impact.projectionkind === \"search\"");
    expect(writer).not.toContain("releaseid");
    expect(writer).not.toContain("bundlefile");
  });
});
