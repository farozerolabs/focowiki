import postgres, { type Sql } from "postgres";
import type { RuntimeConfig } from "../config.js";

export type DatabaseClient = Sql;

export function createDatabaseClient(
  config: RuntimeConfig,
  options: { role?: "api" | "worker" | "migration" } = {}
): DatabaseClient {
  const max =
    options.role === "worker"
      ? (config.worker?.databasePoolMax ?? config.database.poolMax ?? 10)
      : (config.database.poolMax ?? 10);

  return postgres(config.database.url, {
    max,
    idle_timeout: 20,
    connect_timeout: 10
  });
}

export async function closeDatabaseClient(sql: DatabaseClient): Promise<void> {
  await sql.end({ timeout: 5 });
}
