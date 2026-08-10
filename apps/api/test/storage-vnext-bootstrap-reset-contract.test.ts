import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const migrationDirectory = resolve(workspaceRoot, "apps/api/migrations");
const bootstrapFileName = "001_storage_vnext.sql";
const extensionProfileMigration = "002_extension_navigation_profile.sql";
const semanticSearchMigration = "003_general_purpose_semantic_search.sql";
const bootstrapPath = resolve(migrationDirectory, bootstrapFileName);

function migrationFiles(): string[] {
  return readdirSync(migrationDirectory)
    .filter((fileName) => /^\d{3}_.+\.sql$/u.test(fileName))
    .sort();
}

function readCandidateBootstrap(): string {
  if (existsSync(bootstrapPath)) return readFileSync(bootstrapPath, "utf8");
  return migrationFiles()
    .map((fileName) => readFileSync(resolve(migrationDirectory, fileName), "utf8"))
    .join("\n");
}

function normalizedCandidateBootstrap(): string {
  return readCandidateBootstrap().replace(/\s+/gu, " ").toLowerCase();
}

function findIdentifiers(source: string, identifiers: readonly string[]): string[] {
  return identifiers.filter((identifier) =>
    new RegExp(`\\b${identifier}\\b`, "u").test(source)
  );
}

describe("storage vNext clean bootstrap and reset contract", () => {
  it("keeps the absent bootstrap and declares the reset-only semantic baseline", () => {
    const manifest = readFileSync(
      resolve(workspaceRoot, "apps/api/src/db/migration-manifest.ts"),
      "utf8"
    );

    expect(migrationFiles()).toEqual([
      bootstrapFileName,
      extensionProfileMigration,
      semanticSearchMigration
    ]);
    expect(manifest).toContain(`fileName: "${bootstrapFileName}"`);
    expect(manifest).toContain('sourceGeneration: "absent"');
    expect(manifest).toContain('targetGeneration: "storage-vnext-v1"');
    expect(manifest).toContain(`fileName: "${extensionProfileMigration}"`);
    expect(manifest).toContain('targetGeneration: "storage-vnext-v2"');
    expect(manifest).toContain(`fileName: "${semanticSearchMigration}"`);
    expect(manifest).toContain('targetGeneration: "storage-vnext-v3-semantic"');
    expect(manifest).toContain('safety: "breaking_reset"');
    expect(manifest).not.toMatch(
      /incremental-sharded-publication|compatible_with_persisted_work|createMigrationPlan\(currentGeneration/u
    );
  });

  it("omits replaced legacy tables from the clean schema", () => {
    const found = findIdentifiers(normalizedCandidateBootstrap(), [
      "active_generated_directory_stats",
      "active_object_refs",
      "active_projection_partition_stats",
      "active_projection_records",
      "active_projection_segments",
      "directory_navigation_leaves",
      "dispatch_pressure_state",
      "knowledge_base_incremental_stat_shards",
      "knowledge_base_optimization_migrations",
      "knowledge_base_projection_versions",
      "projection_segments",
      "projection_shards",
      "role_heartbeats",
      "storage_object_protection_index"
    ]);

    expect(found).toEqual([]);
  });

  it("omits legacy columns that duplicate release, search, path, and compatibility facts", () => {
    const found = findIdentifiers(normalizedCandidateBootstrap(), [
      "active_generation_id",
      "candidate_generation_id",
      "generation_kind",
      "last_changed_generation_id",
      "predecessor_generation_id",
      "prior_active_generation_id",
      "optimized_active_generation_id",
      "normalized_text",
      "token_text",
      "lexical_vector",
      "entries_json",
      "record_json"
    ]);

    expect(found).toEqual([]);
  });

  it("omits legacy indexes and constraints instead of recreating old read shapes", () => {
    const sql = normalizedCandidateBootstrap();
    const prefixes = [
      "active_projection_records_",
      "generation_projection_records_",
      "publication_generations_",
      "search_projection_documents_",
      "search_projection_segments_",
      "source_file_graph_term_documents_"
    ] as const;
    const found = prefixes.filter((prefix) =>
      new RegExp(`(?:constraint|index)\\s+${prefix}[a-z0-9_]+`, "u").test(sql)
    );

    expect(found).toEqual([]);
  });

  it("omits PostgreSQL search relations and complete Generation copies", () => {
    const found = findIdentifiers(normalizedCandidateBootstrap(), [
      "search_projection_documents",
      "search_projection_segments",
      "source_file_graph_term_documents",
      "source_file_graph_term_frequencies",
      "generation_search_projection_refs",
      "publication_generations",
      "generation_object_refs",
      "generation_projection_records",
      "generation_projection_segments",
      "generation_tree_directory_stats"
    ]);

    expect(found).toEqual([]);
  });

  it("omits in-place compatibility and legacy Generation state", () => {
    const sql = normalizedCandidateBootstrap();

    const compatibilityTokens = [
      "postgres_compatibility",
      "legacy_readable",
      "legacy_retained",
      "optimized_active",
      "_segments/legacy"
    ];
    const compatibilityDdl = [
      "alter table",
      "add column if not exists",
      "drop column if exists",
      "update focowiki.runtime_generation"
    ];

    expect(compatibilityTokens.filter((token) => sql.includes(token))).toEqual([]);
    expect(compatibilityDdl.filter((token) => sql.includes(token))).toEqual([]);
  });

  it("removes commands and migration tests tied only to retired storage", () => {
    const packageSource = readFileSync(resolve(workspaceRoot, "package.json"), "utf8");
    const retiredCommands = [
      "validate:incremental-scale",
      "validate:tree-storage-scale",
      "validate:storage-reconciliation-scale"
    ];

    expect(retiredCommands.filter((command) => packageSource.includes(command))).toEqual([]);
    expect(existsSync(resolve(
      workspaceRoot,
      "apps/api/test/durable-search-planning-migration.integration.test.ts"
    ))).toBe(false);

    const retiredMigrationDrainFiles = [
      "apps/api/src/db/migration-preflight.ts",
      "apps/api/test/migration-preflight.test.ts",
      "apps/api/test/migration-preflight.integration.test.ts",
      "apps/api/test/migration-preflight-scale.integration.test.ts",
      "apps/api/src/infrastructure/postgres/immutable-object-repository.ts",
      "apps/api/test/immutable-object-repository.integration.test.ts",
      "apps/api/test/graph-term-frequency-concurrency.integration.test.ts"
    ];
    expect(retiredMigrationDrainFiles.filter((path) =>
      existsSync(resolve(workspaceRoot, path))
    )).toEqual([]);
  });

  it("removes the unreachable legacy publication validation runtime", () => {
    const retiredPublicationFiles = [
      "apps/api/src/application/ports/publication-activation-state-repository.ts",
      "apps/api/src/application/ports/publication-generation-repository.ts",
      "apps/api/src/application/ports/publication-subtask-repository.ts",
      "apps/api/src/application/ports/publication-validation-repository.ts",
      "apps/api/src/infrastructure/postgres/publication-validation-repository.ts",
      "apps/api/src/worker/continuous-slot-scheduler.ts",
      "apps/api/src/worker/publication-impact-executor.ts",
      "apps/api/src/worker/publication-role-processor.ts",
      "apps/api/src/worker/publication-terminal-phase-handler.ts",
      "apps/api/test/continuous-slot-scheduler.test.ts",
      "apps/api/test/publication-role-processor.test.ts",
      "apps/api/test/publication-terminal-phase-handler.test.ts",
      "apps/api/test/publication-validation-repository.integration.test.ts"
    ];

    expect(retiredPublicationFiles.filter((path) =>
      existsSync(resolve(workspaceRoot, path))
    )).toEqual([]);
  });

  it("rejects settings tied only to old Generation retention and migration backfill", () => {
    const settingsPaths = [
      "apps/api/src/config.ts",
      "apps/api/src/runtime-settings/types.ts",
      "apps/api/src/runtime-settings/validation.ts",
      "apps/admin/src/lib/admin-api.ts",
      "apps/admin/src/components/settings-panel.tsx"
    ];
    const forbiddenSettings = [
      "generationRetentionDays",
      "migrationBackfillConcurrency"
    ];
    const found = settingsPaths.flatMap((path) => {
      const source = readFileSync(resolve(workspaceRoot, path), "utf8");
      return forbiddenSettings
        .filter((field) => source.includes(field))
        .map((field) => `${path}:${field}`);
    });

    expect(found).toEqual([]);
  });
});
