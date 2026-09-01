export const MIGRATION_SAFETY_CLASSES = [
  "clean_bootstrap",
  "compatible",
  "breaking_cutover",
  "breaking_reset"
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
    fileName: "001_storage_vnext.sql",
    sourceGeneration: "absent",
    targetGeneration: "storage-vnext-v9-document-indexing-hybrid",
    safety: "clean_bootstrap"
  },
  {
    fileName: "002_document_queue_throughput.sql",
    sourceGeneration: "storage-vnext-v9-document-indexing-hybrid",
    targetGeneration: "storage-vnext-v10-document-indexing-throughput",
    safety: "compatible"
  },
  {
    fileName: "003_document_projection_throughput.sql",
    sourceGeneration: "storage-vnext-v10-document-indexing-throughput",
    targetGeneration: "storage-vnext-v11-projection-throughput",
    safety: "compatible"
  },
  {
    fileName: "004_projection_output_object_lifecycle.sql",
    sourceGeneration: "storage-vnext-v11-projection-throughput",
    targetGeneration: "storage-vnext-v12-projection-object-lifecycle",
    safety: "compatible"
  },
  {
    fileName: "005_clean_document_indexing_boundary.sql",
    sourceGeneration: "storage-vnext-v12-projection-object-lifecycle",
    targetGeneration: "storage-vnext-v13-clean-document-indexing",
    safety: "breaking_reset"
  },
  {
    fileName: "006_projection_publication_foundation.sql",
    sourceGeneration: "storage-vnext-v13-clean-document-indexing",
    targetGeneration: "storage-vnext-v14-projection-publication-coherence",
    safety: "compatible"
  },
  {
    fileName: "007_projection_legacy_cleanup_gate.sql",
    sourceGeneration: "storage-vnext-v14-projection-publication-coherence",
    targetGeneration: "storage-vnext-v15-projection-legacy-cleanup-gate",
    safety: "compatible"
  },
  {
    fileName: "008_projection_navigation_capacity.sql",
    sourceGeneration: "storage-vnext-v15-projection-legacy-cleanup-gate",
    targetGeneration: "storage-vnext-v16-projection-navigation-capacity",
    safety: "compatible"
  },
  {
    fileName: "009_projection_resource_recovery.sql",
    sourceGeneration: "storage-vnext-v16-projection-navigation-capacity",
    targetGeneration: "storage-vnext-v17-projection-resource-recovery",
    safety: "compatible"
  },
  {
    fileName: "010_projection_large_directory_deltas.sql",
    sourceGeneration: "storage-vnext-v17-projection-resource-recovery",
    targetGeneration: "storage-vnext-v18-projection-large-directory-deltas",
    safety: "compatible"
  },
  {
    fileName: "011_projection_delta_lease_safety.sql",
    sourceGeneration: "storage-vnext-v18-projection-large-directory-deltas",
    targetGeneration: "storage-vnext-v19-projection-delta-lease-safety",
    safety: "compatible"
  },
  {
    fileName: "012_projection_runtime_recovery.sql",
    sourceGeneration: "storage-vnext-v19-projection-delta-lease-safety",
    targetGeneration: "storage-vnext-v20-projection-runtime-recovery",
    safety: "compatible"
  },
  {
    fileName: "013_single_job_publication_foundation.sql",
    sourceGeneration: "storage-vnext-v20-projection-runtime-recovery",
    targetGeneration: "storage-vnext-v21-single-job-publication-foundation",
    safety: "breaking_cutover"
  },
  {
    fileName: "014_single_job_publication_upgrade_baseline.sql",
    sourceGeneration: "storage-vnext-v21-single-job-publication-foundation",
    targetGeneration: "storage-vnext-v22-single-job-publication-upgrade-baseline",
    safety: "breaking_cutover"
  },
  {
    fileName: "015_single_job_publication_retry_recovery.sql",
    sourceGeneration: "storage-vnext-v22-single-job-publication-upgrade-baseline",
    targetGeneration: "storage-vnext-v23-single-job-publication-retry-recovery",
    safety: "breaking_cutover"
  },
  {
    fileName: "016_single_job_publication_scale_safety.sql",
    sourceGeneration: "storage-vnext-v23-single-job-publication-retry-recovery",
    targetGeneration: "storage-vnext-v24-single-job-publication-scale-safety",
    safety: "breaking_cutover"
  },
  {
    fileName: "017_single_job_publication_monotonic_recovery.sql",
    sourceGeneration: "storage-vnext-v24-single-job-publication-scale-safety",
    targetGeneration:
      "storage-vnext-v25-single-job-publication-monotonic-recovery",
    safety: "breaking_cutover"
  },
  {
    fileName: "018_navigation_chain_reconciliation.sql",
    sourceGeneration:
      "storage-vnext-v25-single-job-publication-monotonic-recovery",
    targetGeneration:
      "storage-vnext-v26-navigation-chain-reconciliation",
    safety: "breaking_cutover"
  },
  {
    fileName: "019_publication_window_cleanup_recovery.sql",
    sourceGeneration:
      "storage-vnext-v26-navigation-chain-reconciliation",
    targetGeneration:
      "storage-vnext-v27-publication-window-cleanup-recovery",
    safety: "breaking_cutover"
  },
  {
    fileName: "020_navigation_leaf_identity_recovery.sql",
    sourceGeneration:
      "storage-vnext-v27-publication-window-cleanup-recovery",
    targetGeneration:
      "storage-vnext-v28-navigation-leaf-identity-recovery",
    safety: "compatible"
  },
  {
    fileName: "021_source_metadata_persistence_repair.sql",
    sourceGeneration:
      "storage-vnext-v28-navigation-leaf-identity-recovery",
    targetGeneration:
      "storage-vnext-v29-source-metadata-persistence-repair",
    safety: "compatible"
  },
  {
    fileName: "022_provider_neutral_retrieval.sql",
    sourceGeneration:
      "storage-vnext-v29-source-metadata-persistence-repair",
    targetGeneration:
      "storage-vnext-v30-provider-neutral-retrieval",
    safety: "compatible"
  }
] as const satisfies readonly MigrationDescriptor[];

export type MigrationFile = (typeof MIGRATION_MANIFEST)[number]["fileName"];

export type MigrationPlan = {
  readonly pendingMigrations: readonly MigrationDescriptor[];
  readonly pendingFiles: MigrationFile[];
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
    throw new MigrationManifestValidationError("the manifest must not be empty");
  }
  const [bootstrap] = manifest;
  if (
    !bootstrap
    || bootstrap.fileName !== "001_storage_vnext.sql"
    || bootstrap.sourceGeneration !== "absent"
    || bootstrap.safety !== "clean_bootstrap"
  ) {
    throw new MigrationManifestValidationError(
      "the bootstrap must initialize storage vNext from an absent schema"
    );
  }
  const fileNames = new Set<string>();
  for (let index = 0; index < manifest.length; index += 1) {
    const migration = manifest[index]!;
    if (
      !/^\d{3}_.+\.sql$/u.test(migration.fileName)
      || Number(migration.fileName.slice(0, 3)) !== index + 1
      || fileNames.has(migration.fileName)
    ) {
      throw new MigrationManifestValidationError(
        `migration ${migration.fileName} has an invalid sequence or file name`
      );
    }
    fileNames.add(migration.fileName);
    if (!MIGRATION_SAFETY_CLASSES.includes(migration.safety)) {
      throw new MigrationManifestValidationError(
        `migration ${migration.fileName} has an unsupported safety class`
      );
    }
    if (
      index > 0
      && migration.sourceGeneration !== manifest[index - 1]!.targetGeneration
    ) {
      throw new MigrationManifestValidationError(
        `migration ${migration.fileName} does not continue the generation chain`
      );
    }
  }

  if (options.availableFiles) {
    const availableFiles = [...options.availableFiles].sort();
    if (
      availableFiles.length !== manifest.length
      || availableFiles.some((fileName, index) => fileName !== manifest[index]!.fileName)
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

  if (
    options.expectedRuntimeGeneration
    && options.expectedRuntimeGeneration !== manifest.at(-1)!.targetGeneration
  ) {
    throw new MigrationManifestValidationError(
      `runtime generation ${options.expectedRuntimeGeneration} does not match ${manifest.at(-1)!.targetGeneration}`
    );
  }
}

export function createBootstrapPlan(
  currentState: string | "absent"
): MigrationPlan {
  const targetGeneration = MIGRATION_MANIFEST.at(-1)!.targetGeneration;
  if (currentState === "absent") {
    return {
      pendingMigrations: MIGRATION_MANIFEST,
      pendingFiles: MIGRATION_MANIFEST.map((migration) => migration.fileName),
      targetGeneration
    };
  }

  if (currentState === targetGeneration) {
    return {
      pendingMigrations: [],
      pendingFiles: [],
      targetGeneration
    };
  }

  const sourceIndex = MIGRATION_MANIFEST.findIndex(
    (migration) => migration.sourceGeneration === currentState
  );
  if (sourceIndex >= 0) {
    const pendingMigrations = MIGRATION_MANIFEST.slice(sourceIndex);
    if (pendingMigrations.every((migration) =>
      migration.safety === "compatible"
      || migration.safety === "breaking_cutover"
    )) {
      return {
        pendingMigrations,
        pendingFiles: pendingMigrations.map((migration) => migration.fileName),
        targetGeneration
      };
    }
  }

  throw new UnsupportedMigrationGenerationError(currentState);
}

validateMigrationManifest(MIGRATION_MANIFEST);
