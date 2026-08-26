import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  import.meta.dirname,
  "../migrations/016_single_job_publication_scale_safety.sql"
), "utf8").replace(/\s+/gu, " ").toLowerCase();

describe("single-job publication scale-safety migration", () => {
  it("normalizes navigation manifests without copying page bodies", () => {
    for (const table of [
      "publication_job_navigation_mutations",
      "publication_job_navigation_leaves",
      "publication_job_navigation_entries",
      "publication_job_navigation_removals"
    ]) expect(migration).toContain(`create table focowiki.${table}`);
    expect(migration).toContain("on delete cascade");
    expect(migration).not.toContain("insert into focowiki.generated_page_heads");
  });

  it("advances the generation without rebuilding active content", () => {
    expect(migration).toContain(
      "storage-vnext-v24-single-job-publication-scale-safety"
    );
    expect(migration).not.toContain("truncate");
    expect(migration).not.toContain("drop table");
    expect(migration).toContain("where outcome = 'pending'");
    expect(migration).toContain("attempt_token = null");
  });

  it("requeues only navigation-manifest failures at the publication boundary", () => {
    expect(migration).toContain(
      "safe_error_code = 'publication_navigation_mutations_invalid'"
    );
    expect(migration).toContain("set state = 'waiting_on_projection'");
    expect(migration).toContain("set outcome = 'pending'");
    expect(migration).toContain(
      "delete from focowiki.publication_job_items membership"
    );
    expect(migration).toContain("pending_item_count = coalesce(pending.item_count, 0)");
    expect(migration).not.toContain("generation_model");
    expect(migration).not.toContain("semantic_generation");
    expect(migration).not.toContain("embedding");
  });
});
