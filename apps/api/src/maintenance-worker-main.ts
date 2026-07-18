import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { loadRuntimeConfig } from "./config.js";
import { closeDatabaseClient, createDatabaseClient } from "./db/client.js";
import { assertRuntimeSchemaGeneration } from "./db/migrations.js";
import { RoleJobFailure } from "./domain/role-job.js";
import { createPostgresAdminRepositories } from "./db/admin-repositories.js";
import { createPostgresGenerationCleanupRepository } from "./infrastructure/postgres/generation-cleanup-repository.js";
import { createPostgresRoleJobRepository } from "./infrastructure/postgres/role-job-repository.js";
import { createRuntimeLogger } from "./logger.js";
import { createRedisClient, createRedisCoordinator } from "./redis/coordination.js";
import { createResilientRedisCoordinator } from "./redis/resilient-coordinator.js";
import { registerWorkerRedisRuntimeEvents } from "./redis/worker-runtime.js";
import { createRuntimeSettingsService } from "./runtime-settings/service.js";
import { createS3StorageAdapter } from "./storage/s3.js";
import { createGarbageCollectionJobProcessor } from "./worker/garbage-collection-jobs.js";
import { createHardDeleteJobProcessor } from "./worker/hard-delete-jobs.js";
import { createRoleWorkerRuntime } from "./worker/role-runtime.js";

loadLocalEnvFile();
const config = loadRuntimeConfig();

if (process.argv.includes("--healthcheck")) {
  await runHealthcheck();
} else {
  await runMaintenanceWorker();
}

async function runMaintenanceWorker(): Promise<void> {
  const logger = createRuntimeLogger(config, console, { streamName: "maintenance-worker" });
  const sql = createDatabaseClient(config, { role: "maintenance-worker" });
  const redisClient = createRedisClient(config);
  const abort = new AbortController();
  let redisConnected = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => abort.abort());
  }
  registerWorkerRedisRuntimeEvents({ client: redisClient, logger, role: "maintenance" });
  try {
    await assertRuntimeSchemaGeneration(sql);
    await redisClient.connect();
    redisConnected = true;
    const redis = createResilientRedisCoordinator({
      client: redisClient,
      coordinator: createRedisCoordinator(redisClient),
      sessionWrites: "best_effort"
    });
    const repositories = createPostgresAdminRepositories(sql);
    if (!repositories.runtimeSettings) {
      throw new Error("Runtime settings repository is unavailable");
    }
    const runtimeSettings = createRuntimeSettingsService({
      config,
      repository: repositories.runtimeSettings,
      redis
    });
    await runtimeSettings.ensureBootstrapped();
    const cleanup = createPostgresGenerationCleanupRepository(sql);
    const storage = createS3StorageAdapter(config.storage);
    const runtime = createRoleWorkerRuntime({
      role: "maintenance",
      workerId: `maintenance-worker-${randomUUID()}`,
      repository: createPostgresRoleJobRepository(sql),
      async settings() {
        const worker = (await runtimeSettings.getSnapshot()).worker;
        return {
          claimBatchSize: worker.claimBatchSize,
          concurrency: worker.hardDeleteConcurrency,
          pollIntervalMs: worker.pollIntervalMs,
          lockTtlSeconds: worker.lockTtlSeconds,
          heartbeatIntervalMs: worker.heartbeatIntervalMs,
          retryDelayMs: worker.hardDeleteRetryDelayMs
        };
      },
      async process(job) {
        if (job.kind === "hard_delete") {
          const worker = (await runtimeSettings.getSnapshot()).worker;
          await createHardDeleteJobProcessor({
            cleanup,
            storage,
            redis,
            settings: {
              databaseBatchSize: worker.hardDeleteDatabaseBatchSize,
              objectBatchSize: worker.hardDeleteObjectBatchSize,
              versionPurgeEnabled: worker.hardDeleteVersionPurgeEnabled,
              continuationDelayMs: worker.pollIntervalMs
            }
          })(job);
          return;
        }
        if (job.kind === "garbage_collection") {
          const worker = (await runtimeSettings.getSnapshot()).worker;
          await createGarbageCollectionJobProcessor({
            cleanup,
            storage,
            batchSize: worker.retentionCleanupBatchSize,
            retentionDays: (await runtimeSettings.getSnapshot()).publication.generationRetentionDays,
            versionPurgeEnabled: worker.hardDeleteVersionPurgeEnabled,
            continuationDelayMs: worker.jobRetryDelayMs
          })(job);
          return;
        }
        if (!["projection_audit", "garbage_collection"].includes(job.kind)) {
          throw new RoleJobFailure({
            code: "INVALID_MAINTENANCE_ROLE_JOB",
            message: "Maintenance role job kind is invalid",
            retryable: false
          });
        }
        if (job.kind === "projection_audit") {
          const invalid = await sql<Array<{ count: number }>>`
            SELECT count(*)::int AS count
            FROM focowiki.active_object_refs reference
            LEFT JOIN focowiki.immutable_objects object
              ON object.checksum_sha256 = reference.checksum_sha256
             AND object.format_version = reference.format_version
            WHERE reference.knowledge_base_id = ${job.knowledgeBaseId}
              AND object.checksum_sha256 IS NULL
          `;
          if (Number(invalid[0]?.count ?? 0) > 0) {
            throw new RoleJobFailure({
              code: "ACTIVE_REFERENCE_AUDIT_FAILED",
              message: "Active object reference audit failed",
              retryable: false
            });
          }
        }
      },
      logger
    });
    await runtime.run(abort.signal);
  } finally {
    if (redisConnected) await redisClient.close();
    await closeDatabaseClient(sql);
  }
}

async function runHealthcheck(): Promise<void> {
  const sql = createDatabaseClient(config, { role: "maintenance-worker" });
  const redisClient = createRedisClient(config);
  const storage = createS3StorageAdapter(config.storage);
  let redisConnected = false;
  try {
    await assertRuntimeSchemaGeneration(sql);
    await sql`SELECT count(*)::int AS count FROM focowiki.role_jobs WHERE role = 'maintenance'`;
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
