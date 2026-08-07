import { S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import type { RuntimeConfig } from "../../config.js";
import type { SearchProviderRuntime } from
  "../../application/ports/search-provider-runtime.js";
import { closeDatabaseClient, createDatabaseClient } from "../../db/client.js";
import { assertRuntimeSchemaGeneration } from "../../db/migrations.js";
import { createRuntimeLogger } from "../../logger.js";
import {
  assertNodeJiebaRuntimeAvailable,
  createNodeJiebaTokenizer
} from "../../infrastructure/tokenization/nodejieba-tokenizer.js";
import { createRuntimeSearchProvider } from
  "../../runtime/search-provider.js";
import {
  createRedisClient,
  createRedisCoordinator
} from "../../redis/coordination.js";
import { createResilientRedisCoordinator } from "../../redis/resilient-coordinator.js";
import { registerWorkerRedisRuntimeEvents } from "../../redis/worker-runtime.js";
import { createProcessResourceBudgets } from "../../runtime/resource-budget.js";
import { createResourceBudgetReporter } from "../../runtime/resource-budget-reporter.js";
import { createRuntimeSettingsRepository } from "../../runtime-settings/repository.js";
import {
  resolveResourceBudgetLimits
} from "../../runtime-settings/resource-budget-settings.js";
import { createRuntimeSettingsService } from "../../runtime-settings/service.js";
import { createS3ClientConfig } from "../../storage/s3.js";
import {
  createPostgresStorageVnextCatalogRepository
} from "../catalog/postgres-repository.js";
import {
  createS3StorageVnextSourceBodyStore
} from "../catalog/s3-source-body-store.js";
import {
  createPostgresStorageVnextGraphRepository
} from "../graph/postgres-repository.js";
import {
  createPostgresStorageVnextMutationCandidatePreparer
} from "../mutation/postgres-candidate-preparer.js";
import {
  createPostgresStorageVnextMutationReleaseHooks
} from "../mutation/postgres-release-hooks.js";
import {
  createPostgresStorageVnextMutationRepository
} from "../mutation/postgres-repository.js";
import {
  createStorageVnextMutationTerminalCoordinator
} from "../mutation/mutation-terminal.js";
import {
  createStorageVnextFailedWriteCompensator,
  createS3StorageVnextFailedWriteProvider
} from "../ownership/failed-write-compensation.js";
import {
  createStorageVnextImmutableObjectWriter
} from "../ownership/immutable-object-writer.js";
import {
  createPostgresStorageVnextOwnershipRepository
} from "../ownership/postgres-repository.js";
import {
  createS3StorageVnextImmutableBodyStore
} from "../ownership/s3-immutable-body-store.js";
import {
  createPostgresStorageVnextReleaseRepository
} from "../release/postgres-repository.js";
import {
  createPostgresStorageVnextSearchProjectionRepository
} from "../search/postgres-repository.js";
import {
  createPostgresStorageVnextActiveSearchProjectionRepository
} from "../search/postgres-active-projection.js";
import { createStorageVnextSearchSettings } from "../search/settings.js";
import {
  createPostgresStorageVnextWorkflowRepository
} from "../workflow/postgres-repository.js";
import { createStorageVnextWebhookOutbox } from "../webhook/outbox.js";
import { createPostgresStorageVnextWebhookRepository } from
  "../webhook/postgres-repository.js";
import {
  createPostgresStorageVnextEffectiveCatalog
} from "./effective-catalog.js";
import {
  createStorageVnextPublicationObjectValidator
} from "./object-validator.js";
import {
  createPostgresStorageVnextPublicationSnapshot
} from "./postgres-snapshot.js";
import {
  createStorageVnextProductionPublicationPipeline
} from "./production-pipeline.js";
import {
  createStorageVnextPublicationRoleRuntime
} from "./role-runtime.js";
import { createStorageVnextPublicationWorker } from "./worker.js";

const MILLISECONDS_PER_DAY = 86_400_000;

export async function runStorageVnextPublicationWorker(
  config: RuntimeConfig
): Promise<void> {
  const searchConfig = config.search;
  if (!searchConfig) {
    throw new Error("Search configuration is required for the publication worker");
  }
  const productionConfig = { ...config, search: searchConfig };
  const logger = createRuntimeLogger(config, console, { streamName: "publication-worker" });
  const sql = createDatabaseClient(config, { role: "publication-worker" });
  const redisClient = createRedisClient(config);
  const s3 = new S3Client(createS3ClientConfig(config.storage));
  const abort = new AbortController();
  const stop = () => abort.abort(
    new DOMException("Publication worker shutting down", "AbortError")
  );
  let redisConnected = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);
  registerWorkerRedisRuntimeEvents({ client: redisClient, logger, role: "publication" });

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
    const tokenizer = searchConfig.provider === "opensearch"
      ? (assertNodeJiebaRuntimeAvailable(), createNodeJiebaTokenizer())
      : undefined;
    let searchProvider: SearchProviderRuntime | null = null;
    let searchProviderSettingsKey = "";
    const resourceBudgets = createProcessResourceBudgets(
      resolveResourceBudgetLimits(initialSnapshot)
    );
    const resourceBudgetReporter = createResourceBudgetReporter({ logger });
    const catalog = createPostgresStorageVnextCatalogRepository(sql);
    const graph = createPostgresStorageVnextGraphRepository(sql);
    const releases = createPostgresStorageVnextReleaseRepository(sql, {
      lifecycleHooks: createPostgresStorageVnextMutationReleaseHooks()
    });
    const workflow = createPostgresStorageVnextWorkflowRepository(sql);
    const webhookRepository = createPostgresStorageVnextWebhookRepository(sql);
    const ownership = createPostgresStorageVnextOwnershipRepository(sql);
    const searchRepository = createPostgresStorageVnextSearchProjectionRepository(sql);
    const activeSearchProjections =
      createPostgresStorageVnextActiveSearchProjectionRepository(sql);
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
    const mutationRepository = createPostgresStorageVnextMutationRepository(sql);
    const mutationPreparer = createPostgresStorageVnextMutationCandidatePreparer({
      sql,
      releases,
      clock: now
    });
    const mutationTerminal = createStorageVnextMutationTerminalCoordinator({
      repository: mutationRepository,
      releases,
      workflow
    });
    const role = createStorageVnextPublicationRoleRuntime({
      owner: `publication-worker-${randomUUID()}`,
      clock: now,
      async getSettings() {
        const current = await runtimeSettings.getSnapshot();
        resourceBudgets.update(resolveResourceBudgetLimits(current));
        resourceBudgetReporter.report(resourceBudgets);
        return { ...current.worker, ...current.publication, snapshot: current };
      },
      recoverStale(request) {
        return workflow.recoverStale({
          kinds: ["publication", "mutation"],
          expiredBefore: request.expiredBefore,
          retryAt: request.retryAt,
          reasonCode: "STALE_LEASE",
          limit: request.limit
        });
      },
      async createWorker({ snapshot, ...settings }) {
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
            ...(tokenizer ? { tokenizer } : {})
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
        const processor = pipeline.createProcessor();
        return createStorageVnextPublicationWorker({
          workflow,
          releases,
          processor,
          webhooks: createStorageVnextWebhookOutbox({
            repository: webhookRepository,
            resultRetentionMilliseconds:
              settings.completedJobRetentionDays * MILLISECONDS_PER_DAY,
            clock: now
          }),
          onWebhookError(error) {
            logger.warn("publication_worker.webhook_enqueue_failed", {
              errorClass: error instanceof Error ? error.name : "UnknownError"
            });
          },
          mutations: {
            prepare: mutationPreparer.prepare,
            async terminate(request) {
              if (request.outcome === "timed_out") {
                await mutationTerminal.timeoutMutation({
                  knowledgeBaseId: request.work.knowledgeBaseId,
                  operationPublicId: request.work.publicId,
                  completedAt: request.completedAt,
                  resultExpiresAt: request.resultExpiresAt
                });
                return;
              }
              await mutationTerminal.failMutation({
                knowledgeBaseId: request.work.knowledgeBaseId,
                operationPublicId: request.work.publicId,
                resultCode: request.resultCode,
                completedAt: request.completedAt,
                resultExpiresAt: request.resultExpiresAt
              });
            }
          },
          limits: {
            maximumConcurrency: settings.roleConcurrency,
            maximumAttempts: settings.jobMaxAttempts,
            attemptDeadlineMilliseconds: settings.lockTtlSeconds * 1_000,
            heartbeatIntervalMilliseconds: settings.heartbeatIntervalMs,
            leaseTtlMilliseconds: settings.lockTtlSeconds * 1_000,
            retryDelayMilliseconds: settings.jobRetryDelayMs,
            resultRetentionMilliseconds:
              settings.completedJobRetentionDays * MILLISECONDS_PER_DAY,
            rollbackRetentionMilliseconds:
              settings.completedJobRetentionDays * MILLISECONDS_PER_DAY
          },
          clock: now,
          onFailure(failure) {
            logger.error("publication_worker.item_failed", {
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
      }
    });
    logger.info("publication_worker.started");
    try {
      await role.run(abort.signal);
    } finally {
      await closeSearchProvider(searchProvider);
      resourceBudgetReporter.report(resourceBudgets, { force: true });
      logger.info("publication_worker.stopped");
    }
  } finally {
    stop();
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.removeListener(signal, stop);
    }
    if (redisConnected) await redisClient.close();
    s3.destroy();
    await closeDatabaseClient(sql);
  }
}

function now(): string {
  return new Date().toISOString();
}

async function closeSearchProvider(
  provider: SearchProviderRuntime | null
): Promise<void> {
  if (provider) await provider.close();
}
