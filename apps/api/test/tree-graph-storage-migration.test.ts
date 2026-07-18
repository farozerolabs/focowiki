import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(import.meta.dirname, "../migrations/002_tree_graph_storage_reconciliation.sql"),
  "utf8"
).replace(/\s+/g, " ").toLowerCase();

describe("tree, graph, and storage reconciliation migration", () => {
  it("adds compatible projection and maintenance state", () => {
    for (const table of [
      "generation_tree_directory_stats",
      "generation_graph_summaries",
      "knowledge_base_projection_repairs",
      "storage_reconciliation_cycles",
      "storage_reconciliation_candidates"
    ]) {
      expect(migration).toContain(`create table focowiki.${table}`);
    }

    expect(migration).toContain("add column write_token text");
    expect(migration).toContain("lifecycle_state = 'writing'");
    expect(migration).toContain("'maintenance'");
  });

  it("preserves released knowledge-base and object data", () => {
    for (const destructiveStatement of [
      "drop table",
      "truncate ",
      "delete from focowiki.knowledge_bases",
      "delete from focowiki.source_files",
      "delete from focowiki.immutable_objects",
      "update focowiki.knowledge_bases set active_generation_id = null"
    ]) {
      expect(migration).not.toContain(destructiveStatement);
    }
  });

  it("installs bounded indexes for tree, repair, reservation, and reconciliation claims", () => {
    for (const index of [
      "generation_tree_directory_stats_parent_idx",
      "generation_tree_directory_stats_path_idx",
      "knowledge_base_projection_repairs_claim_idx",
      "immutable_objects_writing_recovery_idx",
      "storage_reconciliation_candidates_claim_idx",
      "storage_reconciliation_candidates_delete_order_idx"
    ]) {
      expect(migration).toContain(index);
    }
  });
});
