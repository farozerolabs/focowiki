import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { createSourceFileQueueProcessor } from "./admin/source-file-processor.js";
import { createSourceProcessingCompletion } from "./application/source-processing-completion.js";
import { loadRuntimeConfig, resolveWorkerConfig } from "./config.js";
import { createPostgresAdminRepositories } from "./db/admin-repositories.js";
import { closeDatabaseClient, createDatabaseClient } from "./db/client.js";
import { assertRuntimeSchemaGeneration } from "./db/migrations.js";
import { createPostgresPublicationGenerationRepository } from "./infrastructure/postgres/publication-generation-repository.js";
import { createPostgresRoleJobRepository } from "./infrastructure/postgres/role-job-repository.js";
import { createPostgresSourceDispatchRepository } from "./infrastructure/postgres/source-dispatch-repository.js";
import { createPostgresSourceRevisionContextRepository } from "./infrastructure/postgres/source-revision-context-repository.js";
import { createRuntimeLogger } from "./logger.js";
import { INCREMENTAL_PUBLICATION_DEFAULTS } from "./publication/incremental-defaults.js";
import { createRedisClient, createRedisCoordinator } from "./redis/coordination.js";
import { createResilientRedisCoordinator } from "./redis/resilient-coordinator.js";
import { registerWorkerRedisRuntimeEvents } from "./redis/worker-runtime.js";
import { createRuntimeSettingsService } from "./runtime-settings/service.js";
import { createModelAssistanceGateway } from "./runtime-settings/model-assistance-gateway.js";
import { resolveResourceBudgetLimits } from "./runtime-settings/resource-budget-settings.js";
import { createProcessResourceBudgets } from "./runtime/resource-budget.js";
import { createResourceBudgetReporter } from "./runtime/resource-budget-reporter.js";
import { createS3StorageAdapter } from "./storage/s3.js";
import { createRoleWorkerRuntime } from "./worker/role-runtime.js";
import { createSourceRoleProcessor } from "./worker/source-role-processor.js";

loadLocalEnvFile();
const config = loadRuntimeConfig();

if (process.argv.includes("--healthcheck")) {
  await runHealthcheck();
} else {
  await runSourceWorker();
}

async function runSourceWorker(): Promise<void> {
  const logger = createRuntimeLogger(config, console, { streamName: "source-worker" });
  const sql = createDatabaseClient(config, { role: "source-worker" });
  const redisClient = createRedisClient(config);
  const abort = new AbortController();
  let redisConnected = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => abort.abort());
  }
  registerWorkerRedisRuntimeEvents({ client: redisClient, logger, role: "source" });

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
    const initialSnapshot = await runtimeSettings.getSnapshot();
    const resourceBudgets = createProcessResourceBudgets(
      resolveResourceBudgetLimits(initialSnapshot)
    );
    const resourceBudgetReporter = createResourceBudgetReporter({ logger });
    const modelGateway = createModelAssistanceGateway({
      budget: resourceBudgets.model
    });
    const generations = createPostgresPublicationGenerationRepository(sql);
    const completion = createSourceProcessingCompletion({
      revisions: createPostgresSourceRevisionContextRepository(sql),
      generations,
      impactPlanner: INCREMENTAL_PUBLICATION_DEFAULTS.impactPlanner,
      publicationSettingsSnapshot: {},
      publicationMaxAttempts: resolveWorkerConfig(config).jobMaxAttempts
    });
    const storage = createS3StorageAdapter(config.storage);
    const sourceProcessor = createSourceFileQueueProcessor(
      repositories,
      storage,
      redis,
      completion,
      null,
      {
        sourceObjectRead: resourceBudgets.sourceObjectRead,
        graphQuery: resourceBudgets.graphQuery,
        databaseMutation: resourceBudgets.databaseMutation
      }
    );
    if (!sourceProcessor) {
      throw new Error("Source processor is unavailable");
    }
    const dispatcher = createPostgresSourceDispatchRepository(sql);
    const roleJobs = createPostgresRoleJobRepository(sql);
    const workerId = `source-worker-${randomUUID()}`;
    const process = createSourceRoleProcessor({
      config,
      repositories,
      processor: sourceProcessor,
      runtimeSettings,
      roleJobs,
      generations,
      impactPlanner: INCREMENTAL_PUBLICATION_DEFAULTS.impactPlanner,
      modelGateway,
      async cleanupObjectKeys(keys) {
        if (keys.length === 0) return;
        if (storage.deleteObjects) {
          await storage.deleteObjects(keys);
          return;
        }
        for (const key of keys) {
          await storage.deleteObject?.(key);
        }
      }
    });
    const runtime = createRoleWorkerRuntime({
      role: "source",
      workerId,
      repository: roleJobs,
      async beforeClaim() {
        const snapshot = await runtimeSettings.getSnapshot();
        resourceBudgets.update(resolveResourceBudgetLimits(snapshot));
        resourceBudgetReporter.report(resourceBudgets);
        await dispatcher.dispatchPending({
          dispatcherId: workerId,
          now: new Date().toISOString(),
          batchSize: snapshot.worker.claimBatchSize,
          maxAttempts: snapshot.worker.jobMaxAttempts,
          settingsSnapshot: {
            worker: snapshot.worker,
            publication: snapshot.publication,
            graph: snapshot.graph
          },
          pressure: {
            hard: {
              sourceQueueDepth: snapshot.worker.sourceQueueHardDepth,
              oldestSourceQueueAgeSeconds: snapshot.worker.sourceQueueHardAgeSeconds,
              dirtyFileCount: snapshot.publication.dirtyFileHardCount,
              oldestDirtyAgeSeconds: snapshot.publication.dirtyAgeHardSeconds,
              pendingImpactCount: snapshot.publication.pendingImpactHardCount
            },
            resume: {
              sourceQueueDepth: snapshot.worker.sourceQueueResumeDepth,
              oldestSourceQueueAgeSeconds: snapshot.worker.sourceQueueResumeAgeSeconds,
              dirtyFileCount: snapshot.publication.dirtyFileResumeCount,
              oldestDirtyAgeSeconds: snapshot.publication.dirtyAgeResumeSeconds,
              pendingImpactCount: snapshot.publication.pendingImpactResumeCount
            }
          }
        });
      },
      async settings() {
        const snapshot = await runtimeSettings.getSnapshot();
        resourceBudgets.update(resolveResourceBudgetLimits(snapshot));
        const worker = snapshot.worker;
        return {
          claimBatchSize: worker.claimBatchSize,
          concurrency: worker.sourceFileConcurrency,
          pollIntervalMs: worker.pollIntervalMs,
          lockTtlSeconds: worker.lockTtlSeconds,
          heartbeatIntervalMs: worker.heartbeatIntervalMs,
          retryDelayMs: worker.jobRetryDelayMs
        };
      },
      process,
      logger
    });
    try {
      await runtime.run(abort.signal);
    } finally {
      resourceBudgetReporter.report(resourceBudgets, { force: true });
    }
  } finally {
    if (redisConnected) {
      await redisClient.close();
    }
    await closeDatabaseClient(sql);
  }
}

async function runHealthcheck(): Promise<void> {
  const sql = createDatabaseClient(config, { role: "source-worker" });
  const redisClient = createRedisClient(config);
  const storage = createS3StorageAdapter(config.storage);
  let redisConnected = false;
  try {
    await assertRuntimeSchemaGeneration(sql);
    await sql`SELECT count(*)::int AS count FROM focowiki.role_jobs WHERE role = 'source'`;
    await redisClient.connect();
    redisConnected = true;
    await redisClient.ping();
    await storage.checkHealth?.();
  } finally {
    if (redisConnected) {
      await redisClient.close();
    }
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
  if (envFile) {
    loadEnvFile(envFile);
  }
}
