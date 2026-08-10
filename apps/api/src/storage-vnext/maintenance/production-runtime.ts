import { S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { getHeapStatistics } from "node:v8";
import type { SearchProviderRuntime } from
  "../../application/ports/search-provider-runtime.js";
import { resolveSecurityConfig, type RuntimeConfig } from "../../config.js";
import { closeDatabaseClient, createDatabaseClient } from "../../db/client.js";
import { assertRuntimeSchemaGeneration } from "../../db/migrations.js";
import { createRuntimeLogger } from "../../logger.js";
import {
  assertNodeJiebaRuntimeAvailable,
  createNodeJiebaTokenizer
} from "../../infrastructure/tokenization/nodejieba-tokenizer.js";
import { createRuntimeSearchProvider } from
  "../../runtime/search-provider.js";
import { createSemanticDeletionService } from
  "../../semantic/application/deletion-service.js";
import { createPostgresSemanticDeletionRepository } from
  "../../semantic/infrastructure/postgres-semantic-deletion-repository.js";
import { createSemanticAdoptionService } from
  "../../semantic/application/adoption.js";
import { createPostgresSemanticGenerationRepository } from
  "../../semantic/infrastructure/postgres-generation-repository.js";
import { createPostgresSemanticStageRepository } from
  "../../semantic/infrastructure/postgres-stage-repository.js";
import { createSemanticProviderAdoptionService } from
  "../../semantic/application/provider-adoption.js";
import { createPostgresSemanticProviderAdoptionRepository } from
  "../../semantic/infrastructure/postgres-provider-adoption-repository.js";
import { createPostgresEmbeddingArtifactRepository } from
  "../../semantic/infrastructure/postgres-embedding-artifact-repository.js";
import { createS3EmbeddingArtifactStore } from
  "../../semantic/infrastructure/s3-embedding-artifact-store.js";
import {
  createRedisClient,
  createRedisCoordinator
} from "../../redis/coordination.js";
import { createResilientRedisCoordinator } from "../../redis/resilient-coordinator.js";
import { registerWorkerRedisRuntimeEvents } from "../../redis/worker-runtime.js";
import { createProcessResourceBudgets } from "../../runtime/resource-budget.js";
import { createResourceBudgetReporter } from
  "../../runtime/resource-budget-reporter.js";
import { createRuntimeSettingsRepository } from
  "../../runtime-settings/repository.js";
import { resolveResourceBudgetLimits } from
  "../../runtime-settings/resource-budget-settings.js";
import { createRuntimeSettingsService } from
  "../../runtime-settings/service.js";
import type { RuntimeSettingsSnapshot } from "../../runtime-settings/types.js";
import { createS3ClientConfig } from "../../storage/s3.js";
import { createPostgresStorageVnextCatalogRepository } from
  "../catalog/postgres-repository.js";
import { createPostgresStorageVnextCleanupActionRepository } from
  "../cleanup/postgres-cleanup-action-repository.js";
import { createS3StorageVnextSourceBodyStore } from
  "../catalog/s3-source-body-store.js";
import { createStorageVnextDeletionPurgeCoordinator } from
  "../deletion/deletion-purge.js";
import { createStorageVnextDeletionWorker } from
  "../deletion/deletion-worker.js";
import { createPostgresStorageVnextDeletionPurgeRepository } from
  "../deletion/postgres-purge.js";
import { createPostgresStorageVnextDeletionReleaseScope } from
  "../deletion/postgres-release-scope.js";
import { createStorageVnextDeletionProductionRelease } from
  "../deletion/production-release.js";
import { createStorageVnextUnifiedSearchDeletion } from
  "../deletion/unified-search-deletion.js";
import { createPostgresStorageVnextGraphRepository } from
  "../graph/postgres-repository.js";
import {
  createStorageVnextFailedWriteCompensator,
  createS3StorageVnextFailedWriteProvider
} from "../ownership/failed-write-compensation.js";
import { createStorageVnextImmutableObjectWriter } from
  "../ownership/immutable-object-writer.js";
import {
  createPostgresStorageVnextOwnershipRepository,
  purgePostgresStorageVnextDeletedRegistrations
} from
  "../ownership/postgres-repository.js";
import { createS3StorageVnextImmutableBodyStore } from
  "../ownership/s3-immutable-body-store.js";
import { createS3StorageVnextObjectInventory } from
  "../ownership/s3-object-inventory.js";
import {
  createS3StorageVnextVersionAwareDeletionProvider,
  createStorageVnextVersionAwareObjectDeletion
} from "../ownership/version-aware-deletion.js";
import { createPostgresStorageVnextEffectiveCatalog } from
  "../publication/effective-catalog.js";
import { createStorageVnextPublicationObjectValidator } from
  "../publication/object-validator.js";
import { createPostgresStorageVnextPublicationSnapshot } from
  "../publication/postgres-snapshot.js";
import { createStorageVnextProductionPublicationPipeline } from
  "../publication/production-pipeline.js";
import { createPostgresStorageVnextReleaseRepository } from
  "../release/postgres-repository.js";
import { createPostgresStorageVnextSearchCleanupRepository } from
  "../search/postgres-cleanup-repository.js";
import { createPostgresStorageVnextSearchProjectionRepository } from
  "../search/postgres-repository.js";
import { createPostgresStorageVnextSearchTerminalCleanup } from
  "../search/postgres-terminal-cleanup.js";
import { createPostgresStorageVnextActiveSearchProjectionRepository } from
  "../search/postgres-active-projection.js";
import { createPostgresStorageVnextSearchProviderAdoption } from
  "../search/postgres-provider-adoption.js";
import { createStorageVnextProviderIndexCleanupWorker } from
  "../search/provider-index-cleanup-worker.js";
import { createStorageVnextSearchCleanup } from
  "../search/search-cleanup.js";
import { createStorageVnextSearchSettings } from "../search/settings.js";
import {
  runStorageVnextRetentionSlice,
  STORAGE_VNEXT_RETENTION_INTERVAL_MS
} from "../retention/postgres-retention.js";
import { createPostgresStorageVnextWorkflowRepository } from
  "../workflow/postgres-repository.js";
import { createStorageVnextWebhookOutbox } from "../webhook/outbox.js";
import { createPostgresStorageVnextWebhookRepository } from
  "../webhook/postgres-repository.js";
import { createStorageVnextWebhookWorker } from "../webhook/worker.js";
import { createStorageVnextMaintenanceCoordinator } from
  "./maintenance-coordinator.js";
import { createStorageVnextMaintenanceRequestService } from
  "./maintenance-coordinator.js";
import { createStorageVnextAutomaticMaintenanceScheduler } from
  "./automatic-scheduler.js";
import { createStorageVnextMaintenanceObjectReconciliation } from
  "./object-reconciliation.js";
import { createPostgresStorageVnextMaintenanceRepository } from
  "./postgres-repository.js";
import { createPostgresStorageVnextAutomaticMaintenanceDue } from
  "./postgres-due.js";
import { createStorageVnextMaintenanceProductionCleanup } from
  "./production-cleanup.js";
import { createStorageVnextMaintenanceProductionPhases } from
  "./production-phases.js";
import {
  createPostgresStorageVnextMaintenanceOperationIdentity,
  createStorageVnextMaintenanceProductionPlanner
} from "./production-planner.js";
import { createStorageVnextMaintenanceResourceGate } from
  "./resource-gate.js";
import { createStorageVnextMaintenanceRebuildSnapshot } from
  "./rebuild-snapshot.js";
import { createStorageVnextZeroOwnerCleanup } from "./zero-owner-cleanup.js";
import { createStorageVnextMaintenanceCandidateObjectCleanup } from
  "./candidate-object-cleanup.js";
import { createStorageVnextCandidateObjectCleanupWorker } from
  "./candidate-object-cleanup-worker.js";
import { createPostgresStorageVnextCandidateObjectCleanupActionRepository } from
  "../cleanup/postgres-candidate-object-actions.js";

const MILLISECONDS_PER_DAY = 86_400_000;
const MILLISECONDS_PER_HOUR = 3_600_000;
const MAXIMUM_CLEANUP_PAGES = 100;
const FAILED_SEARCH_CANDIDATE_CLEANUP_ID =
  "maintenance-failed-search-candidate-cleanup";

function requireSemanticVectorPort(provider: SearchProviderRuntime | null) {
  if (!provider?.vector) {
    throw new Error("Semantic vector provider is required for maintenance");
  }
  return provider.vector;
}

export async function runStorageVnextMaintenanceWorker(
  config: RuntimeConfig
): Promise<void> {
  const searchConfig = config.search;
  if (!searchConfig) {
    throw new Error("Search configuration is required for the maintenance worker");
  }
  const productionConfig = { ...config, search: searchConfig };
  const logger = createRuntimeLogger(config, console, {
    streamName: "maintenance-worker"
  });
  const sql = createDatabaseClient(config, { role: "maintenance-worker" });
  const redisClient = createRedisClient(config);
  const s3 = new S3Client(createS3ClientConfig(config.storage));
  const abort = new AbortController();
  const stop = () => abort.abort(
    new DOMException("Maintenance worker shutting down", "AbortError")
  );
  let redisConnected = false;
  let searchProvider: SearchProviderRuntime | null = null;
  let searchProviderSettingsKey = "";
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);
  registerWorkerRedisRuntimeEvents({ client: redisClient, logger, role: "maintenance" });

  try {
    await assertRuntimeSchemaGeneration(sql);
    await redisClient.connect();
    redisConnected = true;
    const redis = createResilientRedisCoordinator({
      client: redisClient,
      coordinator: createRedisCoordinator(redisClient, {
        keyPrefix: config.redis.keyPrefix ?? "focowiki"
      }),
      sessionWrites: "best_effort"
    });
    const runtimeSettings = createRuntimeSettingsService({
      config,
      repository: createRuntimeSettingsRepository(sql),
      redis
    });
    await runtimeSettings.ensureBootstrapped();
    const initialSnapshot = await runtimeSettings.getSnapshot();
    assertNodeJiebaRuntimeAvailable();
    const tokenizer = createNodeJiebaTokenizer();
    let quarantineGraceMilliseconds =
      initialSnapshot.maintenance.quarantineGracePeriodSeconds * 1_000;
    const resourceBudgets = createProcessResourceBudgets(
      resolveResourceBudgetLimits(initialSnapshot)
    );
    const resourceBudgetReporter = createResourceBudgetReporter({ logger });
    const catalog = createPostgresStorageVnextCatalogRepository(sql);
    const graph = createPostgresStorageVnextGraphRepository(sql);
    const releases = createPostgresStorageVnextReleaseRepository(sql);
    const ownership = createPostgresStorageVnextOwnershipRepository(sql, {
      zeroOwnerGraceMilliseconds: () => quarantineGraceMilliseconds
    });
    const searchRepository = createPostgresStorageVnextSearchProjectionRepository(sql);
    const activeSearchProjections =
      createPostgresStorageVnextActiveSearchProjectionRepository(sql);
    const providerAdoption = createPostgresStorageVnextSearchProviderAdoption(sql, {
      selectedProviderKind: searchConfig.provider
    });
    const workflow = createPostgresStorageVnextWorkflowRepository(sql);
    const webhookRepository = createPostgresStorageVnextWebhookRepository(sql);
    const maintenanceRepository = createPostgresStorageVnextMaintenanceRepository(sql, {
      selectedSearchProviderKind: searchConfig.provider
    });
    const semanticAdoption = createSemanticAdoptionService({
      generations: createPostgresSemanticGenerationRepository(sql),
      stages: createPostgresSemanticStageRepository(sql),
      catalog
    });
    const semanticProviderAdoptionRepository =
      createPostgresSemanticProviderAdoptionRepository(sql);
    const embeddingArtifacts = createPostgresEmbeddingArtifactRepository(sql);
    const embeddingArtifactStore = createS3EmbeddingArtifactStore({
      client: s3,
      bucket: config.storage.bucket,
      prefix: config.storage.prefix
    });
    const sourceBodies = createS3StorageVnextSourceBodyStore({
      client: s3,
      bucket: config.storage.bucket,
      prefix: config.storage.prefix
    });
    const generatedBodies = createS3StorageVnextImmutableBodyStore({
      client: s3,
      bucket: config.storage.bucket,
      prefix: config.storage.prefix
    });
    const compensation = createStorageVnextFailedWriteCompensator({
      registrations: ownership,
      provider: createS3StorageVnextFailedWriteProvider({
        client: s3,
        bucket: config.storage.bucket,
        prefix: config.storage.prefix
      })
    });
    const unboundedObjects = createStorageVnextImmutableObjectWriter({
      registrations: ownership,
      bodyStore: generatedBodies,
      compensation,
      clock: now
    });
    const objects = {
      putVerified(request: Parameters<typeof unboundedObjects.putVerified>[0]) {
        return resourceBudgets.generatedObjectWrite.run(
          () => unboundedObjects.putVerified(request)
        );
      }
    };
    const objectValidator = createStorageVnextPublicationObjectValidator({
      registrations: ownership,
      bodyStore: generatedBodies
    });
    const effectiveCatalog = createPostgresStorageVnextEffectiveCatalog(sql);
    const publicationSnapshot = createPostgresStorageVnextPublicationSnapshot(sql, {
      objects: generatedBodies
    });
    const maintenanceRebuildSnapshot =
      createStorageVnextMaintenanceRebuildSnapshot(publicationSnapshot);
    const planner = createStorageVnextMaintenanceProductionPlanner({
      catalog,
      releases,
      operationIdentity: createPostgresStorageVnextMaintenanceOperationIdentity(sql),
      sourcePageSize: pageSize(config),
      directoryPageSize: pageSize(config),
      writeBatchSize: pageSize(config)
    });
    const objectInventory = createS3StorageVnextObjectInventory({
      client: s3,
      bucket: config.storage.bucket,
      prefix: config.storage.prefix
    });
    const objectDeletion = createStorageVnextVersionAwareObjectDeletion({
      registrations: ownership,
      provider: createS3StorageVnextVersionAwareDeletionProvider({
        client: s3,
        bucket: config.storage.bucket,
        prefix: config.storage.prefix
      })
    });
    const zeroOwnerCleanup = createStorageVnextZeroOwnerCleanup({
      registrations: ownership,
      objects: objectDeletion,
      purgeDeletedRegistrations: (request) =>
        purgePostgresStorageVnextDeletedRegistrations(sql, request)
    });
    const candidateObjectCleanup =
      createStorageVnextMaintenanceCandidateObjectCleanup({
        actions: createPostgresStorageVnextCandidateObjectCleanupActionRepository(sql),
        objects: objectDeletion,
        purgeDeletedRegistrations: (request) =>
          purgePostgresStorageVnextDeletedRegistrations(sql, request),
        pageSize: deletionBatchSize(initialSnapshot)
      });
    const cleanupActions = createPostgresStorageVnextCleanupActionRepository(sql);
    const candidateObjectCleanupWorker =
      createStorageVnextCandidateObjectCleanupWorker({
        actions: cleanupActions,
        objects: objectDeletion,
        purgeDeletedRegistrations: (request) =>
          purgePostgresStorageVnextDeletedRegistrations(sql, request)
      });
    const deletionScope = createPostgresStorageVnextDeletionReleaseScope(sql);
    const deletionPurgeRepository =
      createPostgresStorageVnextDeletionPurgeRepository(sql);
    const semanticDeletionRepository =
      createPostgresSemanticDeletionRepository(sql);
    const automaticMaintenance = createStorageVnextAutomaticMaintenanceScheduler({
      due: createPostgresStorageVnextAutomaticMaintenanceDue(sql, {
        selectedSearchProviderKind: searchConfig.provider
      }),
      requests: createStorageVnextMaintenanceRequestService({
        repository: maintenanceRepository,
        searchProviderKind: searchConfig.provider,
        activeSearchProjections
      })
    });
    const workerId = `maintenance-worker-${randomUUID()}`;
    const candidateObjectCleanupWorkerId =
      `candidate-object-cleanup-worker-${randomUUID()}`;
    const providerIndexCleanupWorkerId =
      `provider-index-cleanup-worker-${randomUUID()}`;
    const deletionWorkerId = `deletion-worker-${randomUUID()}`;
    const webhookWorkerId = `webhook-worker-${randomUUID()}`;
    let lastRetentionAt = 0;
    let lastAutomaticScanAt = 0;

    logger.info("maintenance_worker.started");
    while (!abort.signal.aborted) {
      const snapshot = await runtimeSettings.getSnapshot();
      quarantineGraceMilliseconds =
        snapshot.maintenance.quarantineGracePeriodSeconds * 1_000;
      resourceBudgets.update(resolveResourceBudgetLimits(snapshot));
      resourceBudgetReporter.report(resourceBudgets);
      const nextSearchProviderSettingsKey = JSON.stringify(snapshot.search);
      if (
        !searchProvider
        || searchProviderSettingsKey !== nextSearchProviderSettingsKey
      ) {
        const previousSearchProvider = searchProvider;
        searchProvider = createRuntimeSearchProvider({
          config: searchConfig,
          settings: snapshot.search,
          indexDefinition: createStorageVnextSearchSettings({
            searchCutoffMs: snapshot.search.engineSearchCutoffMs
          }),
          tokenizer
        });
        searchProviderSettingsKey = nextSearchProviderSettingsKey;
        await closeSearchProvider(previousSearchProvider);
      }
      const pipeline = createStorageVnextProductionPublicationPipeline({
        config: productionConfig,
        sql,
        snapshot,
        catalog,
        graph,
        releases,
        ownership,
        searchRepository,
        activeSearchProjections,
        sourceBodies,
        generatedBodies,
        objects,
        objectValidator,
        effectiveCatalog,
        publicationSnapshot,
        searchProvider
      });
      const maintenancePipeline = createStorageVnextProductionPublicationPipeline({
        config: productionConfig,
        sql,
        snapshot,
        catalog,
        graph,
        releases,
        ownership,
        searchRepository,
        activeSearchProjections,
        sourceBodies,
        generatedBodies,
        objects,
        objectValidator,
        effectiveCatalog,
        publicationSnapshot: maintenanceRebuildSnapshot,
        searchProvider
      });
      const deletionRelease = createStorageVnextDeletionProductionRelease({
        scope: deletionScope,
        releases,
        processor: pipeline.createProcessor(),
        clock: now,
        rollbackRetentionMilliseconds: resultRetentionMilliseconds(snapshot),
        resultRetentionMilliseconds: resultRetentionMilliseconds(snapshot)
      });
      const deletionWorker = createStorageVnextDeletionWorker({
        workflow,
        prepare: deletionRelease.prepare,
        purge: createStorageVnextDeletionPurgeCoordinator({
          processResources: {
            async closeAll() {
              return undefined;
            }
          },
          coordination: redis,
          search: createStorageVnextUnifiedSearchDeletion({
            provider: pipeline.searchProvider,
            indexUidPrefix: searchConfig.indexPrefix,
            maximumPollAttempts: Math.max(1, Math.ceil(
              snapshot.search.taskTimeoutMs
                / snapshot.search.taskPollIntervalMs
            )),
            maximumSourceFiles: deletionBatchSize(snapshot),
            taskPageSize: cleanupPageSize(snapshot),
            sleep: () => waitForPoll(
              snapshot.search.taskPollIntervalMs,
              abort.signal
            )
          }),
          semantic: createSemanticDeletionService({
            repository: semanticDeletionRepository,
            provider: requireSemanticVectorProvider(searchProvider),
            selectedProviderKind: searchConfig.provider,
            indexPrefix: searchConfig.indexPrefix,
            pageSize: deletionBatchSize(snapshot),
            maximumOperationPolls: Math.max(1, Math.ceil(
              snapshot.search.taskTimeoutMs
                / snapshot.search.taskPollIntervalMs
            )),
            operationPollIntervalMs: snapshot.search.taskPollIntervalMs,
            wait: (milliseconds) => waitForPoll(milliseconds, abort.signal)
          }),
          postgres: deletionPurgeRepository,
          objects: objectDeletion,
          maximumObjectsPerAttempt: deletionBatchSize(snapshot)
        }),
        owner: deletionWorkerId,
        claimLimit: Math.min(
          snapshot.worker.hardDeleteConcurrency,
          maintenancePoolLimit(config)
        ),
        maximumAttempts: snapshot.worker.hardDeleteMaxAttempts,
        retryDelayMilliseconds: () => snapshot.worker.hardDeleteRetryDelayMs,
        clock: now,
        webhooks: createStorageVnextWebhookOutbox({
          repository: webhookRepository,
          resultRetentionMilliseconds: resultRetentionMilliseconds(snapshot),
          clock: now
        }),
        onWebhookError(error) {
          logger.warn("deletion_worker.webhook_enqueue_failed", {
            errorClass: error instanceof Error ? error.name : "UnknownError"
          });
        }
      });
      const webhookWorker = createStorageVnextWebhookWorker({
        repository: webhookRepository,
        owner: webhookWorkerId,
        claimLimit: Math.min(100, snapshot.worker.claimBatchSize),
        maximumAttempts: snapshot.worker.jobMaxAttempts,
        retryDelayMilliseconds: snapshot.worker.jobRetryDelayMs,
        requestTimeoutMilliseconds:
          storageVnextWebhookRequestTimeoutMilliseconds(
            snapshot.worker.lockTtlSeconds
          ),
        clock: now
      });
      const searchCleanup = createStorageVnextSearchCleanup({
        repository: createPostgresStorageVnextSearchCleanupRepository(sql),
        provider: pipeline.searchProvider,
        indexUidPrefix: searchConfig.indexPrefix,
        indexPageSize: cleanupPageSize(snapshot),
        taskPageSize: cleanupPageSize(snapshot),
        maxDeletesPerRun: cleanupPageSize(snapshot),
        maxPollAttempts: Math.max(1, Math.ceil(
          snapshot.search.taskTimeoutMs / snapshot.search.taskPollIntervalMs
        )),
        pollIntervalMs: snapshot.search.taskPollIntervalMs,
        highWaterRatio: 0.25,
        minimumReclaimableBytes: snapshot.search.indexBatchCompressedBytes
      });
      const providerIndexCleanup = createStorageVnextProviderIndexCleanupWorker({
        actions: cleanupActions,
        provider: pipeline.searchProvider,
        maxPollAttempts: Math.max(1, Math.ceil(
          snapshot.search.taskTimeoutMs / snapshot.search.taskPollIntervalMs
        )),
        pollIntervalMs: snapshot.search.taskPollIntervalMs,
        retryDelayMs: snapshot.search.retryDelayMs
      });
      const cleanup = createStorageVnextMaintenanceProductionCleanup({
        semanticTerminal: createPostgresSemanticGenerationRepository(sql),
        releases,
        searchTerminal: createPostgresStorageVnextSearchTerminalCleanup(sql),
        searchCleanup,
        clock: now,
        resultRetentionMilliseconds: resultRetentionMilliseconds(snapshot),
        maximumCleanupPages: MAXIMUM_CLEANUP_PAGES
      });
      const objectReconciliation = createStorageVnextMaintenanceObjectReconciliation({
        enabled: snapshot.maintenance.reconciliationEnabled,
        provider: objectInventory,
        registrations: ownership,
        limit: Math.min(1_000, snapshot.maintenance.scanBatchSize),
        graceElapsedAt: new Date(
          Date.now() - snapshot.maintenance.quarantineGracePeriodSeconds * 1_000
        ).toISOString()
      });
      const phaseRunner = createStorageVnextMaintenanceProductionPhases({
        semanticAdoption,
        semanticProviderAdoption: createSemanticProviderAdoptionService({
          catalog,
          artifacts: embeddingArtifacts,
          store: embeddingArtifactStore,
          repository: semanticProviderAdoptionRepository,
          provider: requireSemanticVectorPort(searchProvider),
          indexPrefix: searchConfig.indexPrefix,
          artifactReadConcurrency: Math.min(
            8,
            snapshot.maintenance.lexicalRebuildSourceReadConcurrency
          ),
          operationPollLimit: Math.max(1, Math.ceil(
            snapshot.search.taskTimeoutMs / snapshot.search.taskPollIntervalMs
          )),
          operationPollIntervalMs: snapshot.search.taskPollIntervalMs
        }),
        providerAdoption,
        planner,
        catalog,
        releases,
        pipeline: maintenancePipeline,
        objectReconciliation,
        candidateObjectCleanup,
        clock: now,
        rollbackRetentionMilliseconds: resultRetentionMilliseconds(snapshot),
        resultRetentionMilliseconds: resultRetentionMilliseconds(snapshot),
        maxP95ProcessingTimeMs: snapshot.search.requestTimeoutMs
      });
      const concurrency = maintenanceConcurrency(config, snapshot);
      const coordinator = createStorageVnextMaintenanceCoordinator({
        repository: maintenanceRepository,
        searchProviderKind: searchConfig.provider,
        phaseRunner,
        cleanup,
        resourceGate: createStorageVnextMaintenanceResourceGate({
          limits: {
            maxMaintenanceConcurrency: concurrency,
            databaseConnectionLimit: maintenancePoolLimit(config),
            reservedApiConnections: 0,
            reservedForegroundConnections: 0,
            maintenanceDatabaseConnections: 1,
            searchInFlightLimit: Math.max(1, snapshot.search.maxInFlightTasks),
            maintenanceSearchRequests: 1,
            objectInFlightLimit: Math.max(
              1,
              snapshot.worker.sourceObjectReadConcurrency
            ),
            maintenanceObjectRequests: 1,
            memoryByteLimit: Math.floor(getHeapStatistics().heap_size_limit),
            maintenanceBatchBytes: Math.max(
              config.pagination.generatedContentMaxBytes,
              snapshot.search.indexBatchCompressedBytes
            )
          },
          async sample() {
            return {
              databaseConnectionsInUse: 0,
              searchRequestsInFlight: 0,
              objectRequestsInFlight:
                resourceBudgets.generatedObjectWrite.snapshot().active,
              rssBytes: process.memoryUsage().rss
            };
          }
        }),
        phaseTimeoutMs: snapshot.worker.lockTtlSeconds * 1_000,
        now: () => new Date(),
        onFailure(failure) {
          logger.error("maintenance_worker.item_failed", {
            operationPublicId: failure.operationPublicId,
            knowledgeBaseId: failure.knowledgeBaseId,
            attempt: failure.attempt,
            failureCode: failure.code,
            errorClass: failure.error instanceof Error
              ? failure.error.name
              : "UnknownError",
            errorMessage: failure.error instanceof Error
              ? failure.error.message
              : String(failure.error)
          });
        }
      });
      const cycleAt = now();
      const stagingRetentionCutoff = storageVnextStagingRetentionCutoff(
        cycleAt,
        snapshot.search.stagingRetentionHours
      );
      const failedSearchCandidate = await searchCleanup.cleanupFailedCandidate({
        failedBefore: stagingRetentionCutoff,
        correlationPublicId: FAILED_SEARCH_CANDIDATE_CLEANUP_ID
      });
      if (failedSearchCandidate.outcome === "deleted") {
        logger.info("maintenance_worker.failed_search_candidate_cleaned", {
          candidatePublicId: failedSearchCandidate.candidatePublicId
        });
      }
      const orphanSearchIndexes = await searchCleanup.cleanupOrphanIndexes({
        updatedBefore: stagingRetentionCutoff,
        continuation: null
      });
      if (orphanSearchIndexes.deleted > 0) {
        logger.info("maintenance_worker.orphan_search_indexes_cleaned", {
          deleted: orphanSearchIndexes.deleted
        });
      }
      const automaticScanIntervalMilliseconds =
        snapshot.maintenance.knowledgeBaseMaintenanceScanIntervalSeconds * 1_000;
      if (Date.now() - lastAutomaticScanAt >= automaticScanIntervalMilliseconds) {
        const settingsRevision = await runtimeSettings.getCurrentRevision();
        const automaticResult = await automaticMaintenance.run({
          mode: snapshot.maintenance.knowledgeBaseMaintenanceMode,
          settingsRevisionPublicId: settingsRevision.publicId,
          scanIntervalSeconds:
            snapshot.maintenance.knowledgeBaseMaintenanceScanIntervalSeconds,
          maxAttempts: snapshot.maintenance.maxAttempts,
          resultRetentionMilliseconds: resultRetentionMilliseconds(snapshot),
          limit: Math.min(1_000, Math.max(
            20,
            snapshot.maintenance.knowledgeBaseMaintenanceConcurrency * 4
          ))
        });
        if (automaticResult.canceled > 0 || automaticResult.discovered > 0) {
          logger.info("maintenance_worker.automatic_scan", automaticResult);
        }
        lastAutomaticScanAt = Date.now();
      }
      await coordinator.recoverStale({
        expiredBefore: cycleAt,
        retryAt: cycleAt,
        limit: Math.min(1_000, snapshot.maintenance.scanBatchSize)
      });
      const nextLeaseExpiresAt = () => addMilliseconds(
        now(),
        snapshot.worker.lockTtlSeconds * 1_000
      );
      const providerIndexCleanupOutcome = await providerIndexCleanup.runBatch({
        owner: providerIndexCleanupWorkerId,
        limit: cleanupPageSize(snapshot),
        leaseExpiresAt: nextLeaseExpiresAt()
      });
      if (providerIndexCleanupOutcome.claimed > 0) {
        logger[
          providerIndexCleanupOutcome.retried > 0 ? "warn" : "info"
        ]("maintenance_worker.provider_index_cleanup", providerIndexCleanupOutcome);
      }
      const deletionOutcomes = await deletionWorker.runBatch({
        leaseExpiresAt: nextLeaseExpiresAt()
      });
      for (const outcome of deletionOutcomes) {
        logger.info("deletion_worker.cycle", outcome);
      }
      const candidateObjectCleanupOutcome =
        await candidateObjectCleanupWorker.runBatch({
          owner: candidateObjectCleanupWorkerId,
          limit: deletionBatchSize(snapshot),
          leaseExpiresAt: nextLeaseExpiresAt(),
          now: cycleAt,
          retryDelayMilliseconds: snapshot.maintenance.retryDelayMs,
          signal: abort.signal
        });
      if (candidateObjectCleanupOutcome.claimed > 0) {
        logger[
          candidateObjectCleanupOutcome.retried > 0 ? "warn" : "info"
        ](
          candidateObjectCleanupOutcome.retried > 0
            ? "maintenance_worker.candidate_object_cleanup_retry"
            : "maintenance_worker.candidate_object_cleanup",
          candidateObjectCleanupOutcome
        );
      }
      const zeroOwnerOutcome = snapshot.maintenance.reconciliationEnabled
        ? await zeroOwnerCleanup.runBatch({
            graceElapsedBefore: new Date(
              Date.now() - snapshot.maintenance.quarantineGracePeriodSeconds * 1_000
            ).toISOString(),
            limit: deletionBatchSize(snapshot)
          })
        : {
            outcome: "completed" as const,
            eligible: 0,
            deleted: 0,
            skippedOwned: 0,
            purgedRegistrations: 0,
            reasonCode: null
          };
      if (
        zeroOwnerOutcome.eligible > 0
        || zeroOwnerOutcome.purgedRegistrations > 0
      ) {
        const event = zeroOwnerOutcome.outcome === "retry"
          ? "maintenance_worker.zero_owner_cleanup_retry"
          : "maintenance_worker.zero_owner_cleanup";
        logger[zeroOwnerOutcome.outcome === "retry" ? "warn" : "info"](
          event,
          zeroOwnerOutcome
        );
      }
      const webhookOutcome = await webhookWorker.runBatch({
        leaseExpiresAt: nextLeaseExpiresAt(),
        signal: abort.signal
      });
      if (webhookOutcome.claimed > 0) {
        logger.info("webhook_worker.cycle", webhookOutcome);
      }
      if (Date.now() - lastRetentionAt >= STORAGE_VNEXT_RETENTION_INTERVAL_MS) {
        await runStorageVnextRetentionSlice(sql, {
          now: new Date(),
          batchSize: Math.min(1_000, snapshot.maintenance.scanBatchSize),
          securityAuditRetentionDays:
            resolveSecurityConfig(config).audit.retentionDays
        });
        lastRetentionAt = Date.now();
      }
      const results = await Promise.all(Array.from(
        { length: concurrency },
        () => coordinator.runOne({
          workerId,
          leaseExpiresAt: nextLeaseExpiresAt(),
          signal: abort.signal
        })
      ));
      for (const result of results) {
        if (result.outcome !== "idle") {
          logger.info("maintenance_worker.cycle", {
            outcome: result.outcome,
            operationPublicId: result.operationPublicId
          });
        }
      }
      if (
        !abort.signal.aborted
        && shouldWaitForStorageVnextMaintenancePoll(
          results,
          zeroOwnerOutcome,
          candidateObjectCleanupOutcome
        )
      ) {
        await waitForPoll(snapshot.worker.pollIntervalMs, abort.signal);
      }
    }
    resourceBudgetReporter.report(resourceBudgets, { force: true });
    logger.info("maintenance_worker.stopped");
  } finally {
    stop();
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.removeListener(signal, stop);
    }
    if (redisConnected) await redisClient.close();
    s3.destroy();
    await closeDatabaseClient(sql);
    await closeSearchProvider(searchProvider);
  }
}

export function shouldWaitForStorageVnextMaintenancePoll(
  results: readonly { outcome: string }[],
  zeroOwnerOutcome?: { outcome: string },
  candidateObjectCleanupOutcome?: { outcome: string }
): boolean {
  return zeroOwnerOutcome?.outcome !== "progress"
    && candidateObjectCleanupOutcome?.outcome !== "progress"
    && !results.some((result) =>
      result.outcome === "progress" || result.outcome === "phase_completed");
}

async function closeSearchProvider(
  provider: SearchProviderRuntime | null
): Promise<void> {
  if (provider) await provider.close();
}

function requireSemanticVectorProvider(provider: SearchProviderRuntime | null) {
  if (!provider?.vector) {
    throw new Error("Search provider vector capability is required");
  }
  return provider.vector;
}

export function storageVnextStagingRetentionCutoff(
  cycleAt: string,
  stagingRetentionHours: number
): string {
  if (
    !Number.isFinite(Date.parse(cycleAt))
    || !Number.isSafeInteger(stagingRetentionHours)
    || stagingRetentionHours < 1
  ) throw new Error("Storage vNext staging retention input is invalid");
  return new Date(
    Date.parse(cycleAt) - stagingRetentionHours * MILLISECONDS_PER_HOUR
  ).toISOString();
}

export function storageVnextWebhookRequestTimeoutMilliseconds(
  lockTtlSeconds: number
): number {
  if (!Number.isSafeInteger(lockTtlSeconds) || lockTtlSeconds < 1) {
    throw new Error("Storage vNext worker lock TTL is invalid");
  }
  return Math.max(1, Math.floor(lockTtlSeconds * 1_000 * 0.8));
}

function pageSize(config: RuntimeConfig): number {
  return Math.min(1_000, config.pagination.maxPageSize);
}

function cleanupPageSize(snapshot: RuntimeSettingsSnapshot): number {
  return Math.min(1_000, snapshot.search.cleanupBatchSize);
}

function deletionBatchSize(snapshot: RuntimeSettingsSnapshot): number {
  return Math.min(
    1_000,
    snapshot.maintenance.deletionBatchSize,
    snapshot.worker.hardDeleteDatabaseBatchSize,
    snapshot.worker.hardDeleteObjectBatchSize
  );
}

function maintenancePoolLimit(config: RuntimeConfig): number {
  return config.database.maintenanceWorkerPoolMax ?? 2;
}

function maintenanceConcurrency(
  config: RuntimeConfig,
  snapshot: RuntimeSettingsSnapshot
): number {
  return Math.max(1, Math.min(
    snapshot.maintenance.knowledgeBaseMaintenanceConcurrency,
    snapshot.maintenance.projectionRepairConcurrency,
    snapshot.maintenance.lexicalRebuildConcurrency,
    maintenancePoolLimit(config),
    snapshot.search.maxInFlightTasks,
    snapshot.worker.sourceObjectReadConcurrency
  ));
}

function resultRetentionMilliseconds(snapshot: RuntimeSettingsSnapshot): number {
  return snapshot.worker.completedJobRetentionDays * MILLISECONDS_PER_DAY;
}

function now(): string {
  return new Date().toISOString();
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

async function waitForPoll(
  milliseconds: number,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}
