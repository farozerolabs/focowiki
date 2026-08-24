import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  import.meta.dirname,
  "../migrations/012_projection_runtime_recovery.sql"
), "utf8").replace(/\s+/gu, " ").toLowerCase();

describe("projection runtime recovery migration", () => {
  it("terminalizes corrupted cleanup attempts and enforces the boundary", () => {
    expect(migration).toContain("safe_error_code = 'cleanup_attempts_exhausted'");
    expect(migration).toContain("attempt_count = maximum_attempts");
    expect(migration).toContain("cleanup_actions_attempt_boundary_check");
    expect(migration).toContain(
      "projection_publication_generations_stranded_recovery_idx"
    );
  });

  it("advances the compatible runtime generation", () => {
    expect(migration).toContain(
      "set generation = 'storage-vnext-v20-projection-runtime-recovery'"
    );
    expect(migration).not.toMatch(/drop table|truncate/u);
  });
});
