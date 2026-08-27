import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  import.meta.dirname,
  "../migrations/018_navigation_chain_reconciliation.sql"
), "utf8").replace(/\s+/gu, " ").toLowerCase();

describe("navigation chain reconciliation migration", () => {
  it("requeues only publication-boundary navigation failures", () => {
    expect(migration).toContain("'previous_state_invalid'");
    expect(migration).toContain("'publication_attempt_limit_exceeded'");
    expect(migration).toContain("work_kind in ('knowledge_projection', 'activate')");
    expect(migration).toContain("outcome = 'pending'");
    expect(migration).not.toContain("work_kind = 'model_graph_analysis'");
    expect(migration).not.toContain("work_kind = 'embedding'");
  });

  it("advances the runtime generation after recovery", () => {
    expect(migration).toContain(
      "storage-vnext-v26-navigation-chain-reconciliation"
    );
  });
});
