import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  import.meta.dirname,
  "../migrations/001_storage_vnext.sql"
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
    const section = [
      "reranker_configurations",
      "reranker_configuration_revisions"
    ].map((tableName) => {
      const start = migration.indexOf(`CREATE TABLE focowiki.${tableName}`);
      return migration.slice(start, migration.indexOf("\n);", start) + 3);
    }).join("\n");
    for (const forbidden of [
      "rerank_top_k",
      "rerank_score_threshold",
      "source_excerpt",
      "final_result_limit"
    ]) expect(section).not.toContain(forbidden);
  });
});
