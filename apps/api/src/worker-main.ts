import {
  createOpenAIResponsesClient,
  type OpenAIResponsesClient
} from "@focowiki/okf";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { loadRuntimeConfig } from "./config.js";
import { createPostgresAdminRepositories } from "./db/admin-repositories.js";
import { closeDatabaseClient, createDatabaseClient } from "./db/client.js";
import { createRuntimeLogger } from "./logger.js";
import { createRedisClient, createRedisCoordinator } from "./redis/coordination.js";
import { createRuntimeSettingsService } from "./runtime-settings/service.js";
import { createS3StorageAdapter } from "./storage/s3.js";
import { createWorkerRuntime } from "./worker/runtime.js";

loadLocalEnvFile();

const config = loadRuntimeConfig();

if (process.argv.includes("--healthcheck")) {
  await runHealthcheck(config);
} else {
  await runWorker(config);
}

async function runWorker(config: ReturnType<typeof loadRuntimeConfig>): Promise<void> {
  const logger = createRuntimeLogger(config, console, { streamName: "worker" });
  const storage = createS3StorageAdapter(config.storage);
  const sql = createDatabaseClient(config, { role: "worker" });
  const repositories = createPostgresAdminRepositories(sql);
  const redisClient = createRedisClient(config);
  let redisConnected = false;
  const abortController = new AbortController();

  for (const signalName of ["SIGINT", "SIGTERM"] as const) {
    process.on(signalName, () => {
      abortController.abort();
    });
  }

  try {
    await redisClient.connect();
    redisConnected = true;
    const redis = createRedisCoordinator(redisClient);
    const modelClient = createModelClient(config);
    const runtimeSettings = repositories.runtimeSettings
      ? createRuntimeSettingsService({
          config,
          repository: repositories.runtimeSettings,
          redis
        })
      : null;

    await runtimeSettings?.ensureBootstrapped();

    await createWorkerRuntime({
      config,
      repositories,
      storage,
      redis,
      modelClient,
      runtimeSettings,
      logger
    }).run(abortController.signal);
  } finally {
    if (redisConnected) {
      await redisClient.close();
    }
    await closeDatabaseClient(sql);
  }
}

async function runHealthcheck(config: ReturnType<typeof loadRuntimeConfig>): Promise<void> {
  const sql = createDatabaseClient(config, { role: "worker" });
  const redisClient = createRedisClient(config);
  let redisConnected = false;

  try {
    await sql`select 1`;
    await sql`select count(*)::int as count from focowiki.worker_jobs`;
    await sql`select count(*)::int as count from focowiki.worker_heartbeats`;
    await redisClient.connect();
    redisConnected = true;
    await redisClient.ping();
  } finally {
    if (redisConnected) {
      await redisClient.close();
    }
    await closeDatabaseClient(sql);
  }
}

function createModelClient(
  config: ReturnType<typeof loadRuntimeConfig>
): OpenAIResponsesClient | null {
  if (!config.model.enabled) {
    return null;
  }

  return createOpenAIResponsesClient({
    apiKey: config.model.apiKey,
    baseUrl: config.model.baseUrl,
    requestTimeoutMs: config.model.requestMaxTimeoutMs
  });
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
