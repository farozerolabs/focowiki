import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  import.meta.dirname,
  "../migrations/019_durable_search_projection_planning.sql"
);

describe("durable search projection planning migration", () => {
  it("adds resumable planning without invalidating persisted work", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toContain("'plan_documents'");
    expect(migration).toContain(
      "generation_search_projection_refs_revision_idx"
    );
    expect(migration).toContain(
      "SET generation = 'durable-search-projection-planning-v19'"
    );
    expect(migration).not.toContain("DELETE FROM focowiki.search_projection_work");
    expect(migration).not.toContain("TRUNCATE");
  });
});
