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
import { createPostgresGenerationObjectReferenceRepository } from "./infrastructure/postgres/generation-object-reference-repository.js";
import { createPostgresImmutableObjectRepository } from "./infrastructure/postgres/immutable-object-repository.js";
import { createPostgresIncrementalStatisticsRepository } from "./infrastructure/postgres/incremental-statistics-repository.js";
import { createPostgresOptimizationMigrationRepository } from "./infrastructure/postgres/optimization-migration-repository.js";
import { createPostgresProjectionCatalogRepository } from "./infrastructure/postgres/projection-catalog-repository.js";
import { createPostgresProjectionCompactionRepository } from "./infrastructure/postgres/projection-compaction-repository.js";
import { createPostgresProjectionRecordRepository } from "./infrastructure/postgres/projection-record-repository.js";
import { createPostgresProjectionRepairRepository } from "./infrastructure/postgres/projection-repair-repository.js";
import { createPostgresProjectionSegmentRepository } from "./infrastructure/postgres/projection-segment-repository.js";
import { createPostgresPublicationGenerationRepository } from "./infrastructure/postgres/publication-generation-repository.js";
import { createPostgresPublicationValidationRepository } from "./infrastructure/postgres/publication-validation-repository.js";
import { createPostgresRoleJobRepository } from "./infrastructure/postgres/role-job-repository.js";
import {
  createPostgresRuntimePressureRepository,
  RUNTIME_PRESSURE_RECONCILIATION_INTERVAL_SECONDS
} from "./infrastructure/postgres/runtime-pressure-repository.js";
import { createPostgresStorageReconciliationRepository } from "./infrastructure/postgres/storage-reconciliation-repository.js";
import { createRuntimeLogger } from "./logger.js";
import { runImmutableWriteRecoverySlice } from "./maintenance/immutable-write-recovery.js";
import { runIncrementalStatisticsReconciliationSlice } from "./maintenance/incremental-statistics-reconciliation.js";
import { runProjectionRepairSlice } from "./maintenance/projection-repair.js";
import { runProjectionCompactionSlice } from "./maintenance/projection-compaction.js";
import { runMaintenanceBackground } from "./maintenance/runtime.js";
import { runOptimizationMigrationSlice } from "./maintenance/optimization-migration.js";
import { runStorageReconciliationSlice } from "./maintenance/storage-reconciliation.js";
import { createImmutableObjectWriter } from "./publication/immutable-object-writer.js";
import { createProjectionCatalogWriter } from "./publication/projection-catalog-writer.js";
import { createProjectionSegmentWriter } from "./publication/projection-segment-writer.js";
import { INCREMENTAL_PUBLICATION_DEFAULTS } from "./publication/incremental-defaults.js";
import { createRedisClient, createRedisCoordinator } from "./redis/coordination.js";
import { createResilientRedisCoordinator } from "./redis/resilient-coordinator.js";
import { registerWorkerRedisRuntimeEvents } from "./redis/worker-runtime.js";
import { createRuntimeSettingsService } from "./runtime-settings/service.js";
import { resolveResourceBudgetLimits } from "./runtime-settings/resource-budget-settings.js";
import { createProcessResourceBudgets } from "./runtime/resource-budget.js";
import { createResourceBudgetReporter } from "./runtime/resource-budget-reporter.js";
import { createS3StorageAdapter } from "./storage/s3.js";
import {
  createGarbageCollectionJobProcessor,
  runGarbageCollectionSlice
} from "./worker/garbage-collection-jobs.js";
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
    const authoritativeRedis = createRedisCoordinator(redisClient);
    const redis = createResilientRedisCoordinator({
      client: redisClient,
      coordinator: authoritativeRedis,
      sessionWrites: "best_effort"
    });
    const repositories = createPostgresAdminRepositories(sql);
    if (!repositories.runtimeSettings) {
      throw new Error("Runtime settings repository is unavailable");
    }
    if (!repositories.graph) {
      throw new Error("File graph repository is unavailable");
    }
    const graph = repositories.graph;
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
    const cleanup = createPostgresGenerationCleanupRepository(sql);
    const storage = createS3StorageAdapter(config.storage);
    const immutableRepository = createPostgresImmutableObjectRepository(sql);
    const unboundedImmutableObjects = createImmutableObjectWriter({
      repository: immutableRepository,
      storage
    });
    const immutableObjects = {
      write(object: Parameters<typeof unboundedImmutableObjects.write>[0]) {
        return resourceBudgets.generatedObjectWrite.run(
          () => unboundedImmutableObjects.write(object)
        );
      }
    };
    const references = createPostgresGenerationObjectReferenceRepository(sql);
    const records = createPostgresProjectionRecordRepository(sql);
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
    const repair = createPostgresProjectionRepairRepository(sql);
    const compaction = createPostgresProjectionCompactionRepository(sql);
    const reconciliation = createPostgresStorageReconciliationRepository(sql);
    const generations = createPostgresPublicationGenerationRepository(sql);
    const validation = createPostgresPublicationValidationRepository(sql);
    const optimizationMigrations = createPostgresOptimizationMigrationRepository(sql);
    const incrementalStatistics = createPostgresIncrementalStatisticsRepository(sql);
    const runtimePressure = createPostgresRuntimePressureRepository(sql);
    const runtime = createRoleWorkerRuntime({
      role: "maintenance",
      workerId: `maintenance-worker-${randomUUID()}`,
      repository: createPostgresRoleJobRepository(sql),
      async settings() {
        const snapshot = await runtimeSettings.getSnapshot();
        resourceBudgets.update(resolveResourceBudgetLimits(snapshot));
        const worker = snapshot.worker;
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
    const maintenanceOwner = `maintenance-sweep-${randomUUID()}`;
    const repairLeaseToken = `projection-repair-${randomUUID()}`;
    const reconciliationLeaseToken = `storage-reconciliation-${randomUUID()}`;
    const optimizationMigrationLeaseToken = `optimization-migration-${randomUUID()}`;
    const statisticsLeaseToken = `incremental-statistics-${randomUUID()}`;
    await Promise.all([
      runtime.run(abort.signal),
      runMaintenanceBackground({
        logger,
        async pollIntervalMs() {
          return (await runtimeSettings.getSnapshot()).worker.pollIntervalMs;
        },
        async runSweep() {
          let redisLock = false;
          try {
            redisLock = await authoritativeRedis.acquireLock(
              "maintenance-sweep",
              "global",
              maintenanceOwner,
              60
            );
            if (!redisLock) {
              return {
                repairPhase: "contended",
                recovered: 0,
                reconciliationPhase: "contended",
                reconciliationScanned: 0,
                reconciliationDeleted: 0,
                reconciliationVerified: 0,
                reconciliationFailed: 0,
                migrationPhase: "contended",
                migrationProcessed: 0,
                migrationCompleted: false,
                migrationFailed: false,
                statisticsClaimed: false,
                statisticsChanged: false,
                statisticsFailed: false,
                pressureReconciled: false,
                compactionDiscovered: 0,
                compactionClaimed: 0,
                compactionCompleted: 0,
                compactionSuperseded: 0,
                compactionFailed: 0,
                garbageCollectionExpired: 0,
                garbageCollectionDeleted: 0,
                garbageCollectionPending: false
              };
            }
          } catch {
            redisLock = false;
          }
          try {
            const snapshot = await runtimeSettings.getSnapshot();
            resourceBudgets.update(resolveResourceBudgetLimits(snapshot));
            resourceBudgetReporter.report(resourceBudgets);
            const migrationNow = new Date();
            const migrationResult = await resourceBudgets.migrationBackfill.run(
              () => runOptimizationMigrationSlice({
                repository: optimizationMigrations,
                storage,
                graph,
                workerId: maintenanceOwner,
                leaseToken: optimizationMigrationLeaseToken,
                now: migrationNow.toISOString(),
                leaseExpiresAt: new Date(
                  migrationNow.getTime() + snapshot.worker.lockTtlSeconds * 1_000
                ).toISOString(),
                batchSize: snapshot.maintenance.scanBatchSize,
                sourceReadConcurrency: Math.min(
                  snapshot.maintenance.migrationBackfillConcurrency,
                  snapshot.maintenance.scanBatchSize
                ),
                onUnexpectedError(error, context) {
                  logger.error(
                    "Optimization migration slice failed",
                    { code: "MIGRATION_SLICE_FAILED", ...context },
                    error
                  );
                }
              })
            );
            const statisticsNow = new Date();
            const statisticsResult = await runIncrementalStatisticsReconciliationSlice({
              repository: incrementalStatistics,
              workerId: maintenanceOwner,
              leaseToken: statisticsLeaseToken,
              now: statisticsNow.toISOString(),
              leaseExpiresAt: new Date(
                statisticsNow.getTime() + snapshot.worker.lockTtlSeconds * 1_000
              ).toISOString(),
              reconciledBefore: new Date(
                statisticsNow.getTime() - snapshot.maintenance.scanIntervalSeconds * 1_000
              ).toISOString()
            });
            const pressureResult = await runtimePressure.reconcileIfDue({
              now: statisticsNow.toISOString(),
              intervalSeconds: RUNTIME_PRESSURE_RECONCILIATION_INTERVAL_SECONDS
            });
            const compactionResult = await runProjectionCompactionSlice({
              repository: compaction,
              immutableObjects,
              budget: resourceBudgets.compaction,
              workerId: maintenanceOwner,
              concurrency: snapshot.maintenance.compactionConcurrency,
              partitionScanLimit: snapshot.maintenance.scanBatchSize,
              recordPageSize: snapshot.maintenance.scanBatchSize,
              maxAttempts: snapshot.maintenance.maxAttempts,
              retryDelayMs: snapshot.maintenance.retryDelayMs,
              lockTtlSeconds: snapshot.worker.lockTtlSeconds
            });
            const repairResult = await runProjectionRepairSlice({
              repair,
              records,
              shards,
              references,
              immutableObjects,
              catalog,
              validation,
              generations,
              repairVersion: 1,
              leaseToken: repairLeaseToken,
              treePageSize: snapshot.maintenance.scanBatchSize,
              maxAttempts: snapshot.maintenance.maxAttempts,
              retryDelayMs: snapshot.maintenance.retryDelayMs,
              validationIssueLimit: 50
            });
            const recoveryResult = await runImmutableWriteRecoverySlice({
              repository: immutableRepository,
              storage,
              batchSize: snapshot.maintenance.scanBatchSize
            });
            const garbageCollectionResult = await resourceBudgets.generatedObjectWrite.run(
              () => runGarbageCollectionSlice({
                cleanup,
                storage,
                jobId: "maintenance-garbage-collection",
                batchSize: snapshot.worker.retentionCleanupBatchSize,
                retentionDays: snapshot.publication.generationRetentionDays,
                versionPurgeEnabled: snapshot.worker.hardDeleteVersionPurgeEnabled,
                now: new Date()
              })
            );
            const reconciliationResult = await runStorageReconciliationSlice({
              repository: reconciliation,
              storage,
              settings: snapshot.maintenance,
              versionPurgeEnabled: snapshot.worker.hardDeleteVersionPurgeEnabled,
              leaseToken: reconciliationLeaseToken
            });
            return {
              repairPhase: repairResult.phase,
              recovered: recoveryResult.activated + recoveryResult.expired,
              reconciliationPhase: reconciliationResult.phase,
              reconciliationScanned: reconciliationResult.scanned,
              reconciliationDeleted: reconciliationResult.deleted,
              reconciliationVerified: reconciliationResult.verified,
              reconciliationFailed: reconciliationResult.failed,
              migrationPhase: migrationResult.phase,
              migrationProcessed: migrationResult.processed,
              migrationCompleted: migrationResult.completed,
              migrationFailed: migrationResult.failed,
              statisticsClaimed: statisticsResult.claimed,
              statisticsChanged: statisticsResult.changed,
              statisticsFailed: statisticsResult.failed,
              pressureReconciled: pressureResult.reconciled,
              compactionDiscovered: compactionResult.discovered,
              compactionClaimed: compactionResult.claimed,
              compactionCompleted: compactionResult.completed,
              compactionSuperseded: compactionResult.superseded,
              compactionFailed: compactionResult.failed,
              garbageCollectionExpired: garbageCollectionResult.expiredGenerations,
              garbageCollectionDeleted: garbageCollectionResult.deletedObjects,
              garbageCollectionPending: garbageCollectionResult.hasMore
            };
          } finally {
            if (redisLock) {
              await authoritativeRedis.releaseLock(
                "maintenance-sweep",
                "global",
                maintenanceOwner
              ).catch(() => false);
            }
          }
        }
      }, abort.signal)
    ]);
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
    await sql`
      SELECT
        (SELECT count(*) FROM focowiki.role_jobs WHERE role = 'maintenance') AS role_job_count,
        (SELECT count(*) FROM focowiki.knowledge_base_projection_repairs) AS repair_count,
        (SELECT count(*) FROM focowiki.storage_reconciliation_cycles) AS reconciliation_count
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

function loadLocalEnvFile(): void {
  if (process.env.ENV_FILE) {
    loadEnvFile(process.env.ENV_FILE);
    return;
  }
  const candidates = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")];
  const envFile = candidates.find((candidate) => existsSync(candidate));
  if (envFile) loadEnvFile(envFile);
}
