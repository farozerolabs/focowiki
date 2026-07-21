import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseClient } from "./client.js";
import { assertMigrationWorkDrained } from "./migration-preflight.js";

export const MIGRATION_FILES = [
  "001_production_admin_web.sql",
  "002_tree_graph_storage_reconciliation.sql",
  "003_bounded_publication_recovery.sql",
  "004_immutable_object_contention_recovery.sql",
  "005_publication_retry_budget_recovery.sql",
  "006_publication_continuation_recovery.sql",
  "007_publication_write_livelock_recovery.sql",
  "008_large_scale_ingestion_runtime.sql",
  "009_optimization_migration_rebase_recovery.sql"
] as const;
const TREE_GRAPH_SCHEMA_GENERATION = "tree-graph-storage-reconciliation-v2";
const BOUNDED_PUBLICATION_SCHEMA_GENERATION = "bounded-publication-recovery-v3";
const IMMUTABLE_CONTENTION_SCHEMA_GENERATION = "immutable-object-contention-recovery-v4";
export const RELEASED_SCHEMA_GENERATION = "publication-retry-budget-recovery-v5";
const CONTINUATION_SCHEMA_GENERATION = "publication-continuation-recovery-v6";
const WRITE_LIVELOCK_SCHEMA_GENERATION = "publication-write-livelock-recovery-v7";
const LARGE_SCALE_SCHEMA_GENERATION = "large-scale-ingestion-runtime-v8";
export const RUNTIME_SCHEMA_GENERATION = "optimization-migration-rebase-recovery-v9";

const MIGRATION_START_BY_GENERATION = new Map<string, number>([
  ["incremental-sharded-publication-v1", 1],
  [TREE_GRAPH_SCHEMA_GENERATION, 2],
  [BOUNDED_PUBLICATION_SCHEMA_GENERATION, 3],
  [IMMUTABLE_CONTENTION_SCHEMA_GENERATION, 4],
  [RELEASED_SCHEMA_GENERATION, 5],
  [CONTINUATION_SCHEMA_GENERATION, 6],
  [WRITE_LIVELOCK_SCHEMA_GENERATION, 7],
  [LARGE_SCALE_SCHEMA_GENERATION, 8]
]);

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

export type MigrationPreflightResult = {
  currentGeneration: string | "absent";
  pendingFiles: Array<(typeof MIGRATION_FILES)[number]>;
};

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
  if (state === RUNTIME_SCHEMA_GENERATION) {
    return { currentGeneration: state, pendingFiles: [] };
  }

  if (state !== "absent" && typeof state !== "string") {
    throw new RuntimeSchemaGenerationError(state);
  }
  const migrationStart = state === "absent"
    ? 0
    : MIGRATION_START_BY_GENERATION.get(state);
  if (migrationStart === undefined) {
    throw new RuntimeSchemaGenerationError(state);
  }

  if (state !== "absent") await assertMigrationWorkDrained(sql);
  return {
    currentGeneration: state,
    pendingFiles: MIGRATION_FILES.slice(migrationStart)
  };
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
