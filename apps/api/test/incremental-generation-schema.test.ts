import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/001_production_admin_web.sql", import.meta.url),
  "utf8"
).toLowerCase();

describe("incremental generation database baseline", () => {
  it.each([
    "publication_generations",
    "publication_change_facts",
    "publication_impacts",
    "publication_impact_causes",
    "projection_shards",
    "generation_object_refs",
    "immutable_objects",
    "directory_navigation_leaves",
    "source_dispatch_markers",
    "role_jobs",
    "role_heartbeats",
    "publication_progress"
  ])("defines %s", (table) => {
    expect(migration).toContain(`create table focowiki.${table}`);
  });

  it("enforces one active, one running, and one successor generation", () => {
    expect(migration).toContain("publication_generations_one_active_idx");
    expect(migration).toContain("publication_generations_one_frozen_idx");
    expect(migration).toContain("publication_generations_one_open_successor_idx");
  });

  it("indexes bounded dispatch and role claim paths", () => {
    expect(migration).toContain("source_dispatch_markers_claim_idx");
    expect(migration).toContain("role_jobs_claim_idx");
    expect(migration).toContain("publication_impacts_claim_idx");
    expect(migration).toContain("generation_object_refs_path_idx");
  });

  it("coalesces projection work per generation while retaining every cause", () => {
    expect(migration).toContain(
      "unique (generation_id, projection_kind, projection_key, record_identity)"
    );
    expect(migration).toContain("publication_impact_causes_fact_idx");
  });
});
