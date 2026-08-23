import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  import.meta.dirname,
  "../migrations/009_projection_resource_recovery.sql"
), "utf8").toLocaleLowerCase("en-US");

describe("projection resource recovery migration", () => {
  it("adds durable retry scheduling for publication scopes", () => {
    expect(migration).toContain("next_eligible_at");
    expect(migration).toContain("resource_failure_started_at");
    expect(migration).toContain("resource_failure_count");
    expect(migration).toContain("storage-vnext-v17-projection-resource-recovery");
  });
});
