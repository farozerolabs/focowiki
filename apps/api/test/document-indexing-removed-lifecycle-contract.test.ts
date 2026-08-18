import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");

describe("removed stage and publication lifecycle contract", () => {
  it("does not accept publication modes or a publication settings section", () => {
    const runtimeSettings = read(
      "apps/api/src/runtime-settings/types.ts",
      "apps/api/src/runtime-settings/revision-document.ts",
      "apps/api/src/runtime-settings/validation.ts"
    );

    expect(runtimeSettings.includes("RuntimePublicationSettings")).toBe(false);
    expect(runtimeSettings.includes('"publication"')).toBe(false);
    expect(runtimeSettings.includes(
      'return ["batch", "manual", "per_file"]'
    )).toBe(false);
  });

  it("does not expose pending-publication state or publication retry", () => {
    const lifecycle = read(
      "apps/api/src/domain/source-file-lifecycle.ts",
      "apps/api/src/domain/source-resource.ts",
      "apps/api/src/admin/source-resource-editing-routes.ts",
      "apps/api/src/developer-openapi/openapi-schemas.ts",
      "apps/api/src/developer-openapi/openapi-paths.ts",
      "apps/api/src/developer-openapi/source-resource-routes.ts",
      "apps/api/src/storage-vnext/api/admin-ports.ts",
      "apps/api/src/storage-vnext/api/postgres-operation-read.ts",
      "apps/admin/src/lib/resource-editing-api.ts",
      "apps/admin/src/lib/admin-api.ts"
    );

    expect(lifecycle.includes("pending_publication")).toBe(false);
    expect(lifecycle.includes('retryKind === "publication"')).toBe(false);
    expect(lifecycle.includes('"source_processing" | "publication"')).toBe(false);
    expect(lifecycle.includes('"publishing"')).toBe(false);
    expect(lifecycle.includes('"publication_owned"')).toBe(false);
    expect(lifecycle.includes('"search_publication"')).toBe(false);
    expect(lifecycle.includes('"source_processing", "publication", "none"')).toBe(false);
  });

  it("does not persist stage graphs or publication jobs", () => {
    const migration = read("apps/api/migrations/001_storage_vnext.sql")
      .toLowerCase();
    const removedStructures = [
      "processing_stage_work_items",
      "processing_stage_dependencies",
      "processing_stage_fairness",
      "release_candidates",
      "release_candidate_changed_facts",
      "release_candidate_dependencies",
      "release_candidate_validations",
      "release_roots",
      "release_shards"
    ];
    for (const value of removedStructures) {
      expect(migration, value).not.toContain(`create table focowiki.${value}`);
    }
    expect(migration).toContain("create table focowiki.document_processing_jobs");
    expect(migration).not.toContain("drop table if exists");
  });

  it("keeps publication-only states out of the checked-in OpenAPI contract", () => {
    const contract = read("docs/public/openapi/focowiki-openapi.json");

    expect(contract.includes('"publishing"')).toBe(false);
    expect(contract.includes('"search_publication"')).toBe(false);
    expect(contract.includes('"retryKind": "publication"')).toBe(false);
  });

  it("provides one worker command and removes role-specific worker commands", () => {
    const productionEntrypoints = read(
      "scripts/dev-runtime.ts",
      "apps/api/scripts/build-runtime.mjs",
      "docker-compose.yml.example",
      "docker-compose.local.yml.example",
      "docker-compose.dev.yml.example"
    );

    expect(productionEntrypoints.includes("worker-main")).toBe(true);
    expect(productionEntrypoints.includes("source-worker")).toBe(false);
    expect(productionEntrypoints.includes("publication-worker")).toBe(false);
    expect(productionEntrypoints.includes("maintenance-worker")).toBe(false);
  });
});

function read(...paths: string[]): string {
  return paths.map((path) => readFileSync(resolve(workspaceRoot, path), "utf8"))
    .join("\n");
}
