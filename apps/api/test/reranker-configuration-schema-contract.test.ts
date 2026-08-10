import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  import.meta.dirname,
  "../migrations/003_general_purpose_semantic_search.sql"
), "utf8");

describe("reranker configuration schema contract", () => {
  it("persists encrypted immutable model revisions and one active selection", () => {
    expect(migration).toContain("CREATE TABLE focowiki.reranker_configurations");
    expect(migration).toContain(
      "CREATE TABLE focowiki.reranker_configuration_revisions"
    );
    expect(migration).toContain("encrypted_api_key bytea");
    expect(migration).toContain("reranker_configurations_one_active_idx");
    expect(migration).toContain("validation_fingerprint_sha256 text");
  });

  it("does not persist request ranking or excerpt controls", () => {
    const section = migration.slice(
      migration.indexOf("CREATE TABLE focowiki.reranker_configurations"),
      migration.indexOf("CREATE TABLE focowiki.semantic_generations")
    );
    for (const forbidden of [
      "rerank_top_k",
      "rerank_score_threshold",
      "source_excerpt",
      "final_result_limit"
    ]) expect(section).not.toContain(forbidden);
  });
});
