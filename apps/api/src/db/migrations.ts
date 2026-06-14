import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseClient } from "./client.js";

export const MIGRATION_FILES = ["001_production_admin_web.sql"] as const;

export function readMigrationSql(fileName: (typeof MIGRATION_FILES)[number]): string {
  const migrationUrl = new URL(`../../migrations/${fileName}`, import.meta.url);
  return readFileSync(fileURLToPath(migrationUrl), "utf8");
}

export async function applyMigrations(sql: DatabaseClient): Promise<void> {
  for (const fileName of MIGRATION_FILES) {
    await sql.unsafe(readMigrationSql(fileName));
  }
}
