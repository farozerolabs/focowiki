import postgres, { type Sql } from "postgres";
import type { RuntimeConfig } from "../config.js";

export type DatabaseClient = Sql;

export function createDatabaseClient(config: RuntimeConfig): DatabaseClient {
  return postgres(config.database.url, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10
  });
}

export async function closeDatabaseClient(sql: DatabaseClient): Promise<void> {
  await sql.end({ timeout: 5 });
}
