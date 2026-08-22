import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  import.meta.dirname,
  "../migrations/006_projection_publication_foundation.sql"
), "utf8").replace(/\s+/gu, " ").toLowerCase();

describe("projection publication foundation migration", () => {
  it("adds compatible scope heartbeat and lease fencing state", () => {
    expect(migration).toContain(
      "add column lease_generation bigint default 0 not null"
    );
    expect(migration).toContain(
      "add column heartbeat_at timestamp with time zone"
    );
    expect(migration).toContain("projection_dirty_scopes_fenced_lease_idx");
    expect(migration).toContain("create table focowiki.projection_cleanup_outbox");
    expect(migration).toContain("projection_cleanup_outbox_holder_key");
  });

  it("adds coherent fact, generation, ownership, and validation state", () => {
    for (const table of [
      "projection_fact_epochs",
      "knowledge_base_projection_heads",
      "projection_publication_generations",
      "projection_generation_documents",
      "projection_activation_owner_reservations",
      "projection_artifact_owners",
      "projection_directory_owners",
      "projection_scope_generations",
      "projection_scope_generation_dependencies",
      "projection_scope_snapshot_members",
      "projection_scope_generation_pages",
      "projection_generation_directory_claims",
      "projection_scope_navigation_mutations",
      "projection_scope_generation_object_refs",
      "projection_generation_validation_results",
      "projection_invariant_diagnostics",
      "projection_cutover_states",
      "projection_shadow_parity_results",
      "projection_shadow_scope_accumulators",
      "projection_generation_retention"
    ]) {
      expect(migration).toContain(`create table focowiki.${table}`);
    }
    expect(migration).toContain(
      "projection_publication_generations_one_candidate_idx"
    );
    expect(migration).toContain("mutation_public_id text not null");
    expect(migration).toContain("document_job_public_id text");
    expect(migration).toContain(
      "primary key (generation_public_id, mutation_public_id)"
    );
    expect(migration).toContain("normalized_path collate \"c\"");
  });

  it("persists bounded resumable shadow progress", () => {
    for (const column of [
      "shadow_cursor",
      "shadow_expected_path_count",
      "shadow_processed_path_count",
      "shadow_target_fact_epoch",
      "shadow_started_at",
      "shadow_completed_at"
    ]) {
      expect(migration).toContain(column);
    }
  });

  it("advances the deployed clean indexing generation", () => {
    expect(migration).toContain(
      "set generation = 'storage-vnext-v14-projection-publication-coherence'"
    );
    expect(migration).toContain(
      "and generation = 'storage-vnext-v13-clean-document-indexing'"
    );
  });
});
