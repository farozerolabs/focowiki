import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  import.meta.dirname,
  "../migrations/010_projection_large_directory_deltas.sql"
), "utf8").replace(/\s+/gu, " ").toLowerCase();

describe("large-directory delta projection migration", () => {
  it("adds the generation overlay and directory-local lookup indexes", () => {
    expect(migration).toContain(
      "create table focowiki.projection_generation_graph_degrees"
    );
    for (const index of [
      "projection_generation_graph_degrees_directory_idx",
      "document_projection_records_revision_visibility_idx",
      "document_semantic_memberships_directory_revision_idx",
      "canonical_file_relations_first_revision_visible_idx",
      "canonical_file_relations_second_revision_visible_idx",
      "canonical_file_relations_first_file_history_idx",
      "canonical_file_relations_second_file_history_idx",
      "relation_directed_evidence_pair_visible_idx"
    ]) expect(migration).toContain(`create index ${index}`);
    expect(migration).toContain(
      "set generation = 'storage-vnext-v18-projection-large-directory-deltas'"
    );
    expect(migration).toContain(
      "and generation = 'storage-vnext-v17-projection-resource-recovery'"
    );
  });
});
