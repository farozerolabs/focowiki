import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { loadRuntimeConfig } from "../config.js";
import { closeDatabaseClient, createDatabaseClient } from "./client.js";
import { applyMigrations } from "./migrations.js";

loadLocalEnvFile();

const config = loadRuntimeConfig();
const sql = createDatabaseClient(config);

try {
  await applyMigrations(sql);
  console.info("Database migrations applied");
} finally {
  await closeDatabaseClient(sql);
}

function loadLocalEnvFile() {
  if (process.env.ENV_FILE) {
    loadEnvFile(process.env.ENV_FILE);
    return;
  }

  const candidates = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")];
  const envFile = candidates.find((candidate) => existsSync(candidate));

  if (envFile) {
    loadEnvFile(envFile);
  }
}
