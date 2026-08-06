export const MIGRATION_SAFETY_CLASSES = ["clean_bootstrap"] as const;

export type MigrationSafety = (typeof MIGRATION_SAFETY_CLASSES)[number];

export type MigrationDescriptor = {
  readonly fileName: string;
  readonly sourceGeneration: "absent";
  readonly targetGeneration: string;
  readonly safety: MigrationSafety;
};

export const MIGRATION_MANIFEST = [
  {
    fileName: "001_storage_vnext.sql",
    sourceGeneration: "absent",
    targetGeneration: "storage-vnext-v1",
    safety: "clean_bootstrap"
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
  if (manifest.length !== 1) {
    throw new MigrationManifestValidationError(
      "the destructive reset supports exactly one clean bootstrap"
    );
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

  if (!/^\d{3}_.+\.sql$/u.test(bootstrap.fileName)) {
    throw new MigrationManifestValidationError(
      `migration ${bootstrap.fileName} has an invalid file name`
    );
  }

  if (!MIGRATION_SAFETY_CLASSES.includes(bootstrap.safety)) {
    throw new MigrationManifestValidationError(
      `migration ${bootstrap.fileName} has an unsupported safety class`
    );
  }

  if (options.availableFiles) {
    const availableFiles = [...options.availableFiles].sort();
    if (
      availableFiles.length !== 1
      || availableFiles[0] !== bootstrap.fileName
    ) {
      throw new MigrationManifestValidationError(
        "migration files and manifest entries do not match"
      );
    }
  }

  if (options.fileExists && !options.fileExists(bootstrap.fileName)) {
    throw new MigrationManifestValidationError(
      `migration file ${bootstrap.fileName} is missing`
    );
  }

  if (
    options.expectedRuntimeGeneration
    && options.expectedRuntimeGeneration !== bootstrap.targetGeneration
  ) {
    throw new MigrationManifestValidationError(
      `runtime generation ${options.expectedRuntimeGeneration} does not match ${bootstrap.targetGeneration}`
    );
  }
}

export function createBootstrapPlan(
  currentState: string | "absent"
): MigrationPlan {
  const targetGeneration = MIGRATION_MANIFEST[0].targetGeneration;
  if (currentState === "absent") {
    return {
      pendingMigrations: MIGRATION_MANIFEST,
      pendingFiles: [MIGRATION_MANIFEST[0].fileName],
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

  throw new UnsupportedMigrationGenerationError(currentState);
}

validateMigrationManifest(MIGRATION_MANIFEST);
