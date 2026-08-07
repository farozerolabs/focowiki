import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseClient } from "./client.js";
import {
  MIGRATION_MANIFEST,
  UnsupportedMigrationGenerationError,
  createBootstrapPlan,
  validateMigrationManifest,
  type MigrationFile
} from "./migration-manifest.js";

export const MIGRATION_FILES = MIGRATION_MANIFEST.map(
  (migration) => migration.fileName
) as readonly MigrationFile[];
export const RUNTIME_SCHEMA_GENERATION =
  MIGRATION_MANIFEST.at(-1)!.targetGeneration;

export class RuntimeSchemaGenerationError extends Error {
  public constructor(public readonly foundGeneration: string | null) {
    super("Database schema is incompatible with this Focowiki release. Perform a clean reset of the Focowiki PostgreSQL database before starting services.");
    this.name = "RuntimeSchemaGenerationError";
  }
}

export class RuntimeSchemaSignatureError extends Error {
  public constructor() {
    super("Database schema is incompatible with this Focowiki release. Perform a clean reset of the Focowiki PostgreSQL database before starting services.");
    this.name = "RuntimeSchemaSignatureError";
  }
}

export type MigrationPreflightResult = {
  currentGeneration: string | "absent";
  pendingFiles: MigrationFile[];
};

export function readMigrationSql(fileName: MigrationFile): string {
  for (const migrationUrl of [
    new URL(`./migrations/${fileName}`, import.meta.url),
    new URL(`../../migrations/${fileName}`, import.meta.url)
  ]) {
    const migrationPath = fileURLToPath(migrationUrl);

    if (existsSync(migrationPath)) {
      return readFileSync(migrationPath, "utf8");
    }
  }

  throw new Error(`Migration file not found: ${fileName}`);
}

export async function applyMigrations(sql: DatabaseClient): Promise<void> {
  const plan = await preflightMigrations(sql);

  for (const fileName of plan.pendingFiles) {
    await sql.begin(async (transaction) => {
      await transaction.unsafe(readMigrationSql(fileName));
    });
  }

  await assertRuntimeSchemaGeneration(sql);
}

export async function preflightMigrations(
  sql: DatabaseClient
): Promise<MigrationPreflightResult> {
  const state = await inspectRuntimeSchemaGeneration(sql);
  if (state !== "absent" && typeof state !== "string") {
    throw new RuntimeSchemaGenerationError(state);
  }
  if (state !== "absent") await assertProviderAwareSchemaSignature(sql);
  let plan;
  try {
    plan = createBootstrapPlan(state);
  } catch (error) {
    if (error instanceof UnsupportedMigrationGenerationError) {
      throw new RuntimeSchemaGenerationError(state);
    }
    throw error;
  }

  return {
    currentGeneration: state,
    pendingFiles: plan.pendingFiles
  };
}

export async function assertRuntimeSchemaGeneration(sql: DatabaseClient): Promise<void> {
  const state = await inspectRuntimeSchemaGeneration(sql);

  if (state !== RUNTIME_SCHEMA_GENERATION) {
    throw new RuntimeSchemaGenerationError(state === "absent" ? null : state);
  }
  await assertProviderAwareSchemaSignature(sql);
}

async function assertProviderAwareSchemaSignature(
  sql: DatabaseClient
): Promise<void> {
  const rows = await sql<Array<{ provider_schema_compatible: boolean }>>`
    SELECT (
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'focowiki'
          AND table_name = 'search_projections'
          AND column_name = 'provider_kind'
          AND data_type = 'text'
          AND is_nullable = 'NO'
      )
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'focowiki'
          AND table_name = 'search_projections'
          AND column_name = 'provider_operation_ref'
          AND data_type = 'text'
      )
      AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'focowiki'
          AND table_name = 'search_projections'
          AND column_name = 'provider_task_uid'
      )
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'focowiki'
          AND table_name = 'operation_work_items'
          AND column_name = 'search_provider_kind'
          AND data_type = 'text'
      )
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'focowiki'
          AND table_name = 'cleanup_actions'
          AND column_name = 'search_provider_kind'
          AND data_type = 'text'
      )
      AND EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'focowiki.search_projections'::regclass
          AND conname = 'search_projections_provider_key'
          AND regexp_replace(
            lower(pg_get_constraintdef(oid)), '\\s+', '', 'g'
          ) = 'unique(provider_kind,provider_index_uid)'
      )
    ) AS provider_schema_compatible
  `;
  if (rows[0]?.provider_schema_compatible !== true) {
    throw new RuntimeSchemaSignatureError();
  }
}

async function inspectRuntimeSchemaGeneration(
  sql: DatabaseClient
): Promise<string | "absent" | null> {
  const schemaRows = await sql<Array<{ schema_exists: boolean }>>`
    SELECT to_regnamespace('focowiki') IS NOT NULL AS schema_exists
  `;

  if (!schemaRows[0]?.schema_exists) {
    return "absent";
  }

  const markerRows = await sql<Array<{ marker_exists: boolean }>>`
    SELECT to_regclass('focowiki.runtime_generation') IS NOT NULL AS marker_exists
  `;

  if (!markerRows[0]?.marker_exists) {
    return null;
  }

  const generationRows = await sql<Array<{ generation: string }>>`
    SELECT generation
    FROM focowiki.runtime_generation
    WHERE singleton = true
    LIMIT 1
  `;

  return generationRows[0]?.generation ?? null;
}

validateMigrationManifest(MIGRATION_MANIFEST, {
  fileExists: (fileName) => [
    new URL(`./migrations/${fileName}`, import.meta.url),
    new URL(`../../migrations/${fileName}`, import.meta.url)
  ].some((migrationUrl) => existsSync(fileURLToPath(migrationUrl)))
});
