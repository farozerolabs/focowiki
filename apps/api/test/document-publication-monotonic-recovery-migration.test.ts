import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  import.meta.dirname,
  "../migrations/017_single_job_publication_monotonic_recovery.sql"
), "utf8").replace(/\s+/gu, " ").toLowerCase();

describe("single-job publication monotonic recovery migration", () => {
  it("rebases stale failures without replaying provider stages", () => {
    expect(migration).toContain(
      "safe_error_code = 'publication_page_owner_revision_stale'"
    );
    expect(migration).toContain("base_sequence + row_number() over");
    expect(migration).toContain("set readiness_sequence = rebased.readiness_sequence");
    expect(migration).toContain("outcome = 'pending'");
    expect(migration).toContain("work.work_kind = 'knowledge_projection'");
    expect(migration).toContain("work.work_kind = 'activate'");
    expect(migration).not.toContain("generation_model");
    expect(migration).not.toContain("semantic_generation");
    expect(migration).not.toContain("embedding");
  });

  it("advances the schema generation after resetting stale leases", () => {
    expect(migration).toContain("where outcome = 'pending'");
    expect(migration).toContain("attempt_token = null");
    expect(migration).toContain(
      "storage-vnext-v25-single-job-publication-monotonic-recovery"
    );
  });
});
