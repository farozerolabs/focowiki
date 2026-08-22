import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  import.meta.dirname,
  "../migrations/008_projection_navigation_capacity.sql"
), "utf8").toLocaleLowerCase("en-US");

describe("projection navigation capacity migration", () => {
  it("keeps the persisted mutation envelope above two maximum-sized leaves", () => {
    expect(migration).toContain(
      "drop constraint projection_scope_navigation_mutations_value_check"
    );
    expect(migration).toContain("octet_length(mutation::text) <= 21500000");
  });
});
