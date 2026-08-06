import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("storage vNext mutation graph candidate", () => {
  it("persists normalized candidate graph facts until activation or termination", () => {
    const migration = readFileSync(
      resolve(import.meta.dirname, "../migrations/001_storage_vnext.sql"),
      "utf8"
    );
    expect(migration).toContain("CREATE TABLE focowiki.release_candidate_graph_nodes");
    expect(migration).toContain("CREATE TABLE focowiki.release_candidate_graph_edges");
    expect(migration).toContain("CREATE TABLE focowiki.release_candidate_graph_evidence");
    expect(migration).toMatch(
      /release_candidate_graph_nodes[\s\S]*REFERENCES focowiki\.release_candidates[\s\S]*ON DELETE CASCADE/u
    );
  });

  it("routes mutation publication through candidate source and graph overlays", () => {
    const pipeline = readFileSync(
      resolve(import.meta.dirname, "../src/storage-vnext/publication/production-pipeline.ts"),
      "utf8"
    );
    expect(pipeline).toContain("readPostgresStorageVnextMutationCandidateOverlay");
    expect(pipeline).toContain("createStorageVnextMutationCandidateCatalog");
    expect(pipeline).toContain("createPostgresStorageVnextMutationCandidateGraph");
  });

  it("activates staged graph facts in the same mutation release transaction", () => {
    const hooks = readFileSync(
      resolve(import.meta.dirname, "../src/storage-vnext/mutation/postgres-release-hooks.ts"),
      "utf8"
    );
    expect(hooks).toContain("activateCandidateGraph");
    expect(hooks).toContain("release_candidate_graph_nodes");
    expect(hooks).toContain("release_candidate_graph_edges");
    expect(hooks).toContain("release_candidate_graph_evidence");
  });
});
