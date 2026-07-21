import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { loadRuntimeConfig } from "../config.js";
import { createRuntimeLogger } from "../logger.js";
import { closeDatabaseClient, createDatabaseClient } from "./client.js";
import { preflightMigrations } from "./migrations.js";

loadLocalEnvFile();

const config = loadRuntimeConfig();
const logger = createRuntimeLogger(config, console, { streamName: "migration-preflight" });
const sql = createDatabaseClient(config);

try {
  const plan = await preflightMigrations(sql);
  logger.info("Database migration preflight passed", {
    currentGeneration: plan.currentGeneration,
    pendingMigrationCount: plan.pendingFiles.length
  });
} finally {
  await closeDatabaseClient(sql);
}

function loadLocalEnvFile(): void {
  if (process.env.ENV_FILE) {
    loadEnvFile(process.env.ENV_FILE);
    return;
  }

  const candidates = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")];
  const envFile = candidates.find((candidate) => existsSync(candidate));
  if (envFile) loadEnvFile(envFile);
}
