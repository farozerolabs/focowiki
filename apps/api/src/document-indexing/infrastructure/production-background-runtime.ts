import { S3Client } from "@aws-sdk/client-s3";
import { getHeapStatistics } from "node:v8";
import type { RuntimeConfig, WorkerRuntimeConfig } from "../../config.js";
import type { DatabaseClient } from "../../db/client.js";
import type { createRuntimeSearchProvider } from "../../runtime/search-provider.js";
import type { LexicalTokenizer } from
  "../../application/ports/lexical-tokenizer.js";
import { createRuntimeSettingsDefaults } from
  "../../runtime-settings/validation.js";
import { createRuntimeSettingsRepository } from
  "../../runtime-settings/repository.js";
import {
  sanitizeMaintenanceSettings,
  validateMaintenanceSettings
} from "../../runtime-settings/validation.js";
import type { RuntimeMaintenanceSettings } from
  "../../runtime-settings/types.js";
import { createS3ClientConfig } from "../../storage/s3.js";
import { createStorageVnextSearchSettings } from
  "../../storage-vnext/search/settings.js";
import { createStorageVnextMaintenanceCoordinator } from
  "../../storage-vnext/maintenance/maintenance-coordinator.js";
import { createPostgresStorageVnextMaintenanceRepository } from
  "../../storage-vnext/maintenance/postgres-repository.js";
import { createStorageVnextMaintenanceResourceGate } from
  "../../storage-vnext/maintenance/resource-gate.js";
import { createPostgresStorageVnextOwnershipRepository } from
  "../../storage-vnext/ownership/postgres-repository.js";
import { purgePostgresStorageVnextDeletedRegistrations } from
  "../../storage-vnext/ownership/postgres-repository.js";
import { createS3StorageVnextObjectInventory } from
  "../../storage-vnext/ownership/s3-object-inventory.js";
import {
  createS3StorageVnextFailedWriteProvider,
  createStorageVnextFailedWriteCompensator,
  recoverStorageVnextStaleReservations
} from "../../storage-vnext/ownership/failed-write-compensation.js";
import {
  createS3StorageVnextVersionAwareDeletionProvider,
  createStorageVnextVersionAwareObjectDeletion
} from "../../storage-vnext/ownership/version-aware-deletion.js";
import { createPostgresStorageVnextCleanupActionRepository } from
  "../../storage-vnext/cleanup/postgres-cleanup-action-repository.js";
import { createStorageVnextUploadTerminalObjectCleanupWorker } from
  "../../storage-vnext/maintenance/upload-terminal-object-cleanup-worker.js";
import { createPostgresStorageVnextUploadRepository } from
  "../../storage-vnext/upload/postgres-repository.js";
import { createPostgresStorageVnextUploadTerminalPort } from
  "../../storage-vnext/upload/postgres-terminal.js";
import { createStorageVnextUploadSessionMaintenance } from
  "../../storage-vnext/upload/upload-coordinator.js";
import { createDocumentRetention } from
  "../application/document-retention.js";
import {
  createDocumentObsoleteArtifactCleanupWorker
} from "../application/document-obsolete-artifact-cleanup.js";
import {
  createZeroOwnerObjectCleanup,
  resolveZeroOwnerObjectCleanupConcurrency
} from "../application/zero-owner-object-cleanup.js";
import { createDocumentResourceDeletionWorker } from
  "../application/document-resource-deletion-worker.js";
import { createDocumentMaintenancePhaseRunner } from
  "../application/document-maintenance-phase-runner.js";
import type { UnifiedBackgroundWorkClass } from
  "../application/unified-worker-scheduler.js";
import type { DocumentWorkerObservability } from
  "../application/document-worker-observability.js";
import type { DocumentResourceCapacityInput } from
  "../application/document-resource-capacity.js";
import { createPostgresDocumentJobRetention } from
  "./postgres-document-job-retention.js";
import { createPostgresOperationTombstoneRetention } from
  "./postgres-operation-tombstone-retention.js";
import { createPostgresDocumentObsoleteCleanup } from
  "./postgres-document-obsolete-cleanup.js";
import { createPostgresDocumentRevisionPurge } from
  "./postgres-document-revision-purge.js";
import { createPostgresZeroOwnerObjectCleanup } from
  "./postgres-zero-owner-object-cleanup.js";
import { createPostgresDocumentResourceDeletion } from
  "./postgres-document-resource-deletion.js";
import { createPostgresDocumentMaintenance } from
  "./postgres-document-maintenance.js";
import { createProductionDocumentDeletionProjection } from
  "./production-document-deletion-projection.js";
import { removeProductionDocumentObsoleteArtifact } from
  "./production-obsolete-artifact-removal.js";
import { createProductionDocumentStorageReconciliation } from
  "./production-document-storage-reconciliation.js";
import { createPostgresDocumentDirectoryMove } from
  "./postgres-document-directory-move.js";

const STALE_OBJECT_RESERVATION_AGE_MS = 60 * 60 * 1_000;

export function createProductionBackgroundRuntime(input: {
  sql: DatabaseClient;
  config: RuntimeConfig;
  workerConfig: Required<WorkerRuntimeConfig>;
  resourceCapacity: DocumentResourceCapacityInput;
  searchProvider: ReturnType<typeof createRuntimeSearchProvider> | null;
  tokenizer: LexicalTokenizer;
  workerId: string;
  observability?: DocumentWorkerObservability;
}) {
  const completedWorkRetentionMilliseconds =
    input.workerConfig.completedJobRetentionDays * 86_400_000;
  const settings = createRuntimeSettingsDefaults(input.config);
  const runtimeSettings = createRuntimeSettingsRepository(input.sql);
  const s3 = new S3Client(createS3ClientConfig(input.config.storage));
  const ownership = createPostgresStorageVnextOwnershipRepository(input.sql);
  const failedWriteCompensation = createStorageVnextFailedWriteCompensator({
    registrations: ownership,
    provider: createS3StorageVnextFailedWriteProvider({
      client: s3,
      bucket: input.config.storage.bucket,
      prefix: input.config.storage.prefix
    })
  });
  const objectDeletion = createStorageVnextVersionAwareObjectDeletion({
    registrations: ownership,
    provider: createS3StorageVnextVersionAwareDeletionProvider({
      client: s3,
      bucket: input.config.storage.bucket,
      prefix: input.config.storage.prefix
    })
  });
  const search = input.searchProvider;
  const deletionRepository = createPostgresDocumentResourceDeletion(input.sql, {
    webhookRetentionMilliseconds: completedWorkRetentionMilliseconds
  });
  const directoryMove = createPostgresDocumentDirectoryMove(input.sql);
  const deletion = createDocumentResourceDeletionWorker({
    ...deletionRepository,
    projections: createProductionDocumentDeletionProjection({
      sql: input.sql,
      config: input.config,
      workerConfig: input.workerConfig,
      resourceCapacity: input.resourceCapacity,
      s3,
      ownership
    })
  });
  const cleanupRepository = createPostgresDocumentObsoleteCleanup(input.sql);
  const revisionPurge = createPostgresDocumentRevisionPurge(input.sql);
  const cleanup = createDocumentObsoleteArtifactCleanupWorker({
    ...cleanupRepository,
    providers: {
      remove: (action) => removeProductionDocumentObsoleteArtifact({
        sql: input.sql,
        config: input.config,
        search,
        objectDeletion,
        action
      })
    }
  });
  const candidateCleanup = createZeroOwnerObjectCleanup({
    concurrency: resolveZeroOwnerObjectCleanupConcurrency(
      input.resourceCapacity.sourceObjectReadConcurrency
    ),
    actions: createPostgresZeroOwnerObjectCleanup(input.sql),
    objects: {
      async removeZeroOwner(objectId) {
        await objectDeletion.deleteZeroOwner(objectId);
      }
    }
  });
  const uploadTerminalCleanup = createStorageVnextUploadTerminalObjectCleanupWorker({
    actions: createPostgresStorageVnextCleanupActionRepository(input.sql),
    objects: {
      deleteZeroOwner: (objectId) => objectDeletion.deleteZeroOwner(objectId)
    },
    purgeDeletedRegistrations: (request) =>
      purgePostgresStorageVnextDeletedRegistrations(input.sql, request)
  });
  const documentRetention = createDocumentRetention({
    uploads: createStorageVnextUploadSessionMaintenance({
      repository: createPostgresStorageVnextUploadRepository(input.sql, {
        sourceWorkRetentionMilliseconds: completedWorkRetentionMilliseconds
      }),
      terminal: createPostgresStorageVnextUploadTerminalPort(input.sql, {
        resultRetentionMilliseconds: completedWorkRetentionMilliseconds
      })
    }),
    jobs: createPostgresDocumentJobRetention(input.sql),
    operationTombstones: createPostgresOperationTombstoneRetention(input.sql)
  });
  const documentMaintenance = input.config.search
    ? createPostgresDocumentMaintenance({
        sql: input.sql,
        providerKind: input.config.search.provider,
        indexUidPrefix: input.config.search.indexPrefix,
        searchDefinition: createStorageVnextSearchSettings({
          searchCutoffMs: settings.search.engineSearchCutoffMs
        }),
        pageSize: async () => Math.min((await readMaintenanceSettings({
          repository: runtimeSettings,
          fallback: settings.maintenance
        })).scanBatchSize, 100),
        reconciliationPageSize: async () => (await readMaintenanceSettings({
          repository: runtimeSettings,
          fallback: settings.maintenance
        })).scanBatchSize,
        reconciliation: createProductionDocumentStorageReconciliation({
          provider: createS3StorageVnextObjectInventory({
            client: s3,
            bucket: input.config.storage.bucket,
            prefix: input.config.storage.prefix
          }),
          registrations: ownership
        })
      })
    : null;
  const maintenanceCoordinator = input.config.search && documentMaintenance
    ? createStorageVnextMaintenanceCoordinator({
        repository: createPostgresStorageVnextMaintenanceRepository(input.sql, {
          selectedSearchProviderKind: input.config.search.provider
        }),
        searchProviderKind: input.config.search.provider,
         phaseRunner: createDocumentMaintenancePhaseRunner({
           maintenance: documentMaintenance,
           async isReconciliationEnabled() {
             const maintenance = await readMaintenanceSettings({
               repository: runtimeSettings,
               fallback: settings.maintenance
             });
             return maintenance.reconciliationEnabled;
           }
        }),
        cleanup: {
          terminate: (request) => documentMaintenance.terminate(request)
        },
        resourceGate: createMaintenanceResourceGate(input, settings),
        phaseTimeoutMs: input.workerConfig.lockTtlSeconds * 1_000,
        onFailure(failure) {
          console.error(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "error",
            event: "worker.document_maintenance_failed",
            fields: {
              operationPublicId: failure.operationPublicId,
              knowledgeBaseId: failure.knowledgeBaseId,
              attempt: failure.attempt,
              errorCode: failure.code
            }
          }));
        }
      })
    : null;

  return {
    async run(workClass: UnifiedBackgroundWorkClass, signal: AbortSignal) {
      const now = new Date().toISOString();
      const leaseExpiresAt = new Date(
        Date.parse(now) + input.workerConfig.lockTtlSeconds * 1_000
      ).toISOString();
      if (workClass === "mutation") {
        await directoryMove.runPage({
          workerId: input.workerId,
          now,
          leaseExpiresAt,
          retryAt: new Date(
            Date.parse(now) + input.workerConfig.jobRetryDelayMs
          ).toISOString(),
          pageSize: Math.min(input.workerConfig.claimBatchSize, 100)
        });
        return;
      }
      if (workClass === "deletion") {
        const maintenance = await readMaintenanceSettings({
          repository: runtimeSettings,
          fallback: settings.maintenance
        });
        await deletion.runBatch({
          owner: input.workerId,
          limit: maintenance.hardDeleteConcurrency,
          pageSize: Math.min(
            maintenance.hardDeleteDatabaseBatchSize,
            maintenance.hardDeleteObjectBatchSize
          ),
          now,
          leaseExpiresAt,
          retryDelayMilliseconds: maintenance.hardDeleteRetryDelayMs,
          signal
        });
        return;
      }
      if (workClass === "orphan") {
        const staleReservations = await recoverStorageVnextStaleReservations({
          registrations: ownership,
          compensation: failedWriteCompensation,
          staleBefore: new Date(
            Date.parse(now) - STALE_OBJECT_RESERVATION_AGE_MS
          ).toISOString(),
          failedAt: now,
          limit: Math.min(settings.search.cleanupBatchSize, 100),
          cursor: null
        });
        const revisionPurgeResult = await revisionPurge.runBatch({
          owner: input.workerId,
          limit: Math.min(settings.search.cleanupBatchSize, 100),
          now,
          leaseExpiresAt,
          signal
        });
        const uploadResult = await uploadTerminalCleanup.runBatch({
          owner: input.workerId,
          limit: Math.min(settings.search.cleanupBatchSize, 100),
          now,
          leaseExpiresAt,
          retryDelayMilliseconds: settings.search.retryDelayMs,
          signal
        });
        const candidateResult = await candidateCleanup.run({
          owner: input.workerId,
          limit: Math.min(settings.search.cleanupBatchSize, 1_000),
          now,
          leaseExpiresAt,
          retryAt: new Date(
            Date.parse(now) + settings.search.retryDelayMs
          ).toISOString(),
          signal
        });
        const obsoleteResult = await cleanup.run({
          owner: input.workerId,
          searchProviderKind: input.config.search?.provider ?? null,
          limit: Math.min(settings.search.cleanupBatchSize, 1_000),
          now,
          leaseExpiresAt,
          retryDelayMilliseconds: settings.search.retryDelayMs,
          signal
        });
        const [retention] = await Promise.allSettled([
          documentRetention.run({
            now,
            retentionDays: input.workerConfig.completedJobRetentionDays,
            limit: input.workerConfig.retentionCleanupBatchSize
          })
        ]);
        const retentionCounts = retention.status === "fulfilled"
          ? retention.value
          : {
              expiredUploadSessionCount: 0,
              deletedDocumentJobCount: 0,
              deletedOperationTombstoneCount: 0
            };
        input.observability?.cleanup({
          claimed: uploadResult.claimed
            + candidateResult.claimed
            + obsoleteResult.claimed
            + revisionPurgeResult.claimed
            + retentionCounts.expiredUploadSessionCount
            + retentionCounts.deletedDocumentJobCount
            + retentionCounts.deletedOperationTombstoneCount
            + staleReservations.processed,
          completed: uploadResult.completed
            + candidateResult.completed
            + obsoleteResult.completed
            + revisionPurgeResult.completed
            + retentionCounts.expiredUploadSessionCount
            + retentionCounts.deletedDocumentJobCount
            + retentionCounts.deletedOperationTombstoneCount
            + staleReservations.processed,
          retried: uploadResult.retried
            + candidateResult.retried
            + obsoleteResult.retried
            + revisionPurgeResult.retried,
          failed: candidateResult.failed + obsoleteResult.terminalFailed
            + revisionPurgeResult.failed
        });
        if (retention.status === "rejected") throw retention.reason;
        return;
      }
      const maintenance = await readMaintenanceSettings({
        repository: runtimeSettings,
        fallback: settings.maintenance
      });
      if (maintenanceCoordinator) {
        await maintenanceCoordinator.recoverStale({
          expiredBefore: now,
          retryAt: new Date(
            Date.parse(now) + maintenance.retryDelayMs
          ).toISOString(),
          limit: input.workerConfig.claimBatchSize
        });
        await maintenanceCoordinator.runOne({
          workerId: input.workerId,
          leaseExpiresAt,
          signal
        });
      }
      await convergeFailedDeletionHistory(input.sql, {
        now,
        retentionDays: maintenance.hardDeleteFailedRetentionDays,
        limit: Math.min(maintenance.hardDeleteDatabaseBatchSize, 1_000)
      });
    },
    async close(): Promise<void> {
      s3.destroy();
    }
  };
}

function createMaintenanceResourceGate(
  input: Parameters<typeof createProductionBackgroundRuntime>[0],
  settings: ReturnType<typeof createRuntimeSettingsDefaults>
) {
  const databaseConnectionLimit = Math.max(
    2,
    input.config.database.workerPoolMax ?? 8
  );
  return createStorageVnextMaintenanceResourceGate({
    limits: {
      maxMaintenanceConcurrency: 1,
      databaseConnectionLimit,
      reservedApiConnections: 0,
      reservedForegroundConnections: Math.min(
        input.workerConfig.sourceFileConcurrency,
        databaseConnectionLimit - 1
      ),
      maintenanceDatabaseConnections: 1,
      searchInFlightLimit: Math.max(1, settings.search.maxInFlightTasks),
      maintenanceSearchRequests: 1,
      objectInFlightLimit: Math.max(
        1,
        settings.worker.sourceObjectReadConcurrency
      ),
      maintenanceObjectRequests: 1,
      memoryByteLimit: Math.floor(getHeapStatistics().heap_size_limit),
      maintenanceBatchBytes: Math.max(
        input.config.pagination.generatedContentMaxBytes,
        settings.search.indexBatchCompressedBytes
      )
    },
    async sample() {
      return {
        databaseConnectionsInUse: 0,
        searchRequestsInFlight: 0,
        objectRequestsInFlight: 0,
        rssBytes: process.memoryUsage().rss
      };
    }
  });
}

async function readMaintenanceSettings(input: {
  repository: ReturnType<typeof createRuntimeSettingsRepository>;
  fallback: RuntimeMaintenanceSettings;
}): Promise<RuntimeMaintenanceSettings> {
  const record = await input.repository.getSetting("maintenance");
  if (!record || validateMaintenanceSettings(record.value).length > 0) {
    return input.fallback;
  }
  return sanitizeMaintenanceSettings(record.value as RuntimeMaintenanceSettings);
}

async function convergeFailedDeletionHistory(
  sql: DatabaseClient,
  input: { now: string; retentionDays: number; limit: number }
): Promise<void> {
  await sql`
    DELETE FROM focowiki.cleanup_actions
    WHERE public_id IN (
      SELECT public_id FROM focowiki.cleanup_actions
      WHERE action_kind = 'document_resource_deletion'
        AND state = 'failed'
        AND updated_at < ${new Date(
          Date.parse(input.now) - input.retentionDays * 86_400_000
        ).toISOString()}
      ORDER BY updated_at, public_id COLLATE "C"
      LIMIT ${input.limit}
    )
  `;
}
