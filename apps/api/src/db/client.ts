import postgres, { type Sql } from "postgres";
import type { RuntimeConfig } from "../config.js";

export type DatabaseClient = Sql;

type DatabaseRole =
  | "api"
  | "source-worker"
  | "publication-worker"
  | "maintenance-worker"
  | "migration";

const WORKER_IDLE_TIMEOUT_SECONDS = 5;

export function createDatabaseClient(
  config: RuntimeConfig,
  options: {
    role?: DatabaseRole;
  } = {}
): DatabaseClient {
  return postgres(
    config.database.url,
    createDatabaseClientOptions(config.database, options.role ?? "api")
  );
}

export function createDatabaseClientOptions(
  database: Pick<
    RuntimeConfig["database"],
    | "poolMax"
    | "sourceWorkerPoolMax"
    | "publicationWorkerPoolMax"
    | "maintenanceWorkerPoolMax"
  >,
  role: DatabaseRole
) {
  const max = role === "source-worker"
    ? database.sourceWorkerPoolMax ?? 6
    : role === "publication-worker"
      ? database.publicationWorkerPoolMax ?? 4
      : role === "maintenance-worker"
        ? database.maintenanceWorkerPoolMax ?? 2
        : database.poolMax ?? 10;
  const worker = role === "source-worker"
    || role === "publication-worker"
    || role === "maintenance-worker";

  return {
    max,
    idle_timeout: worker ? WORKER_IDLE_TIMEOUT_SECONDS : 20,
    connect_timeout: 10
  };
}

export async function closeDatabaseClient(sql: DatabaseClient): Promise<void> {
  await sql.end({ timeout: 5 });
}
