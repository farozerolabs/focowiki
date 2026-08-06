import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as mutationRepository from
  "../src/storage-vnext/mutation/postgres-repository.js";

const migration = readFileSync(resolve(
  import.meta.dirname,
  "../migrations/001_storage_vnext.sql"
), "utf8");

describe("storage vNext mutation persistence contract", () => {
  it("stores one expiring destination reservation owned by a mutation operation", () => {
    expect(migration).toMatch(
      /CREATE TABLE focowiki\.mutation_path_reservations[\s\S]*PRIMARY KEY \(knowledge_base_id, normalized_path\)/u
    );
    expect(migration).toMatch(
      /mutation_path_reservations_operation_fkey[\s\S]*REFERENCES focowiki\.operations/u
    );
    expect(migration).toMatch(
      /mutation_path_reservations_expiry_check[\s\S]*expires_at > created_at/u
    );
  });

  it("exposes an atomic PostgreSQL mutation repository", () => {
    expect(mutationRepository.createPostgresStorageVnextMutationRepository)
      .toBeTypeOf("function");
  });

  it("does not add a content, graph, file, or directory search index table", () => {
    for (const forbidden of [
      "content_search_indexes",
      "graph_search_indexes",
      "source_file_search_indexes",
      "source_directory_search_indexes"
    ]) expect(migration).not.toContain(forbidden);
    expect(migration.match(/CREATE TABLE focowiki\.search_projections/gu))
      .toHaveLength(1);
  });
});
