import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MIGRATION_MANIFEST,
  MigrationManifestValidationError,
  UnsupportedMigrationGenerationError,
  createMigrationPlan,
  validateMigrationManifest,
  type MigrationDescriptor
} from "../src/db/migration-manifest.js";
import {
  MIGRATION_FILES,
  RUNTIME_SCHEMA_GENERATION
} from "../src/db/migrations.js";

const EXPECTED_MIGRATIONS = [
  ["001_production_admin_web.sql", "absent", "incremental-sharded-publication-v1", "requires_drain"],
  [
    "002_tree_graph_storage_reconciliation.sql",
    "incremental-sharded-publication-v1",
    "tree-graph-storage-reconciliation-v2",
    "requires_drain"
  ],
  [
    "003_bounded_publication_recovery.sql",
    "tree-graph-storage-reconciliation-v2",
    "bounded-publication-recovery-v3",
    "requires_drain"
  ],
  [
    "004_immutable_object_contention_recovery.sql",
    "bounded-publication-recovery-v3",
    "immutable-object-contention-recovery-v4",
    "requires_drain"
  ],
  [
    "005_publication_retry_budget_recovery.sql",
    "immutable-object-contention-recovery-v4",
    "publication-retry-budget-recovery-v5",
    "requires_drain"
  ],
  [
    "006_publication_continuation_recovery.sql",
    "publication-retry-budget-recovery-v5",
    "publication-continuation-recovery-v6",
    "requires_drain"
  ],
  [
    "007_publication_write_livelock_recovery.sql",
    "publication-continuation-recovery-v6",
    "publication-write-livelock-recovery-v7",
    "requires_drain"
  ],
  [
    "008_large_scale_ingestion_runtime.sql",
    "publication-write-livelock-recovery-v7",
    "large-scale-ingestion-runtime-v8",
    "requires_drain"
  ],
  [
    "009_optimization_migration_rebase_recovery.sql",
    "large-scale-ingestion-runtime-v8",
    "optimization-migration-rebase-recovery-v9",
    "requires_drain"
  ],
  [
    "010_generation_consistent_read_repair.sql",
    "optimization-migration-rebase-recovery-v9",
    "generation-consistent-read-repair-v10",
    "requires_drain"
  ],
  [
    "011_body_search_projection.sql",
    "generation-consistent-read-repair-v10",
    "body-search-projection-v11",
    "requires_drain"
  ],
  [
    "012_storage_reconciliation_lease_recovery.sql",
    "body-search-projection-v11",
    "storage-reconciliation-lease-recovery-v12",
    "requires_drain"
  ],
  [
    "013_projection_repair_throughput.sql",
    "storage-reconciliation-lease-recovery-v12",
    "projection-repair-throughput-v13",
    "requires_drain"
  ],
  [
    "014_directory_order_repair.sql",
    "projection-repair-throughput-v13",
    "directory-order-repair-v14",
    "compatible_with_persisted_work"
  ],
  [
    "015_lexical_rebuild_worker.sql",
    "directory-order-repair-v14",
    "lexical-rebuild-worker-v15",
    "compatible_with_persisted_work"
  ],
  [
    "016_knowledge_base_index_maintenance.sql",
    "lexical-rebuild-worker-v15",
    "knowledge-base-index-maintenance-v16",
    "compatible_with_persisted_work"
  ]
] as const;

describe("migration manifest", () => {
  it("records the released migration chain and safety contract in one order", () => {
    expect(MIGRATION_MANIFEST.map((migration) => [
      migration.fileName,
      migration.sourceGeneration,
      migration.targetGeneration,
      migration.safety
    ])).toEqual(EXPECTED_MIGRATIONS);
    expect(MIGRATION_FILES).toEqual(EXPECTED_MIGRATIONS.map(([fileName]) => fileName));
    expect(RUNTIME_SCHEMA_GENERATION).toBe(
      EXPECTED_MIGRATIONS.at(-1)?.[2]
    );
  });

  it("covers every SQL migration file exactly once", () => {
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

  it("derives every supported historical plan from the manifest", () => {
    for (let index = 0; index < MIGRATION_MANIFEST.length; index += 1) {
      const currentGeneration = index === 0
        ? "absent"
        : MIGRATION_MANIFEST[index - 1]!.targetGeneration;
      const plan = createMigrationPlan(currentGeneration);

      expect(plan.pendingMigrations).toEqual(MIGRATION_MANIFEST.slice(index));
      expect(plan.pendingFiles).toEqual(
        MIGRATION_MANIFEST.slice(index).map((migration) => migration.fileName)
      );
      expect(plan.targetGeneration).toBe(RUNTIME_SCHEMA_GENERATION);
      expect(plan.requiresDrain).toBe(index < 13);
    }

    expect(createMigrationPlan(RUNTIME_SCHEMA_GENERATION)).toMatchObject({
      pendingMigrations: [],
      pendingFiles: [],
      requiresDrain: false,
      targetGeneration: RUNTIME_SCHEMA_GENERATION
    });
  });

  it("rejects unsupported generations without guessing a start index", () => {
    expect(() => createMigrationPlan("unknown-generation-v99")).toThrow(
      UnsupportedMigrationGenerationError
    );
  });

  it.each([
    {
      name: "duplicate files",
      mutate: () => [
        MIGRATION_MANIFEST[0]!,
        { ...MIGRATION_MANIFEST[1]!, fileName: MIGRATION_MANIFEST[0]!.fileName }
      ]
    },
    {
      name: "duplicate target generations",
      mutate: () => [
        MIGRATION_MANIFEST[0]!,
        {
          ...MIGRATION_MANIFEST[1]!,
          sourceGeneration: MIGRATION_MANIFEST[0]!.targetGeneration,
          targetGeneration: MIGRATION_MANIFEST[0]!.targetGeneration
        }
      ]
    },
    {
      name: "generation chain gaps",
      mutate: () => [
        MIGRATION_MANIFEST[0]!,
        {
          ...MIGRATION_MANIFEST[1]!,
          sourceGeneration: "unexpected-generation"
        }
      ]
    },
    {
      name: "file order gaps",
      mutate: () => [
        MIGRATION_MANIFEST[0]!,
        {
          ...MIGRATION_MANIFEST[1]!,
          fileName: "003_tree_graph_storage_reconciliation.sql"
        }
      ]
    },
    {
      name: "unsupported safety classes",
      mutate: () => [
        {
          ...MIGRATION_MANIFEST[0]!,
          safety: "best_effort"
        }
      ]
    }
  ])("rejects $name", ({ mutate }) => {
    expect(() => validateMigrationManifest(
      mutate() as unknown as readonly MigrationDescriptor[]
    )).toThrow(MigrationManifestValidationError);
  });

  it("rejects migration-file coverage and runtime-generation drift", () => {
    expect(() => validateMigrationManifest(MIGRATION_MANIFEST, {
      availableFiles: MIGRATION_FILES.slice(0, -1)
    })).toThrow(MigrationManifestValidationError);
    expect(() => validateMigrationManifest(MIGRATION_MANIFEST, {
      expectedRuntimeGeneration: "unexpected-runtime-generation"
    })).toThrow(MigrationManifestValidationError);
  });
});
