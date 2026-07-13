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
import { createRedisClient, createRedisCoordinator } from "./redis/coordination.js";
import { createRuntimeLogger } from "./logger.js";

loadLocalEnvFile();

const config = loadRuntimeConfig();
const logger = createRuntimeLogger(config, console, { streamName: "api" });
const storage = createS3StorageAdapter(config.storage);
const sql = createDatabaseClient(config);
await assertRuntimeSchemaGeneration(sql);
const repositories = createPostgresAdminRepositories(sql);
const redisClient = createRedisClient(config);
await redisClient.connect();
const redis = createRedisCoordinator(redisClient);

serve({
  fetch: createAdminApiApp({ config, storage, redis, repositories }).fetch,
  port: config.ports.adminApi
});

serve({
  fetch: createPublicOpenApiApp({ config, storage, redis, repositories }).fetch,
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
