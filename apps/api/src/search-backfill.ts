import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { loadRuntimeConfig } from "./config.js";
import { createPostgresAdminRepositories } from "./db/admin-repositories.js";
import { closeDatabaseClient, createDatabaseClient } from "./db/client.js";
import { createRuntimeLogger } from "./logger.js";
import { backfillGeneratedFileSearchDocuments } from "./search/generated-file-search-backfill.js";

loadLocalEnvFile();

const config = loadRuntimeConfig();
const logger = createRuntimeLogger(config, console, { streamName: "search-backfill" });
const sql = createDatabaseClient(config, { role: "migration" });
const repositories = createPostgresAdminRepositories(sql);

try {
  logger.info("Generated file search document indexing started");
  const result = await backfillGeneratedFileSearchDocuments({
    repositories,
    logger
  });
  logger.info("Generated file search document indexing completed", result);
} catch (error) {
  logger.error("Generated file search document indexing failed", error);
  process.exitCode = 1;
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
