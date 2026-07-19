import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { loadRuntimeConfig } from "./config.js";
import { closeDatabaseClient, createDatabaseClient } from "./db/client.js";
import { assertRuntimeSchemaGeneration } from "./db/migrations.js";
import { createPostgresDirectoryNavigationRepository } from "./infrastructure/postgres/directory-navigation-repository.js";
import { createPostgresGenerationObjectReferenceRepository } from "./infrastructure/postgres/generation-object-reference-repository.js";
import { createPostgresImmutableObjectRepository } from "./infrastructure/postgres/immutable-object-repository.js";
import { createPostgresProjectionRecordRepository } from "./infrastructure/postgres/projection-record-repository.js";
import { createPostgresProjectionCatalogRepository } from "./infrastructure/postgres/projection-catalog-repository.js";
import { createPostgresProjectionShardRepository } from "./infrastructure/postgres/projection-shard-repository.js";
import { createPostgresPublicationGenerationRepository } from "./infrastructure/postgres/publication-generation-repository.js";
import { createPostgresPublicationImpactRepository } from "./infrastructure/postgres/publication-impact-repository.js";
import { createPostgresPublicationValidationRepository } from "./infrastructure/postgres/publication-validation-repository.js";
import { createPostgresRoleJobRepository } from "./infrastructure/postgres/role-job-repository.js";
import { createRuntimeLogger } from "./logger.js";
import { createBoundedRootWriter } from "./publication/bounded-root-writer.js";
import { createDirectoryNavigationWriter } from "./publication/directory-navigation-writer.js";
import { createImmutableObjectWriter } from "./publication/immutable-object-writer.js";
import { INCREMENTAL_PUBLICATION_DEFAULTS } from "./publication/incremental-defaults.js";
import { createJsonProjectionShardWriter } from "./publication/json-projection-shard-writer.js";
import { createProjectionCatalogWriter } from "./publication/projection-catalog-writer.js";
import { createRequiredProjectionWriter } from "./publication/required-projection-writer.js";
import { createRedisClient, createRedisCoordinator } from "./redis/coordination.js";
import { createResilientRedisCoordinator } from "./redis/resilient-coordinator.js";
import { registerWorkerRedisRuntimeEvents } from "./redis/worker-runtime.js";
import { createRuntimeSettingsService } from "./runtime-settings/service.js";
import { createPostgresAdminRepositories } from "./db/admin-repositories.js";
import { createS3StorageAdapter } from "./storage/s3.js";
import { createPublicationRoleProcessor } from "./worker/publication-role-processor.js";
import { createRoleWorkerRuntime } from "./worker/role-runtime.js";

loadLocalEnvFile();
const config = loadRuntimeConfig();

if (process.argv.includes("--healthcheck")) {
  await runHealthcheck();
} else {
  await runPublicationWorker();
}

async function runPublicationWorker(): Promise<void> {
  const logger = createRuntimeLogger(config, console, { streamName: "publication-worker" });
  const sql = createDatabaseClient(config, { role: "publication-worker" });
  const redisClient = createRedisClient(config);
  const abort = new AbortController();
  let redisConnected = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => abort.abort());
  }
  registerWorkerRedisRuntimeEvents({ client: redisClient, logger, role: "publication" });

  try {
    await assertRuntimeSchemaGeneration(sql);
    await redisClient.connect();
    redisConnected = true;
    const redis = createResilientRedisCoordinator({
      client: redisClient,
      coordinator: createRedisCoordinator(redisClient),
      sessionWrites: "best_effort"
    });
    const adminRepositories = createPostgresAdminRepositories(sql);
    if (!adminRepositories.runtimeSettings) {
      throw new Error("Runtime settings repository is unavailable");
    }
    const runtimeSettings = createRuntimeSettingsService({
      config,
      repository: adminRepositories.runtimeSettings,
      redis
    });
    await runtimeSettings.ensureBootstrapped();

    const storage = createS3StorageAdapter(config.storage);
    const references = createPostgresGenerationObjectReferenceRepository(sql);
    const immutableObjects = createImmutableObjectWriter({
      repository: createPostgresImmutableObjectRepository(sql),
      storage
    });
    const navigation = createPostgresDirectoryNavigationRepository(sql);
    const shards = createJsonProjectionShardWriter({
      references,
      shards: createPostgresProjectionShardRepository(sql),
      immutableObjects,
      storage,
      maxShardBytes: INCREMENTAL_PUBLICATION_DEFAULTS.maxShardBytes
    });
    const requiredWriter = createRequiredProjectionWriter({
      records: createPostgresProjectionRecordRepository(sql),
      references,
      immutableObjects,
      shards,
      storage,
      relatedFileLimit: 100
    });
    const rootWriter = createBoundedRootWriter({
      references,
      immutableObjects
    });
    const catalogWriter = createProjectionCatalogWriter({
      catalog: createPostgresProjectionCatalogRepository(sql),
      references,
      immutableObjects,
      maxShardDescriptors: INCREMENTAL_PUBLICATION_DEFAULTS.maxShardDescriptors
    });
    const directoryWriter = {
      async write(
        impact: Parameters<typeof requiredWriter.write>[0],
        settings: { directoryIndexMaxEntries: number; directoryIndexMaxBytes: number }
      ) {
        return createDirectoryNavigationWriter({
          navigation,
          references,
          immutableObjects,
          limits: {
            maxEntries: settings.directoryIndexMaxEntries,
            maxBytes: settings.directoryIndexMaxBytes,
            mergeBelowEntries: Math.max(1, Math.floor(settings.directoryIndexMaxEntries / 4))
          }
        }).write(impact);
      },
      async writeBatch(
        impacts: Parameters<typeof requiredWriter.writeBatch>[0],
        settings: { directoryIndexMaxEntries: number; directoryIndexMaxBytes: number }
      ) {
        return createDirectoryNavigationWriter({
          navigation,
          references,
          immutableObjects,
          limits: {
            maxEntries: settings.directoryIndexMaxEntries,
            maxBytes: settings.directoryIndexMaxBytes,
            mergeBelowEntries: Math.max(1, Math.floor(settings.directoryIndexMaxEntries / 4))
          }
        }).writeBatch(impacts);
      }
    };
    const processor = createPublicationRoleProcessor({
      generations: createPostgresPublicationGenerationRepository(sql),
      impacts: createPostgresPublicationImpactRepository(sql),
      validation: createPostgresPublicationValidationRepository(sql),
      references,
      immutableObjects,
      writers: [requiredWriter, directoryWriter, rootWriter],
      finalizers: [catalogWriter],
      impactLockTtlSeconds: 300,
      retryDelayMs: 5_000,
      validationIssueLimit: 50
    });
    const workerId = `publication-worker-${randomUUID()}`;
    const runtime = createRoleWorkerRuntime({
      role: "publication",
      workerId,
      repository: createPostgresRoleJobRepository(sql),
      async settings() {
        const snapshot = await runtimeSettings.getSnapshot();
        const worker = snapshot.worker;
        return {
          claimBatchSize: snapshot.publication.claimBatchSize,
          concurrency: snapshot.publication.roleConcurrency,
          pollIntervalMs: worker.pollIntervalMs,
          lockTtlSeconds: worker.lockTtlSeconds,
          heartbeatIntervalMs: worker.heartbeatIntervalMs,
          retryDelayMs: worker.jobRetryDelayMs
        };
      },
      process: processor,
      logger
    });
    await runtime.run(abort.signal);
  } finally {
    if (redisConnected) await redisClient.close();
    await closeDatabaseClient(sql);
  }
}

async function runHealthcheck(): Promise<void> {
  const sql = createDatabaseClient(config, { role: "publication-worker" });
  const redisClient = createRedisClient(config);
  const storage = createS3StorageAdapter(config.storage);
  let redisConnected = false;
  try {
    await assertRuntimeSchemaGeneration(sql);
    await sql`SELECT count(*)::int AS count FROM focowiki.role_jobs WHERE role = 'publication'`;
    await redisClient.connect();
    redisConnected = true;
    await redisClient.ping();
    await storage.checkHealth?.();
  } finally {
    if (redisConnected) await redisClient.close();
    await closeDatabaseClient(sql);
  }
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
