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
import { createPostgresImmutableObjectRepository } from "./infrastructure/postgres/immutable-object-repository.js";
import { createPostgresIncrementalStatisticsRepository } from "./infrastructure/postgres/incremental-statistics-repository.js";
import {
  createPostgresKnowledgeBaseIndexMaintenanceRepository
} from "./infrastructure/postgres/knowledge-base-index-maintenance-repository.js";
import { createPostgresLexicalRebuildRepository } from "./infrastructure/postgres/lexical-rebuild-repository.js";
import { createPostgresMaintenanceProgressRepository } from "./infrastructure/postgres/maintenance-progress-repository.js";
import { createMeilisearchTransport } from "./infrastructure/meilisearch/meilisearch-transport.js";
import {
  createPostgresSearchProjectionDocumentRepository
} from "./infrastructure/postgres/search-projection-document-repository.js";
import {
  createPostgresSearchProjectionStateRepository
} from "./infrastructure/postgres/search-projection-state-repository.js";
import { createPostgresOptimizationMigrationRepository } from "./infrastructure/postgres/optimization-migration-repository.js";
import { createPostgresProjectionCompactionRepository } from "./infrastructure/postgres/projection-compaction-repository.js";
import {
  createPostgresProjectionRepairWorkRepository
} from "./infrastructure/postgres/projection-repair-work-repository.js";
import { createPostgresRoleJobRepository } from "./infrastructure/postgres/role-job-repository.js";
import {
  createPostgresRuntimePressureRepository,
  RUNTIME_PRESSURE_RECONCILIATION_INTERVAL_SECONDS
} from "./infrastructure/postgres/runtime-pressure-repository.js";
import { createPostgresStorageReconciliationRepository } from "./infrastructure/postgres/storage-reconciliation-repository.js";
import { createPostgresObjectProtectionRepository } from "./infrastructure/postgres/object-protection-repository.js";
import { createUploadSessionStoragePort } from "./infrastructure/storage/upload-session-storage.js";
import {
  assertNodeJiebaRuntimeAvailable,
  createNodeJiebaTokenizer,
  getNodeJiebaRuntimeEvidence
} from "./infrastructure/tokenization/nodejieba-tokenizer.js";
import { createRuntimeLogger } from "./logger.js";
import { runImmutableWriteRecoverySlice } from "./maintenance/immutable-write-recovery.js";
import { runIncrementalStatisticsReconciliationSlice } from "./maintenance/incremental-statistics-reconciliation.js";
import { runProjectionCompactionSlice } from "./maintenance/projection-compaction.js";
import { runMaintenanceBackground } from "./maintenance/runtime.js";
import { runOptimizationMigrationSlice } from "./maintenance/optimization-migration.js";
import { bootstrapLexicalRebuildWork } from "./maintenance/lexical-rebuild-bootstrap.js";
import {
  KnowledgeBaseIndexMaintenanceExecutionError,
  runKnowledgeBaseIndexMaintenanceSlice
} from "./maintenance/knowledge-base-index-maintenance.js";
import {
  CURRENT_PROJECTION_REPAIR_PLANNER_VERSION,
  CURRENT_PROJECTION_REPAIR_VERSION
} from "./maintenance/projection-repair-plan.js";
import { runStorageReconciliationSlice } from "./maintenance/storage-reconciliation.js";
import {
  createMaintenanceReconciliationTelemetry
} from "./maintenance/reconciliation-telemetry.js";
import { runObjectProtectionMaintenanceSlice } from "./maintenance/object-protection-maintenance.js";
import { runUploadSessionExpirationSlice } from "./maintenance/upload-session-expiration.js";
import { createImmutableObjectWriter } from "./publication/immutable-object-writer.js";
import { createRedisClient, createRedisCoordinator } from "./redis/coordination.js";
import { createResilientRedisCoordinator } from "./redis/resilient-coordinator.js";
import { registerWorkerRedisRuntimeEvents } from "./redis/worker-runtime.js";
import { createRuntimeSettingsService } from "./runtime-settings/service.js";
import { resolveResourceBudgetLimits } from "./runtime-settings/resource-budget-settings.js";
import {
  activeSearchProjectionNeedsRebuild
} from "./search/active-search-projection-health.js";
import { createSearchProjectionContract } from "./search/index-definitions.js";
import {
  createSearchProjectionCleanup
} from "./search/search-projection-cleanup.js";
import {
  ensureSearchProjectionWork
} from "./search/search-indexing-coordinator.js";
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
    const tokenizer = createNodeJiebaTokenizer();
    logger.info("Lexical tokenizer initialized", getNodeJiebaRuntimeEvidence());
    const repositories = createPostgresAdminRepositories(sql, { tokenizer });
    if (!repositories.runtimeSettings) {
      throw new Error("Runtime settings repository is unavailable");
    }
    if (!repositories.graph) {
      throw new Error("File graph repository is unavailable");
    }
    if (!repositories.uploadSessions) {
      throw new Error("Upload session repository is unavailable");
    }
    const graph = repositories.graph;
    const runtimeSettings = createRuntimeSettingsService({
      config,
      repository: repositories.runtimeSettings,
      redis
    });
    await runtimeSettings.ensureBootstrapped();
    if (!config.search) {
      throw new Error("Search service configuration is unavailable");
    }
    const searchConfig = config.search;
    const searchTransport = createMeilisearchTransport({
      endpoint: searchConfig.endpoint,
      apiKey: searchConfig.apiKey,
      timeoutMs: 30_000,
      maxAttempts: 2,
      retryDelayMs: 250
    });
    const initialSnapshot = await runtimeSettings.getSnapshot();
    const resourceBudgets = createProcessResourceBudgets(
      resolveResourceBudgetLimits(initialSnapshot)
    );
    const resourceBudgetReporter = createResourceBudgetReporter({ logger });
    const cleanup = createPostgresGenerationCleanupRepository(sql);
    const storage = createS3StorageAdapter(config.storage);
    const uploadSessionStorage = createUploadSessionStoragePort(storage);
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
    const compaction = createPostgresProjectionCompactionRepository(sql);
    const reconciliation = createPostgresStorageReconciliationRepository(sql);
    const objectProtection = createPostgresObjectProtectionRepository(sql);
    const optimizationMigrations = createPostgresOptimizationMigrationRepository(sql);
    const lexicalRebuilds = createPostgresLexicalRebuildRepository(sql);
    const incrementalStatistics = createPostgresIncrementalStatisticsRepository(sql);
    const indexMaintenance =
      createPostgresKnowledgeBaseIndexMaintenanceRepository(sql);
    const maintenanceProgress = createPostgresMaintenanceProgressRepository(sql);
    const searchStates = createPostgresSearchProjectionStateRepository(sql);
    const searchDocuments = createPostgresSearchProjectionDocumentRepository(sql);
    const projectionRepairs = createPostgresProjectionRepairWorkRepository(sql);
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
          const snapshot = await runtimeSettings.getSnapshot();
          const worker = snapshot.worker;
          await createHardDeleteJobProcessor({
            cleanup,
            storage,
            redis,
            search: createSearchProjectionCleanup({
              transport: searchTransport,
              states: searchStates,
              indexPrefix: searchConfig.indexPrefix,
              taskPollIntervalMs: snapshot.search.taskPollIntervalMs,
              taskTimeoutMs: snapshot.search.taskTimeoutMs
            }),
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
    const reconciliationLeaseToken = `storage-reconciliation-${randomUUID()}`;
    const reconciliationTelemetry = createMaintenanceReconciliationTelemetry(logger);
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
                objectProtectionPhase: "contended",
                objectProtectionProcessed: 0,
                objectProtectionCompleted: false,
                objectProtectionFailed: false,
                migrationPhase: "contended",
                migrationProcessed: 0,
                migrationCompleted: false,
                migrationFailed: false,
                lexicalRebuildPhase: "contended",
                lexicalRebuildProcessed: 0,
                lexicalRebuildCompleted: false,
                lexicalRebuildFailed: false,
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
                garbageCollectionPending: false,
                uploadSessionsExpired: 0,
                uploadSessionObjectsDeleted: 0
              };
            }
          } catch {
            redisLock = false;
          }
          try {
            const snapshot = await runtimeSettings.getSnapshot();
            resourceBudgets.update(resolveResourceBudgetLimits(snapshot));
            resourceBudgetReporter.report(resourceBudgets);
            const uploadExpirationResult = await resourceBudgets.generatedObjectWrite.run(
              () => runUploadSessionExpirationSlice({
                repository: repositories.uploadSessions!,
                storage: uploadSessionStorage,
                now: new Date().toISOString(),
                limit: snapshot.maintenance.scanBatchSize
              })
            );
            const migrationNow = new Date();
            const migrationResult = await resourceBudgets.migrationBackfill.run(
              () => runOptimizationMigrationSlice({
                repository: optimizationMigrations,
                storage,
                graph,
                tokenizer,
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
            let lexicalScheduled = 0;
            let statisticsResult = {
              claimed: false,
              changed: false,
              failed: false
            };
            let compactionResult = {
              discovered: 0,
              claimed: 0,
              completed: 0,
              superseded: 0,
              failed: 0
            };
            await runKnowledgeBaseIndexMaintenanceSlice({
              requests: indexMaintenance,
              progress: maintenanceProgress,
              runtimeSettings,
              workerId: maintenanceOwner,
              leaseTtlSeconds: snapshot.worker.lockTtlSeconds,
              async schedule({ request, now }) {
                const requestSnapshot = await runtimeSettings.getSnapshot();
                const projectionSettings = {
                  concurrency: requestSnapshot.maintenance.projectionRepairConcurrency,
                  databaseBatchSize:
                    requestSnapshot.maintenance.projectionRepairDatabaseBatchSize,
                  objectWriteConcurrency:
                    requestSnapshot.maintenance.projectionRepairObjectWriteConcurrency
                };
                await projectionRepairs.bootstrap({
                  repairVersion: CURRENT_PROJECTION_REPAIR_VERSION,
                  plannerVersion: CURRENT_PROJECTION_REPAIR_PLANNER_VERSION,
                  settingsRevision: request.settingsRevision,
                  settings: projectionSettings,
                  maxAttempts: requestSnapshot.maintenance.maxAttempts,
                  now,
                  knowledgeBaseIds: [request.knowledgeBaseId],
                  requireActiveMaintenanceRequest: true
                });
                lexicalScheduled += await bootstrapLexicalRebuildWork({
                  rebuilds: lexicalRebuilds,
                  tokenizer,
                  now,
                  knowledgeBaseIds: [request.knowledgeBaseId]
                });
                const searchState = await searchStates.getState(
                  request.knowledgeBaseId
                );
                if (searchState?.activeGenerationId) {
                  const forceFullRebuild =
                    searchState.routeState === "meilisearch"
                    && await activeSearchProjectionNeedsRebuild({
                      transport: searchTransport,
                      indexPrefix: searchConfig.indexPrefix,
                      knowledgeBaseId: request.knowledgeBaseId,
                      activeEpoch: searchState.activeEpoch,
                      searchCutoffMs:
                        requestSnapshot.search.engineSearchCutoffMs,
                      pollIntervalMs:
                        requestSnapshot.search.taskPollIntervalMs,
                      taskTimeoutMs:
                        requestSnapshot.search.taskTimeoutMs
                    });
                  const searchResult = await ensureSearchProjectionWork({
                    states: searchStates,
                    documents: searchDocuments,
                    knowledgeBaseId: request.knowledgeBaseId,
                    generationId: searchState.activeGenerationId,
                    maintenanceRequestId: request.id,
                    forceCompatibilityCutover: true,
                    forceFullRebuild,
                    scanBatchSize:
                      requestSnapshot.search.indexBatchDocumentCount,
                    indexBatchDocumentCount:
                      requestSnapshot.search.indexBatchDocumentCount,
                    indexBatchCompressedBytes:
                      requestSnapshot.search.indexBatchCompressedBytes,
                    maxAttempts: requestSnapshot.search.maxAttempts,
                    contract: createSearchProjectionContract({
                      searchCutoffMs:
                        requestSnapshot.search.engineSearchCutoffMs
                    }),
                    now
                  });
                  if (searchResult.status === "failed") {
                    throw new KnowledgeBaseIndexMaintenanceExecutionError(
                      "INDEX_MAINTENANCE_SEARCH_FAILED",
                      "Knowledge-base search maintenance could not complete"
                    );
                  }
                }
                const statisticsNow = new Date(now);
                const currentStatistics =
                  await runIncrementalStatisticsReconciliationSlice({
                    repository: incrementalStatistics,
                    workerId: maintenanceOwner,
                    leaseToken:
                      `${statisticsLeaseToken}-${request.knowledgeBaseId}`,
                    now,
                    leaseExpiresAt: new Date(
                      statisticsNow.getTime()
                        + requestSnapshot.worker.lockTtlSeconds * 1_000
                    ).toISOString(),
                    reconciledBefore: now,
                    knowledgeBaseId: request.knowledgeBaseId
                  });
                statisticsResult = {
                  claimed: statisticsResult.claimed || currentStatistics.claimed,
                  changed: statisticsResult.changed || currentStatistics.changed,
                  failed: statisticsResult.failed || currentStatistics.failed
                };
                if (currentStatistics.failed) {
                  throw new KnowledgeBaseIndexMaintenanceExecutionError(
                    "INDEX_MAINTENANCE_STATISTICS_FAILED",
                    "Knowledge-base statistics maintenance could not complete"
                  );
                }
                const currentCompaction = await runProjectionCompactionSlice({
                  repository: compaction,
                  immutableObjects,
                  budget: resourceBudgets.compaction,
                  workerId: maintenanceOwner,
                  concurrency: requestSnapshot.maintenance.compactionConcurrency,
                  partitionScanLimit: requestSnapshot.maintenance.scanBatchSize,
                  recordPageSize: requestSnapshot.maintenance.scanBatchSize,
                  maxAttempts: requestSnapshot.maintenance.maxAttempts,
                  retryDelayMs: requestSnapshot.maintenance.retryDelayMs,
                  lockTtlSeconds: requestSnapshot.worker.lockTtlSeconds,
                  knowledgeBaseIds: [request.knowledgeBaseId]
                });
                compactionResult = {
                  discovered: compactionResult.discovered + currentCompaction.discovered,
                  claimed: compactionResult.claimed + currentCompaction.claimed,
                  completed: compactionResult.completed + currentCompaction.completed,
                  superseded: compactionResult.superseded + currentCompaction.superseded,
                  failed: compactionResult.failed + currentCompaction.failed
                };
                if (currentCompaction.failed > 0) {
                  throw new KnowledgeBaseIndexMaintenanceExecutionError(
                    "INDEX_MAINTENANCE_COMPACTION_FAILED",
                    "Knowledge-base projection compaction could not complete"
                  );
                }
              }
            });
            const statisticsNow = new Date();
            const pressureResult = await runtimePressure.reconcileIfDue({
              now: statisticsNow.toISOString(),
              intervalSeconds: RUNTIME_PRESSURE_RECONCILIATION_INTERVAL_SECONDS
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
            const objectProtectionResult = await resourceBudgets.migrationBackfill.run(
              () => runObjectProtectionMaintenanceSlice({
                repository: objectProtection,
                batchSize: Math.min(snapshot.maintenance.scanBatchSize, 1_000)
              })
            );
            const reconciliationResult = await runStorageReconciliationSlice({
              repository: reconciliation,
              storage,
              settings: snapshot.maintenance,
              versionPurgeEnabled: snapshot.worker.hardDeleteVersionPurgeEnabled,
              leaseToken: reconciliationLeaseToken
            });
            const shouldReadReconciliationStatus =
              objectProtectionResult.claimed
              || objectProtectionResult.failed
              || reconciliationResult.claimed
              || reconciliationResult.failed > 0;
            const [reconciliationStatus, objectProtectionStatus] =
              shouldReadReconciliationStatus
                ? await Promise.all([
                    reconciliation.getStatus(`${storage.keyspace.prefix}/generated/`),
                    objectProtection.getStatus()
                  ])
                : [null, null];
            reconciliationTelemetry.record({
              reconciliation: {
                result: reconciliationResult,
                status: reconciliationStatus
              },
              protection: {
                result: objectProtectionResult,
                status: objectProtectionStatus
              }
            });
            return {
              repairPhase: "isolated",
              recovered: recoveryResult.activated + recoveryResult.expired,
              reconciliationPhase: reconciliationResult.phase,
              reconciliationScanned: reconciliationResult.scanned,
              reconciliationDeleted: reconciliationResult.deleted,
              reconciliationVerified: reconciliationResult.verified,
              reconciliationFailed: reconciliationResult.failed,
              objectProtectionPhase: objectProtectionResult.phase,
              objectProtectionProcessed: objectProtectionResult.processed,
              objectProtectionCompleted: objectProtectionResult.completed,
              objectProtectionFailed: objectProtectionResult.failed,
              migrationPhase: migrationResult.phase,
              migrationProcessed: migrationResult.processed,
              migrationCompleted: migrationResult.completed,
              migrationFailed: migrationResult.failed,
              lexicalRebuildPhase: lexicalScheduled > 0 ? "scheduled" : "delegated",
              lexicalRebuildProcessed: 0,
              lexicalRebuildCompleted: false,
              lexicalRebuildFailed: false,
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
              garbageCollectionPending: garbageCollectionResult.hasMore,
              uploadSessionsExpired: uploadExpirationResult.expiredSessions,
              uploadSessionObjectsDeleted: uploadExpirationResult.deletedObjects
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
    assertNodeJiebaRuntimeAvailable();
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
    if (!config.search) {
      throw new Error("Search service configuration is unavailable");
    }
    const search = createMeilisearchTransport({
      endpoint: config.search.endpoint,
      apiKey: config.search.apiKey,
      timeoutMs: 5_000,
      maxAttempts: 1,
      retryDelayMs: 0
    });
    if (!(await search.health()).available) {
      throw new Error("Search service is unavailable");
    }
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
