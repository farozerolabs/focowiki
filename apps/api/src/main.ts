import { serve } from "@hono/node-server";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { loadRuntimeConfig } from "./config.js";
import { createDatabaseClient } from "./db/client.js";
import { assertRuntimeSchemaGeneration } from "./db/migrations.js";
import { createPostgresAdminRepositories } from "./db/admin-repositories.js";
import { createS3StorageAdapter } from "./storage/s3.js";
import { createAdminApiApp, createPublicOpenApiApp } from "./server.js";
import { connectApiRedis } from "./redis/api-runtime.js";
import { createRuntimeLogger } from "./logger.js";
import { createPostgresActiveGenerationReadRepository } from "./infrastructure/postgres/active-generation-read-repository.js";
import { createPostgresRoleJobRepository } from "./infrastructure/postgres/role-job-repository.js";
import { createPostgresPublicationGenerationRepository } from "./infrastructure/postgres/publication-generation-repository.js";
import { createPostgresSourceDispatchRepository } from "./infrastructure/postgres/source-dispatch-repository.js";
import { createPostgresSourceFileRetryRepository } from "./infrastructure/postgres/source-file-retry-repository.js";
import { createPostgresSourceFileTaskDeletionRepository } from "./infrastructure/postgres/source-file-task-deletion-repository.js";
import { createPostgresStorageReconciliationRepository } from "./infrastructure/postgres/storage-reconciliation-repository.js";

loadLocalEnvFile();

const config = loadRuntimeConfig();
const logger = createRuntimeLogger(config, console, { streamName: "api" });
const storage = createS3StorageAdapter(config.storage);
const sql = createDatabaseClient(config);
await assertRuntimeSchemaGeneration(sql);
const repositories = createPostgresAdminRepositories(sql);
const activeGenerationReads = createPostgresActiveGenerationReadRepository(sql);
const roleJobs = createPostgresRoleJobRepository(sql);
const publicationGenerations = createPostgresPublicationGenerationRepository(sql);
const sourceDispatch = createPostgresSourceDispatchRepository(sql);
const sourceFileRetries = createPostgresSourceFileRetryRepository(sql);
const sourceFileTaskDeletions = createPostgresSourceFileTaskDeletionRepository(sql);
const storageReconciliation = createPostgresStorageReconciliationRepository(sql);
const redis = await connectApiRedis({ config, logger });
const sharedServices = {
  config,
  storage,
  repositories,
  activeGenerationReads,
  roleJobs,
  publicationGenerations,
  sourceDispatch,
  sourceFileRetries,
  sourceFileTaskDeletions,
  storageReconciliation,
  logger,
  ...(redis ? { redis } : {})
};

serve({
  fetch: createAdminApiApp(sharedServices).fetch,
  port: config.ports.adminApi
});

serve({
  fetch: createPublicOpenApiApp(sharedServices).fetch,
  port: config.ports.publicOpenApi
});

logger.info("Admin API service started");
logger.info("Public OpenAPI service started");

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
