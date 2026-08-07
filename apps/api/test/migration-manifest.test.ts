import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MIGRATION_MANIFEST,
  MigrationManifestValidationError,
  UnsupportedMigrationGenerationError,
  createBootstrapPlan,
  validateMigrationManifest,
  type MigrationDescriptor
} from "../src/db/migration-manifest.js";
import {
  MIGRATION_FILES,
  RUNTIME_SCHEMA_GENERATION
} from "../src/db/migrations.js";

const EXPECTED_BOOTSTRAP = [
  ["001_storage_vnext.sql", "absent", "storage-vnext-v1", "clean_bootstrap"],
  [
    "002_extension_navigation_profile.sql",
    "storage-vnext-v1",
    "storage-vnext-v2",
    "compatible"
  ]
] as const;

describe("storage vNext bootstrap manifest", () => {
  it("declares one absent bootstrap followed by one compatible upgrade", () => {
    expect(MIGRATION_MANIFEST.map((migration) => [
      migration.fileName,
      migration.sourceGeneration,
      migration.targetGeneration,
      migration.safety
    ])).toEqual(EXPECTED_BOOTSTRAP);
    expect(MIGRATION_FILES).toEqual([
      "001_storage_vnext.sql",
      "002_extension_navigation_profile.sql"
    ]);
    expect(RUNTIME_SCHEMA_GENERATION).toBe("storage-vnext-v2");
  });

  it("covers the migration directory exactly once", () => {
    const migrationFiles = readdirSync(
      resolve(import.meta.dirname, "../migrations")
    )
      .filter((fileName) => /^\d{3}_.+\.sql$/u.test(fileName))
      .sort();

    expect([...MIGRATION_FILES]).toEqual(migrationFiles);
    expect(() => validateMigrationManifest(MIGRATION_MANIFEST, {
      availableFiles: migrationFiles,
      expectedRuntimeGeneration: RUNTIME_SCHEMA_GENERATION
    })).not.toThrow();
  });

  it("keeps the profile upgrade additive and indexes its paged catalog reads", () => {
    const migration = readFileSync(resolve(
      import.meta.dirname,
      "../migrations/002_extension_navigation_profile.sql"
    ), "utf8");

    expect(migration).toContain("navigation_profile_version");
    expect(migration).toContain("public_generated_directory_id");
    expect(migration).toContain("release_catalog_entries_root_path_c_idx");
    expect(migration).toContain("release_catalog_tombstones_root_path_c_idx");
    expect(migration).not.toMatch(/CREATE TABLE/iu);
  });

  it("initializes only an absent schema and becomes a no-op at the target", () => {
    expect(createBootstrapPlan("absent")).toEqual({
      pendingMigrations: MIGRATION_MANIFEST,
      pendingFiles: [...MIGRATION_FILES],
      targetGeneration: RUNTIME_SCHEMA_GENERATION
    });
    expect(createBootstrapPlan(RUNTIME_SCHEMA_GENERATION)).toEqual({
      pendingMigrations: [],
      pendingFiles: [],
      targetGeneration: RUNTIME_SCHEMA_GENERATION
    });
    expect(createBootstrapPlan("storage-vnext-v1")).toEqual({
      pendingMigrations: [MIGRATION_MANIFEST[1]],
      pendingFiles: ["002_extension_navigation_profile.sql"],
      targetGeneration: RUNTIME_SCHEMA_GENERATION
    });
  });

  it("rejects every historical or unknown schema generation", () => {
    for (const generation of [
      "incremental-sharded-publication-v1",
      "durable-search-projection-planning-v19",
      "unknown-generation-v99"
    ]) {
      expect(() => createBootstrapPlan(generation)).toThrow(
        UnsupportedMigrationGenerationError
      );
    }
  });

  it.each([
    {
      name: "duplicate bootstrap entries",
      manifest: [MIGRATION_MANIFEST[0]!, MIGRATION_MANIFEST[0]!]
    },
    {
      name: "a non-bootstrap file",
      manifest: [{
        ...MIGRATION_MANIFEST[0]!,
        fileName: "001_other.sql"
      }]
    },
    {
      name: "a non-absent source",
      manifest: [{
        ...MIGRATION_MANIFEST[0]!,
        sourceGeneration: "previous"
      }]
    },
    {
      name: "an unsupported safety class",
      manifest: [{
        ...MIGRATION_MANIFEST[0]!,
        safety: "requires_drain"
      }]
    }
  ])("rejects $name", ({ manifest }) => {
    expect(() => validateMigrationManifest(
      manifest as unknown as readonly MigrationDescriptor[]
    )).toThrow(MigrationManifestValidationError);
  });

  it("rejects file coverage and runtime-generation drift", () => {
    expect(() => validateMigrationManifest(MIGRATION_MANIFEST, {
      availableFiles: []
    })).toThrow(MigrationManifestValidationError);
    expect(() => validateMigrationManifest(MIGRATION_MANIFEST, {
      expectedRuntimeGeneration: "unexpected-runtime-generation"
    })).toThrow(MigrationManifestValidationError);
  });
});
