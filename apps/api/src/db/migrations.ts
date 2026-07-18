import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseClient } from "./client.js";

export const MIGRATION_FILES = [
  "001_production_admin_web.sql",
  "002_tree_graph_storage_reconciliation.sql"
] as const;
export const RELEASED_SCHEMA_GENERATION = "incremental-sharded-publication-v1";
export const RUNTIME_SCHEMA_GENERATION = "tree-graph-storage-reconciliation-v2";

export class RuntimeSchemaGenerationError extends Error {
  public constructor(public readonly foundGeneration: string | null) {
    super(
      foundGeneration
        ? `Database schema generation ${foundGeneration} cannot be upgraded automatically to ${RUNTIME_SCHEMA_GENERATION}.`
        : "Database contains an unmarked or partially initialized Focowiki schema and cannot be upgraded automatically."
    );
    this.name = "RuntimeSchemaGenerationError";
  }
}

export function readMigrationSql(fileName: (typeof MIGRATION_FILES)[number]): string {
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
  const state = await inspectRuntimeSchemaGeneration(sql);

  if (state === RUNTIME_SCHEMA_GENERATION) {
    return;
  }

  const pendingFiles = state === "absent"
    ? MIGRATION_FILES
    : state === RELEASED_SCHEMA_GENERATION
      ? MIGRATION_FILES.slice(1)
      : null;

  if (!pendingFiles) {
    throw new RuntimeSchemaGenerationError(state);
  }

  for (const fileName of pendingFiles) {
    await sql.begin(async (transaction) => {
      await transaction.unsafe(readMigrationSql(fileName));
    });
  }

  await assertRuntimeSchemaGeneration(sql);
}

export async function assertRuntimeSchemaGeneration(sql: DatabaseClient): Promise<void> {
  const state = await inspectRuntimeSchemaGeneration(sql);

  if (state !== RUNTIME_SCHEMA_GENERATION) {
    throw new RuntimeSchemaGenerationError(state === "absent" ? null : state);
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
