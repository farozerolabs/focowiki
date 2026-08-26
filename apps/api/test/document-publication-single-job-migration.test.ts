import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  import.meta.dirname,
  "../migrations/013_single_job_publication_foundation.sql"
), "utf8").replace(/\s+/gu, " ").toLowerCase();

describe("single-job publication foundation migration", () => {
  it("creates the five replacement persistence objects and drops legacy coordination", () => {
    for (const table of [
      "publication_items",
      "publication_jobs",
      "publication_job_items",
      "publication_job_outputs",
      "knowledge_base_publication_heads"
    ]) expect(migration).toContain(`create table focowiki.${table}`);
    expect(migration).toContain("drop table if exists");
    for (const legacyTable of [
      "projection_publication_generations",
      "projection_fact_epochs",
      "projection_scope_generations",
      "projection_scope_snapshot_members",
      "projection_scope_generation_pages",
      "projection_cleanup_outbox",
      "projection_cutover_states",
      "projection_generation_retention"
    ]) expect(migration).toContain(`focowiki.${legacyTable}`);
    expect(migration).not.toContain("truncate");
  });

  it("enforces bounded ownership, eligibility, expiry, and path indexes", () => {
    for (const index of [
      "publication_items_eligibility_idx",
      "publication_items_oldest_idx",
      "publication_items_pending_age_idx",
      "publication_jobs_one_nonterminal_idx",
      "publication_jobs_claim_idx",
      "publication_jobs_expiry_idx",
      "publication_jobs_retention_idx",
      "publication_job_items_order_idx",
      "publication_job_outputs_path_idx",
      "knowledge_base_publication_heads_pending_idx"
    ]) expect(migration).toContain(index);
    expect(migration).toContain("membership_order between 0 and 255");
    expect(migration).toContain("attempt_count between 0 and 3");
  });

  it("seeds narrow active revisions without generated bodies", () => {
    expect(migration).toContain(
      "select knowledge_base_id, head_version, active_fact_epoch, active_fact_epoch, updated_at"
    );
    expect(migration).not.toContain("generated_page_heads.object_id");
    expect(migration).not.toContain("source_revisions.object_id");
  });

  it("preserves immutable publication membership when processing jobs expire", () => {
    expect(migration).toContain(
      "references focowiki.document_processing_jobs(public_id) on delete set null"
    );
    expect(migration).not.toContain(
      "references focowiki.document_processing_jobs(public_id) on delete cascade"
    );
  });
});
