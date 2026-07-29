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
      "apps/api/src/application/ports/search-engine-transport.ts",
      "apps/api/src/search/content-segment-mapper.ts",
      "apps/api/src/search/indexing-batch.ts",
      "apps/api/src/search/search-epoch-activation.ts",
      "apps/api/src/search/search-retrieval.ts",
      "apps/api/src/search/search-hydration.ts",
      "apps/api/src/search/graph-expansion.ts",
      "apps/api/src/search/rank-fusion.ts",
      "apps/api/src/developer-openapi/search-pagination.ts",
      "apps/api/src/redis/search-page-cache.ts",
      "apps/api/src/developer-openapi/search-presentation.ts"
    ]) {
      expect(existsSync(resolve(workspaceRoot, path)), path).toBe(true);
    }
  });

  it("keeps Developer OpenAPI independent from search infrastructure", () => {
    const searchErrors = read(
      "apps/api/src/developer-openapi/search-errors.ts"
    );

    expect(searchErrors).not.toMatch(/\/infrastructure\//u);
    expect(searchErrors).toContain(
      'from "../application/ports/search-engine-transport.js"'
    );
  });
});
