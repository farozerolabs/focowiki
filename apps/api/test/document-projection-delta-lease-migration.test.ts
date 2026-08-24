import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  import.meta.dirname,
  "../migrations/011_projection_delta_lease_safety.sql"
), "utf8").replace(/\s+/gu, " ").toLowerCase();

describe("projection delta and lease safety migration", () => {
  it("persists compatible planning, closure, progress and supersession state", () => {
    for (const fragment of [
      "planning_mode text",
      "affected_closure_fingerprint_sha256 text",
      "projection_generation_affected_members",
      "projection_generation_statistics",
      "consecutive_lease_loss_count integer",
      "last_progress_at timestamp with time zone",
      "progress_evidence jsonb",
      "supersession_reason text",
      "superseded_by_generation_public_id text"
    ]) expect(migration).toContain(fragment);
  });

  it("advances the runtime generation without destructive reset", () => {
    expect(migration).toContain(
      "set generation = 'storage-vnext-v19-projection-delta-lease-safety'"
    );
    expect(migration).not.toMatch(/drop table|truncate/u);
  });

  it("indexes bounded closure, recovery, supersession and lease-loss lookups",
    () => {
      for (const index of [
        "projection_generation_affected_members_source_idx",
        "projection_generation_statistics_knowledge_base_idx",
        "projection_publication_generations_contract_recovery_idx",
        "projection_publication_generations_supersession_idx",
        "projection_scope_generations_lease_loss_idx"
      ]) expect(migration).toContain(`create index ${index}`);
      expect(migration).toContain(
        "where state in ('planned', 'rendering', 'validating', 'ready')"
      );
      expect(migration).toContain("where state in ('waiting', 'running')");
    });
});
