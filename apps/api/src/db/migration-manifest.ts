export const MIGRATION_SAFETY_CLASSES = [
  "compatible_with_persisted_work",
  "requires_drain"
] as const;

export type MigrationSafety = (typeof MIGRATION_SAFETY_CLASSES)[number];

export type MigrationDescriptor = {
  readonly fileName: string;
  readonly sourceGeneration: string | "absent";
  readonly targetGeneration: string;
  readonly safety: MigrationSafety;
};

export const MIGRATION_MANIFEST = [
  {
    fileName: "001_production_admin_web.sql",
    sourceGeneration: "absent",
    targetGeneration: "incremental-sharded-publication-v1",
    safety: "requires_drain"
  },
  {
    fileName: "002_tree_graph_storage_reconciliation.sql",
    sourceGeneration: "incremental-sharded-publication-v1",
    targetGeneration: "tree-graph-storage-reconciliation-v2",
    safety: "requires_drain"
  },
  {
    fileName: "003_bounded_publication_recovery.sql",
    sourceGeneration: "tree-graph-storage-reconciliation-v2",
    targetGeneration: "bounded-publication-recovery-v3",
    safety: "requires_drain"
  },
  {
    fileName: "004_immutable_object_contention_recovery.sql",
    sourceGeneration: "bounded-publication-recovery-v3",
    targetGeneration: "immutable-object-contention-recovery-v4",
    safety: "requires_drain"
  },
  {
    fileName: "005_publication_retry_budget_recovery.sql",
    sourceGeneration: "immutable-object-contention-recovery-v4",
    targetGeneration: "publication-retry-budget-recovery-v5",
    safety: "requires_drain"
  },
  {
    fileName: "006_publication_continuation_recovery.sql",
    sourceGeneration: "publication-retry-budget-recovery-v5",
    targetGeneration: "publication-continuation-recovery-v6",
    safety: "requires_drain"
  },
  {
    fileName: "007_publication_write_livelock_recovery.sql",
    sourceGeneration: "publication-continuation-recovery-v6",
    targetGeneration: "publication-write-livelock-recovery-v7",
    safety: "requires_drain"
  },
  {
    fileName: "008_large_scale_ingestion_runtime.sql",
    sourceGeneration: "publication-write-livelock-recovery-v7",
    targetGeneration: "large-scale-ingestion-runtime-v8",
    safety: "requires_drain"
  },
  {
    fileName: "009_optimization_migration_rebase_recovery.sql",
    sourceGeneration: "large-scale-ingestion-runtime-v8",
    targetGeneration: "optimization-migration-rebase-recovery-v9",
    safety: "requires_drain"
  },
  {
    fileName: "010_generation_consistent_read_repair.sql",
    sourceGeneration: "optimization-migration-rebase-recovery-v9",
    targetGeneration: "generation-consistent-read-repair-v10",
    safety: "requires_drain"
  },
  {
    fileName: "011_body_search_projection.sql",
    sourceGeneration: "generation-consistent-read-repair-v10",
    targetGeneration: "body-search-projection-v11",
    safety: "requires_drain"
  },
  {
    fileName: "012_storage_reconciliation_lease_recovery.sql",
    sourceGeneration: "body-search-projection-v11",
    targetGeneration: "storage-reconciliation-lease-recovery-v12",
    safety: "requires_drain"
  },
  {
    fileName: "013_projection_repair_throughput.sql",
    sourceGeneration: "storage-reconciliation-lease-recovery-v12",
    targetGeneration: "projection-repair-throughput-v13",
    safety: "requires_drain"
  },
  {
    fileName: "014_directory_order_repair.sql",
    sourceGeneration: "projection-repair-throughput-v13",
    targetGeneration: "directory-order-repair-v14",
    safety: "compatible_with_persisted_work"
  },
  {
    fileName: "015_lexical_rebuild_worker.sql",
    sourceGeneration: "directory-order-repair-v14",
    targetGeneration: "lexical-rebuild-worker-v15",
    safety: "compatible_with_persisted_work"
  },
  {
    fileName: "016_knowledge_base_index_maintenance.sql",
    sourceGeneration: "lexical-rebuild-worker-v15",
    targetGeneration: "knowledge-base-index-maintenance-v16",
    safety: "compatible_with_persisted_work"
  },
  {
    fileName: "017_indexed_storage_object_protection.sql",
    sourceGeneration: "knowledge-base-index-maintenance-v16",
    targetGeneration: "indexed-storage-object-protection-v17",
    safety: "compatible_with_persisted_work"
  },
  {
    fileName: "018_meilisearch_search_projection.sql",
    sourceGeneration: "indexed-storage-object-protection-v17",
    targetGeneration: "meilisearch-search-projection-v18",
    safety: "compatible_with_persisted_work"
  }
] as const satisfies readonly MigrationDescriptor[];

export type MigrationFile = (typeof MIGRATION_MANIFEST)[number]["fileName"];

export type MigrationPlan = {
  readonly pendingMigrations: readonly MigrationDescriptor[];
  readonly pendingFiles: MigrationFile[];
  readonly requiresDrain: boolean;
  readonly targetGeneration: string;
};

export type MigrationManifestValidationOptions = {
  readonly availableFiles?: readonly string[];
  readonly expectedRuntimeGeneration?: string;
  readonly fileExists?: (fileName: MigrationFile) => boolean;
};

export class MigrationManifestValidationError extends Error {
  public constructor(message: string) {
    super(`Invalid migration manifest: ${message}`);
    this.name = "MigrationManifestValidationError";
  }
}

export class UnsupportedMigrationGenerationError extends Error {
  public constructor(public readonly generation: string) {
    super(`Unsupported database schema generation: ${generation}`);
    this.name = "UnsupportedMigrationGenerationError";
  }
}

export function validateMigrationManifest(
  manifest: readonly MigrationDescriptor[],
  options: MigrationManifestValidationOptions = {}
): void {
  if (manifest.length === 0) {
    throw new MigrationManifestValidationError("at least one migration is required");
  }

  const files = new Set<string>();
  const targetGenerations = new Set<string>();

  for (const [index, migration] of manifest.entries()) {
    const expectedOrdinal = index + 1;
    const ordinal = Number.parseInt(migration.fileName.slice(0, 3), 10);
    if (
      !/^\d{3}_.+\.sql$/u.test(migration.fileName)
      || ordinal !== expectedOrdinal
    ) {
      throw new MigrationManifestValidationError(
        `migration ${migration.fileName} breaks continuous file order`
      );
    }
    if (files.has(migration.fileName)) {
      throw new MigrationManifestValidationError(
        `duplicate migration file ${migration.fileName}`
      );
    }
    files.add(migration.fileName);

    if (targetGenerations.has(migration.targetGeneration)) {
      throw new MigrationManifestValidationError(
        `duplicate target generation ${migration.targetGeneration}`
      );
    }
    targetGenerations.add(migration.targetGeneration);

    const expectedSource = index === 0
      ? "absent"
      : manifest[index - 1]!.targetGeneration;
    if (migration.sourceGeneration !== expectedSource) {
      throw new MigrationManifestValidationError(
        `migration ${migration.fileName} does not continue ${expectedSource}`
      );
    }
    if (!MIGRATION_SAFETY_CLASSES.includes(migration.safety as MigrationSafety)) {
      throw new MigrationManifestValidationError(
        `migration ${migration.fileName} has an unsupported safety class`
      );
    }
  }

  if (options.availableFiles) {
    const availableFiles = [...options.availableFiles].sort();
    const manifestFiles = manifest.map((migration) => migration.fileName).sort();
    if (
      availableFiles.length !== manifestFiles.length
      || availableFiles.some((fileName, index) => fileName !== manifestFiles[index])
    ) {
      throw new MigrationManifestValidationError(
        "migration files and manifest entries do not match"
      );
    }
  }

  if (options.fileExists) {
    for (const migration of manifest) {
      if (!options.fileExists(migration.fileName as MigrationFile)) {
        throw new MigrationManifestValidationError(
          `migration file ${migration.fileName} is missing`
        );
      }
    }
  }

  const runtimeGeneration = manifest.at(-1)!.targetGeneration;
  if (
    options.expectedRuntimeGeneration
    && runtimeGeneration !== options.expectedRuntimeGeneration
  ) {
    throw new MigrationManifestValidationError(
      `runtime generation ${options.expectedRuntimeGeneration} does not match ${runtimeGeneration}`
    );
  }
}

export function createMigrationPlan(
  currentGeneration: string | "absent"
): MigrationPlan {
  const startIndex = currentGeneration === "absent"
    ? 0
    : MIGRATION_MANIFEST.findIndex(
        (migration) => migration.targetGeneration === currentGeneration
      ) + 1;
  if (startIndex === 0 && currentGeneration !== "absent") {
    throw new UnsupportedMigrationGenerationError(currentGeneration);
  }

  const pendingMigrations = MIGRATION_MANIFEST.slice(startIndex);
  return {
    pendingMigrations,
    pendingFiles: pendingMigrations.map((migration) => migration.fileName),
    requiresDrain: pendingMigrations.some(
      (migration) => migration.safety === "requires_drain"
    ),
    targetGeneration: MIGRATION_MANIFEST.at(-1)!.targetGeneration
  };
}

validateMigrationManifest(MIGRATION_MANIFEST);
