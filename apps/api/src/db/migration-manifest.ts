export const MIGRATION_SAFETY_CLASSES = [
  "clean_bootstrap",
  "compatible",
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
    if (migration.safety === "breaking_reset" && index !== manifest.length - 1) {
      throw new MigrationManifestValidationError(
        `migration ${migration.fileName} must terminate the generation chain`
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
    if (pendingMigrations.every((migration) => migration.safety === "compatible")) {
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
