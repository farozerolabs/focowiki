import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { loadRuntimeConfig } from "./config.js";
import { closeDatabaseClient, createDatabaseClient } from "./db/client.js";
import { assertRuntimeSchemaGeneration } from "./db/migrations.js";
import { createPostgresGenerationObjectReferenceRepository } from "./infrastructure/postgres/generation-object-reference-repository.js";
import { createPostgresImmutableObjectRepository } from "./infrastructure/postgres/immutable-object-repository.js";
import { createPostgresProjectionCatalogRepository } from "./infrastructure/postgres/projection-catalog-repository.js";
import { createPostgresProjectionRepairBuildRepository } from "./infrastructure/postgres/projection-repair-build-repository.js";
import { createPostgresProjectionRepairWorkRepository } from "./infrastructure/postgres/projection-repair-work-repository.js";
import { createPostgresProjectionSegmentRepository } from "./infrastructure/postgres/projection-segment-repository.js";
import { createPostgresPublicationGenerationRepository } from "./infrastructure/postgres/publication-generation-repository.js";
import { createPostgresPublicationValidationRepository } from "./infrastructure/postgres/publication-validation-repository.js";
import { createPostgresRoleJobRepository } from "./infrastructure/postgres/role-job-repository.js";
import { createRuntimeLogger } from "./logger.js";
import {
  clampProjectionRepairConcurrency,
  CURRENT_PROJECTION_REPAIR_PLANNER_VERSION,
  CURRENT_PROJECTION_REPAIR_VERSION,
  type ProjectionRepairSettingsSnapshot
} from "./maintenance/projection-repair-plan.js";
import { createProjectionRepairTaskProcessor } from "./maintenance/projection-repair-task-processor.js";
import { createImmutableObjectWriter } from "./publication/immutable-object-writer.js";
import { INCREMENTAL_PUBLICATION_DEFAULTS } from "./publication/incremental-defaults.js";
import { createProjectionCatalogWriter } from "./publication/projection-catalog-writer.js";
import { createProjectionSegmentWriter } from "./publication/projection-segment-writer.js";
import { createRedisClient, createRedisCoordinator } from "./redis/coordination.js";
import { createResilientRedisCoordinator } from "./redis/resilient-coordinator.js";
import { registerWorkerRedisRuntimeEvents } from "./redis/worker-runtime.js";
import { createProcessResourceBudgets } from "./runtime/resource-budget.js";
import { createResourceBudgetReporter } from "./runtime/resource-budget-reporter.js";
import { resolveResourceBudgetLimits } from "./runtime-settings/resource-budget-settings.js";
import { createRuntimeSettingsRepository } from "./runtime-settings/repository.js";
import { createRuntimeSettingsService } from "./runtime-settings/service.js";
import { createS3StorageAdapter } from "./storage/s3.js";

loadLocalEnvFile();
const config = loadRuntimeConfig();

if (process.argv.includes("--healthcheck")) {
  await runHealthcheck();
} else {
  await runProjectionRepairWorker();
}

async function runProjectionRepairWorker(): Promise<void> {
  const logger = createRuntimeLogger(config, console, {
    streamName: "projection-repair-worker"
  });
  const sql = createDatabaseClient(config, { role: "projection-repair-worker" });
  const redisClient = createRedisClient(config);
  const abort = new AbortController();
  let redisConnected = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => abort.abort());
  }
  registerWorkerRedisRuntimeEvents({
    client: redisClient,
    logger,
    role: "projection_repair"
  });

  try {
    await assertRuntimeSchemaGeneration(sql);
    await redisClient.connect();
    redisConnected = true;
    const redis = createResilientRedisCoordinator({
      client: redisClient,
      coordinator: createRedisCoordinator(redisClient),
      sessionWrites: "best_effort"
    });
    const runtimeSettings = createRuntimeSettingsService({
      config,
      repository: createRuntimeSettingsRepository(sql),
      redis
    });
    await runtimeSettings.ensureBootstrapped();
    const initialSnapshot = await runtimeSettings.getSnapshot();
    let lastValidSnapshot = initialSnapshot;
    const resourceBudgets = createProcessResourceBudgets(
      resolveResourceBudgetLimits(initialSnapshot)
    );
    const resourceBudgetReporter = createResourceBudgetReporter({ logger });
    const work = createPostgresProjectionRepairWorkRepository(sql);
    const builds = createPostgresProjectionRepairBuildRepository(sql);
    const references = createPostgresGenerationObjectReferenceRepository(sql);
    const storage = createS3StorageAdapter(config.storage);
    const unboundedImmutableObjects = createImmutableObjectWriter({
      repository: createPostgresImmutableObjectRepository(sql),
      storage
    });
    const immutableObjects = {
      write(object: Parameters<typeof unboundedImmutableObjects.write>[0]) {
        return resourceBudgets.generatedObjectWrite.run(
          () => unboundedImmutableObjects.write(object)
        );
      }
    };
    const shards = createProjectionSegmentWriter({
      references,
      segments: createPostgresProjectionSegmentRepository(sql),
      immutableObjects,
      maxSegmentEntries: INCREMENTAL_PUBLICATION_DEFAULTS.maxSegmentEntries,
      maxSegmentBytes: INCREMENTAL_PUBLICATION_DEFAULTS.maxSegmentBytes,
      maxObjectBytes: config.pagination.generatedContentMaxBytes
    });
    const catalog = createProjectionCatalogWriter({
      catalog: createPostgresProjectionCatalogRepository(sql),
      references,
      immutableObjects,
      maxShardDescriptors: INCREMENTAL_PUBLICATION_DEFAULTS.maxShardDescriptors
    });
    const generations = createPostgresPublicationGenerationRepository(sql);
    const validation = createPostgresPublicationValidationRepository(sql);
    const roleJobs = createPostgresRoleJobRepository(sql);
    const workerId = `projection-repair-worker-${randomUUID()}`;

    logger.info("Projection repair worker started", { workerId });
    try {
      while (!abort.signal.aborted) {
        try {
          const snapshot = await runtimeSettings.getSnapshot()
            .then((nextSnapshot) => {
              lastValidSnapshot = nextSnapshot;
              return nextSnapshot;
            })
            .catch((error) => {
              logger.warn(
                "Projection repair settings refresh failed",
                { code: "PROJECTION_REPAIR_SETTINGS_REFRESH_FAILED" },
                error
              );
              return lastValidSnapshot;
            });
          const settings: ProjectionRepairSettingsSnapshot = {
            concurrency: snapshot.maintenance.projectionRepairConcurrency,
            databaseBatchSize: snapshot.maintenance.projectionRepairDatabaseBatchSize,
            objectWriteConcurrency:
              snapshot.maintenance.projectionRepairObjectWriteConcurrency
          };
          const poolMax = config.database.projectionRepairWorkerPoolMax ?? 8;
          const reservedConnections = Math.min(2, Math.max(0, poolMax - 1));
          const concurrency = clampProjectionRepairConcurrency({
            configuredConcurrency: settings.concurrency,
            databasePoolMax: poolMax,
            reservedConnections
          });
          if (concurrency.clamped) {
            logger.warn("Projection repair concurrency was clamped to database capacity", {
              configuredConcurrency: settings.concurrency,
              effectiveConcurrency: concurrency.effectiveConcurrency,
              databasePoolMax: poolMax,
              reservedConnections
            });
          }
          resourceBudgets.update({
            generatedObjectWrite: settings.objectWriteConcurrency,
            projectionPartition: concurrency.effectiveConcurrency,
            databaseMutation: concurrency.effectiveConcurrency
          });
          resourceBudgetReporter.report(resourceBudgets);

          const now = new Date();
          const settingsRevision = await readSettingsRevision(sql);
          await work.bootstrap({
            repairVersion: CURRENT_PROJECTION_REPAIR_VERSION,
            plannerVersion: CURRENT_PROJECTION_REPAIR_PLANNER_VERSION,
            settingsRevision,
            settings,
            maxAttempts: snapshot.maintenance.maxAttempts,
            now: now.toISOString(),
            requireActiveMaintenanceRequest: true
          });
          for (let index = 0; index < concurrency.effectiveConcurrency; index += 1) {
            const planned = await work.planNext({
              repairVersion: CURRENT_PROJECTION_REPAIR_VERSION,
              plannerVersion: CURRENT_PROJECTION_REPAIR_PLANNER_VERSION,
              targetGenerationId: `generation-repair-${randomUUID()}`,
              settingsRevision,
              settings,
              maxAttempts: snapshot.maintenance.maxAttempts,
              now: now.toISOString()
            });
            if (!planned) break;
            logger.info("Projection repair plan persisted", planned);
          }

          const claimedAt = new Date();
          const tasks = await work.claimBatch({
            repairVersion: CURRENT_PROJECTION_REPAIR_VERSION,
            workerId,
            leaseTokenPrefix: randomUUID(),
            limit: concurrency.effectiveConcurrency,
            now: claimedAt.toISOString(),
            leaseExpiresAt: new Date(
              claimedAt.getTime() + snapshot.worker.lockTtlSeconds * 1_000
            ).toISOString()
          });
          if (tasks.length === 0) {
            await heartbeatRole(roleJobs, workerId, []);
            await sleep(snapshot.worker.pollIntervalMs, abort.signal);
            continue;
          }

          const batchConcurrency = Math.min(
            concurrency.effectiveConcurrency,
            ...tasks.map((task) => task.settings.concurrency)
          );
          const objectWriteConcurrency = Math.min(
            settings.objectWriteConcurrency,
            ...tasks.map((task) => task.settings.objectWriteConcurrency)
          );
          resourceBudgets.update({
            generatedObjectWrite: objectWriteConcurrency,
            projectionPartition: batchConcurrency,
            databaseMutation: batchConcurrency
          });
          const processTask = createProjectionRepairTaskProcessor({
            work,
            builds,
            shards,
            catalog,
            references,
            immutableObjects,
            validation,
            generations,
            directoryLimits: {
              maxEntries: snapshot.publication.directoryIndexMaxEntries,
              maxBytes: snapshot.publication.directoryIndexMaxBytes
            },
            validationIssueLimit: 50,
            leaseTtlMs: snapshot.worker.lockTtlSeconds * 1_000,
            retryDelayMs: snapshot.maintenance.retryDelayMs,
            logger
          });
          await runClaimedBatch({
            tasks,
            workerId,
            roleJobs,
            work,
            processTask,
            taskBudget: resourceBudgets.projectionPartition,
            heartbeatIntervalMs: snapshot.worker.heartbeatIntervalMs,
            leaseTtlMs: snapshot.worker.lockTtlSeconds * 1_000
          });
        } catch (error) {
          logger.error(
            "Projection repair worker iteration failed",
            { code: "PROJECTION_REPAIR_WORKER_ITERATION_FAILED" },
            error
          );
          await sleep(lastValidSnapshot.worker.pollIntervalMs, abort.signal);
        }
      }
    } finally {
      await roleJobs.removeHeartbeat({ workerId }).catch(() => undefined);
      logger.info("Projection repair worker stopped", { workerId });
    }
  } finally {
    if (redisConnected) await redisClient.close();
    await closeDatabaseClient(sql);
  }
}

async function runClaimedBatch(input: {
  tasks: Awaited<ReturnType<ReturnType<typeof createPostgresProjectionRepairWorkRepository>["claimBatch"]>>;
  workerId: string;
  roleJobs: ReturnType<typeof createPostgresRoleJobRepository>;
  work: ReturnType<typeof createPostgresProjectionRepairWorkRepository>;
  processTask: ReturnType<typeof createProjectionRepairTaskProcessor>;
  taskBudget: ReturnType<typeof createProcessResourceBudgets>["projectionPartition"];
  heartbeatIntervalMs: number;
  leaseTtlMs: number;
}): Promise<void> {
  const heartbeat = async () => {
    const heartbeatAt = new Date();
    await Promise.all([
      heartbeatRole(
        input.roleJobs,
        input.workerId,
        input.tasks.map((task) => task.id),
        heartbeatAt.toISOString()
      ),
      ...input.tasks.map((task) =>
        input.work.heartbeat({
          task,
          heartbeatAt: heartbeatAt.toISOString(),
          leaseExpiresAt: new Date(
            heartbeatAt.getTime() + input.leaseTtlMs
          ).toISOString()
        })
      )
    ]);
  };
  await heartbeat();
  const timer = setInterval(() => {
    void heartbeat().catch(() => undefined);
  }, input.heartbeatIntervalMs);
  timer.unref();
  try {
    await Promise.all(
      input.tasks.map((task) =>
        input.taskBudget.run(() => input.processTask(task))
      )
    );
  } finally {
    clearInterval(timer);
    await heartbeatRole(input.roleJobs, input.workerId, []);
  }
}

async function heartbeatRole(
  roleJobs: ReturnType<typeof createPostgresRoleJobRepository>,
  workerId: string,
  taskIds: string[],
  now = new Date().toISOString()
): Promise<void> {
  await roleJobs.heartbeat({
    role: "projection_repair",
    workerId,
    jobIds: taskIds,
    now
  });
}

async function readSettingsRevision(
  sql: ReturnType<typeof createDatabaseClient>
): Promise<number> {
  const rows = await sql<Array<{ revision: number }>>`
    SELECT coalesce(max(version), 0)::int AS revision
    FROM focowiki.runtime_settings
  `;
  return Number(rows[0]?.revision ?? 0);
}

async function runHealthcheck(): Promise<void> {
  const sql = createDatabaseClient(config, { role: "projection-repair-worker" });
  const redisClient = createRedisClient(config);
  const storage = createS3StorageAdapter(config.storage);
  let redisConnected = false;
  try {
    await assertRuntimeSchemaGeneration(sql);
    await sql`
      SELECT
        (SELECT count(*) FROM focowiki.knowledge_base_projection_repairs) AS repair_count,
        (SELECT count(*) FROM focowiki.projection_repair_subtasks) AS subtask_count
    `;
    await redisClient.connect();
    redisConnected = true;
    await redisClient.ping();
    await storage.checkHealth?.();
  } finally {
    if (redisConnected) await redisClient.close();
    await closeDatabaseClient(sql);
  }
}

async function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
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
