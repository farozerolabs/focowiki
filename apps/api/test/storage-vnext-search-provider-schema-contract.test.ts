import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(import.meta.dirname, "../migrations/001_storage_vnext.sql"),
  "utf8"
)
  .replace(/\s+/gu, " ")
  .replace(/\(\s+/gu, "(")
  .replace(/\s+\)/gu, ")")
  .toLowerCase();

function tableDefinition(table: string): string {
  const match = migration.match(
    new RegExp(`create table focowiki\\.${table} \\(([^;]+)\\);`, "u")
  );
  expect(match, `missing ${table} table`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("storage vNext provider-aware search schema Red contract", () => {
  it("binds every search projection to one supported provider", () => {
    const projection = tableDefinition("search_projections");

    expect(projection).toContain("provider_kind text not null");
    expect(projection).toContain(
      "search_projections_provider_kind_check check (provider_kind in ('meilisearch', 'opensearch'))"
    );
  });

  it("stores opaque string operation references instead of Meilisearch task ids", () => {
    const projection = tableDefinition("search_projections");

    expect(projection).toContain("provider_operation_ref text");
    expect(projection).not.toContain("provider_task_uid");
    expect(projection).toContain(
      "search_projections_provider_operation_check check"
    );
  });

  it("allows the same physical index name to be owned by different providers", () => {
    const projection = tableDefinition("search_projections");

    expect(projection).toContain(
      "search_projections_provider_key unique (provider_kind, provider_index_uid)"
    );
    expect(projection).not.toContain(
      "search_projections_provider_key unique (provider_index_uid)"
    );
  });

  it("persists provider ownership for search cleanup and maintenance work", () => {
    const cleanup = tableDefinition("cleanup_actions");
    const workItems = tableDefinition("operation_work_items");

    expect(cleanup).toContain("search_provider_kind text");
    expect(cleanup).toContain("cleanup_actions_search_provider_check check");
    expect(workItems).toContain("search_provider_kind text");
    expect(workItems).toContain(
      "operation_work_items_search_provider_check check"
    );
  });

  it("removes Meilisearch-only compaction state from the common projection", () => {
    const projection = tableDefinition("search_projections");

    expect(projection).not.toContain("last_compacted_at");
    expect(projection).not.toContain("last_compaction_database_size_bytes");
    expect(projection).not.toContain("last_compaction_used_database_size_bytes");
    expect(projection).not.toContain("search_projections_compaction_check");
  });
});
