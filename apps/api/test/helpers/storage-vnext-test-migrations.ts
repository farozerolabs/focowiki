import type { DatabaseClient } from "../../src/db/client.js";
import { applyMigrations } from "../../src/db/migrations.js";

export async function applyStorageVnextTestMigrations(
  database: unknown
): Promise<void> {
  await applyMigrations(database as DatabaseClient);
}
