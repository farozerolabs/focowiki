import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migration = await readFile(new URL(
  "../migrations/020_navigation_leaf_identity_recovery.sql",
  import.meta.url
), "utf8");

describe("navigation leaf identity recovery migration", () => {
  it("requeues only navigation chain failures for fresh publication", () => {
    expect(migration).toContain("safe_error_code = 'navigation_chain_invalid'");
    expect(migration).toContain("DELETE FROM focowiki.publication_job_items");
    expect(migration).toContain("SET outcome = 'pending'");
    expect(migration).toContain("SET state = 'processing'");
    expect(migration).toContain(
      "storage-vnext-v28-navigation-leaf-identity-recovery"
    );
  });
});
