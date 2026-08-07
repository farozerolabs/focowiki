import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");

function read(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
}

describe("Meilisearch architecture contract", () => {
  it("uses official PostgreSQL and internal Meilisearch services", () => {
    for (const path of [
      "docker-compose.yml.example",
      "docker-compose.dev.yml.example",
      "docker-compose.local.yml.example"
    ]) {
      const compose = read(path);
      expect(compose).toContain("image: postgres:18-alpine");
      expect(compose).toContain("meilisearch:");
      expect(compose).toContain("getmeili/meilisearch:");
      expect(compose).toContain("./data/meilisearch:/meili_data");
      expect(compose).toContain("./data/meilisearch/tmp:/meili_data/tmp");
      expect(compose).not.toMatch(/FOCOWIKI_POSTGRES_IMAGE|docker\/postgres|focowiki-postgres/u);
    }
  });

  it("contains no unreleased PostgreSQL search extension artifacts", () => {
    expect(existsSync(resolve(workspaceRoot, "docker/postgres"))).toBe(false);
    expect(
      existsSync(
        resolve(workspaceRoot, "apps/api/migrations/018_ranked_search_retrieval.sql")
      )
    ).toBe(false);

    const searchablePaths = [
      ".env.example",
      ".github/workflows/ci.yml",
      ".github/workflows/docker-build.yml",
      "apps/api/src/db/migration-manifest.ts",
      "docker-compose.yml.example",
      "docker-compose.dev.yml.example",
      "docker-compose.local.yml.example"
    ];
    for (const path of searchablePaths) {
      expect(read(path), path).not.toMatch(
        /pg_textsearch|FOCOWIKI_POSTGRES_IMAGE|docker\/postgres|focowiki-postgres/u
      );
    }
  });

  it("separates stable search responsibilities", () => {
    for (const path of [
      "apps/api/src/application/ports/search-provider-runtime.ts",
      "apps/api/src/infrastructure/meilisearch/meilisearch-client-port.ts",
      "apps/api/src/storage-vnext/search/documents.ts",
      "apps/api/src/storage-vnext/search/markdown-segmentation.ts",
      "apps/api/src/storage-vnext/search/candidate-lifecycle.ts",
      "apps/api/src/storage-vnext/search/candidate-validation.ts",
      "apps/api/src/storage-vnext/search/active-search.ts",
      "apps/api/src/storage-vnext/search/postgres-hydration.ts",
      "apps/api/src/storage-vnext/search/graph-candidate-search.ts",
      "apps/api/src/storage-vnext/search/search-cleanup.ts"
    ]) {
      expect(existsSync(resolve(workspaceRoot, path)), path).toBe(true);
    }
  });

  it("keeps Developer OpenAPI independent from search infrastructure", () => {
    const searchRoutes = read(
      "apps/api/src/developer-openapi/file-search-routes.ts"
    );

    expect(searchRoutes).not.toMatch(/\/infrastructure\//u);
    expect(searchRoutes).not.toContain("SearchEngineTransport");
    expect(searchRoutes).toContain("services.api.searchFiles");
  });

  it("keeps Meilisearch-only validation explicit while using common search configuration", () => {
    for (const path of [
      "apps/api/src/storage-vnext/bootstrap/main.ts",
      "apps/api/scripts/capture-storage-vnext-before-state.ts",
      "scripts/validation/storage-vnext-restore-rebuild.ts",
      "scripts/validation/storage-vnext-full-restore-rebuild.ts",
      "scripts/validation/lib/storage-vnext-scale-scope.mjs"
    ]) {
      const source = read(path);
      expect(source, path).toContain("SEARCH_PROVIDER");
      expect(source, path).toContain("SEARCH_INDEX_PREFIX");
      expect(source, path).not.toContain("MEILI_INDEX_PREFIX");
    }
  });
});
