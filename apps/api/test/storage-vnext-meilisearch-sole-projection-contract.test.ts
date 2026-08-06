import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync
} from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const sourceRoot = resolve(workspaceRoot, "apps/api/src");

const POSTGRES_LEXICAL_MODULES = [
  "apps/api/src/application/body-search-projection.ts",
  "apps/api/src/infrastructure/postgres/active-generation-read-repository.ts",
  "apps/api/src/infrastructure/postgres/active-projection-search.ts",
  "apps/api/src/infrastructure/postgres/body-search-query.ts",
  "apps/api/src/infrastructure/postgres/graph-search-query.ts",
  "apps/api/src/infrastructure/postgres/search-projection-repository.ts",
  "apps/api/src/infrastructure/postgres/search-projection-state-repository.ts",
  "apps/api/src/application/ports/search-projection-state-repository.ts"
] as const;

const DUPLICATED_SEARCH_RELATIONS = [
  "generation_search_projection_refs",
  "search_projection_documents",
  "search_projection_segments",
  "source_file_graph_term_documents",
  "source_file_graph_term_frequencies"
] as const;

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("storage vNext Meilisearch sole-projection Red contract", () => {
  it("has no PostgreSQL body, graph-seed, or hybrid corpus fallback", () => {
    for (const path of POSTGRES_LEXICAL_MODULES) {
      expect(existsSync(resolve(workspaceRoot, path)), path).toBe(false);
    }
  });

  it("does not persist a second body or graph lexical document corpus", () => {
    const relationReaders = listTypeScriptFiles(sourceRoot).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return DUPLICATED_SEARCH_RELATIONS.flatMap((relation) =>
        source.includes(relation)
          ? [{ path: path.slice(workspaceRoot.length + 1), relation }]
          : []
      );
    });

    expect(relationReaders).toEqual([]);
  });

  it("keeps vNext PostgreSQL schema free of duplicated search documents", () => {
    const migrationPath = resolve(
      workspaceRoot,
      "apps/api/migrations/001_storage_vnext.sql"
    );
    expect(statSync(migrationPath).isFile()).toBe(true);
    const migration = readFileSync(migrationPath, "utf8");
    for (const relation of DUPLICATED_SEARCH_RELATIONS) {
      expect(migration, relation).not.toContain(relation);
    }
    expect(migration).toContain("CREATE TABLE focowiki.search_projections");
  });
});
