import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseClient } from "./client.js";

export const MIGRATION_FILES = ["001_production_admin_web.sql"] as const;

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
  for (const fileName of MIGRATION_FILES) {
    await sql.unsafe(readMigrationSql(fileName));
  }
}
