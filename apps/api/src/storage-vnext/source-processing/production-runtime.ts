import { S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { readModelSuggestions } from "../../admin/model-suggestions.js";
import type { RuntimeConfig } from "../../config.js";
import { closeDatabaseClient, createDatabaseClient } from "../../db/client.js";
import { assertRuntimeSchemaGeneration } from "../../db/migrations.js";
import {
  createDynamicRuntimeSearchQueryProvider
} from "../../runtime/search-provider.js";
import {
  assertNodeJiebaRuntimeAvailable,
  createNodeJiebaTokenizer
} from "../../infrastructure/tokenization/nodejieba-tokenizer.js";
import { createRuntimeLogger } from "../../logger.js";
import { tokenizerDiagnosticFields } from "../../runtime/diagnostic-fields.js";
import { createProcessResourceBudgets } from "../../runtime/resource-budget.js";
import { createResourceBudgetReporter } from "../../runtime/resource-budget-reporter.js";
import {
  createRedisClient,
  createRedisCoordinator
} from "../../redis/coordination.js";
import { createResilientRedisCoordinator } from "../../redis/resilient-coordinator.js";
import { registerWorkerRedisRuntimeEvents } from "../../redis/worker-runtime.js";
import {
  createModelAssistanceGateway
} from "../../runtime-settings/model-assistance-gateway.js";
import { createRuntimeSettingsRepository } from "../../runtime-settings/repository.js";
import {
  resolveResourceBudgetLimits
} from "../../runtime-settings/resource-budget-settings.js";
import { createRuntimeSettingsService } from "../../runtime-settings/service.js";
import {
  createGraphRagSourceWorkerRuntime,
  resolveGraphRagPoolSize,
  type GraphRagSourceWorkerRuntime
} from "../../semantic/graphrag/source-worker-runtime.js";
import { createSemanticSourceHandoff } from
  "../../semantic/application/source-handoff.js";
import { createPostgresSemanticGenerationRepository } from
  "../../semantic/infrastructure/postgres-generation-repository.js";
import { createPostgresSemanticStageRepository } from
  "../../semantic/infrastructure/postgres-stage-repository.js";
import { createPostgresEmbeddingConfigurationRepository } from
  "../../semantic/infrastructure/postgres-embedding-configuration-repository.js";
import { createSemanticSourceStageProductionRuntime } from
  "../../semantic/infrastructure/source-stage-production-runtime.js";
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
  createPostgresStorageVnextReleaseRepository
} from "../release/postgres-repository.js";
import {
  createPostgresStorageVnextActiveSearchProjectionRepository
} from "../search/postgres-active-projection.js";
import {
  createStorageVnextGraphCandidateSearch
} from "../search/graph-candidate-search.js";
import { createStorageVnextSearchSettings } from "../search/settings.js";
import {
  createPostgresStorageVnextWorkflowRepository
} from "../workflow/postgres-repository.js";
import { createStorageVnextWebhookOutbox } from "../webhook/outbox.js";
import { createPostgresStorageVnextSourceEventRepository } from
  "../source-events/postgres-repository.js";
import { createPostgresStorageVnextWebhookRepository } from
  "../webhook/postgres-repository.js";
import { createStorageVnextSourceGraphExtractor } from "./graph-extractor.js";
import { createStorageVnextSourceModelAdapter } from "./model-adapter.js";
import { createStorageVnextSourceModelAssistanceSelector } from
  "./model-assistance-selector.js";
import { createStorageVnextSourceReleaseHandoff } from "./release-handoff.js";
import { createStorageVnextSourceRoleRuntime } from "./role-runtime.js";
import { createStorageVnextSourceProcessingWorker } from "./worker.js";

const MILLISECONDS_PER_DAY = 86_400_000;

export async function runStorageVnextSourceWorker(config: RuntimeConfig): Promise<void> {
  if (!config.search) {
    throw new Error("Search configuration is required for the source worker");
  }
  const logger = createRuntimeLogger(config, console, { streamName: "source-worker" });
  const sql = createDatabaseClient(config, { role: "source-worker" });
  const redisClient = createRedisClient(config);
  const s3 = new S3Client(createS3ClientConfig(config.storage));
  const abort = new AbortController();
  const stop = () => abort.abort(new DOMException("Source worker shutting down", "AbortError"));
  let redisConnected = false;
  let graphRagRuntime: GraphRagSourceWorkerRuntime | null = null;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);
  registerWorkerRedisRuntimeEvents({ client: redisClient, logger, role: "source" });

  try {
    await assertRuntimeSchemaGeneration(sql);
    await redisClient.connect();
    redisConnected = true;
    assertNodeJiebaRuntimeAvailable();
    const tokenizer = createNodeJiebaTokenizer();
    logger.info("tokenizer.initialized", tokenizerDiagnosticFields());
    const redis = createResilientRedisCoordinator({
      client: redisClient,
      coordinator: createRedisCoordinator(redisClient, {
        keyPrefix: config.redis.keyPrefix ?? "focowiki"
      }),
      sessionWrites: "best_effort"
    });
    const runtimeSettingsRepository = createRuntimeSettingsRepository(sql);
    const runtimeSettings = createRuntimeSettingsService({
      config,
      repository: runtimeSettingsRepository,
      redis
    });
    await runtimeSettings.ensureBootstrapped();
    const initialSnapshot = await runtimeSettings.getSnapshot();
    const semanticPythonConcurrency = resolveGraphRagPoolSize(
      initialSnapshot.worker.sourceFileConcurrency
    );
    graphRagRuntime = createGraphRagSourceWorkerRuntime({
      poolSize: semanticPythonConcurrency
    });
    await graphRagRuntime.start();
    logger.info("graphrag_adapter.ready", graphRagRuntime.pool.stats());
    const resourceBudgets = createProcessResourceBudgets(
      resolveResourceBudgetLimits(initialSnapshot)
    );
    const resourceBudgetReporter = createResourceBudgetReporter({ logger });
    const modelGateway = createModelAssistanceGateway({ budget: resourceBudgets.model });
    const catalog = createPostgresStorageVnextCatalogRepository(sql);
    const webhookRepository = createPostgresStorageVnextWebhookRepository(sql);
    const workflow = createPostgresStorageVnextWorkflowRepository(sql);
    const graph = createPostgresStorageVnextGraphRepository(sql);
    const releases = createPostgresStorageVnextReleaseRepository(sql);
    const sourceEvents = createPostgresStorageVnextSourceEventRepository(sql);
    const semanticGenerations = createPostgresSemanticGenerationRepository(sql);
    const semanticStages = createPostgresSemanticStageRepository(sql);
    const embeddingConfigurations =
      createPostgresEmbeddingConfigurationRepository(sql);
    const bodyStore = createS3StorageVnextSourceBodyStore({
      client: s3,
      bucket: config.storage.bucket,
      prefix: config.storage.prefix
    });
    const searchProvider = createDynamicRuntimeSearchQueryProvider({
      config: config.search,
      tokenizer,
      indexDefinition: createStorageVnextSearchSettings({
        searchCutoffMs: initialSnapshot.search.engineSearchCutoffMs
      }),
      async resolveSettings() {
        const snapshot = await runtimeSettings.getSnapshot();
        return snapshot.search;
      }
    });
    const candidates = createStorageVnextGraphCandidateSearch({
      projections: createPostgresStorageVnextActiveSearchProjectionRepository(sql),
      provider: searchProvider,
      async resolveDeadlineMs() {
        const snapshot = await runtimeSettings.getSnapshot();
        return snapshot.search.requestTimeoutMs;
      },
      graph
    });
    const semanticRole = createSemanticSourceStageProductionRuntime({
      sql,
      s3,
      bucket: config.storage.bucket,
      storagePrefix: config.storage.prefix,
      searchIndexPrefix: config.search.indexPrefix,
      searchVector: searchProvider.vector,
      catalog,
      bodyStore,
      releases,
      workflow,
      graphRagPool: graphRagRuntime.pool,
      runtimeSettings,
      generationModels: runtimeSettingsRepository,
      modelGateway,
      owner: `semantic-source-worker-${randomUUID()}`,
      sourceConcurrency: initialSnapshot.worker.sourceFileConcurrency,
      pythonConcurrency: semanticPythonConcurrency,
      claimBatchSize: initialSnapshot.worker.claimBatchSize,
      pollIntervalMs: initialSnapshot.worker.pollIntervalMs,
      leaseDurationMs: initialSnapshot.worker.lockTtlSeconds * 1_000,
      retryDelayMs: initialSnapshot.worker.jobRetryDelayMs,
      resultRetentionMilliseconds:
        initialSnapshot.worker.completedJobRetentionDays * MILLISECONDS_PER_DAY,
      onFailure({ error, stagePublicId }) {
        logger.error("semantic_stage.failed", {
          stagePublicId,
          errorClass: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message : String(error)
        });
      }
    });
    const reportProcessingMetrics = (options: { force?: boolean } = {}) => {
      if (!resourceBudgetReporter.report(resourceBudgets, options)) return;
      logger.info(
        "semantic.stage_metrics",
        semanticRole.stageDiagnosticFields()
      );
      logger.info(
        "semantic.embedding_batch_metrics",
        semanticRole.embeddingBatchDiagnosticFields()
      );
    };
    const role = createStorageVnextSourceRoleRuntime({
      owner: `source-worker-${randomUUID()}`,
      clock: now,
      async getSettings() {
        const snapshot = await runtimeSettings.getSnapshot();
        resourceBudgets.update(resolveResourceBudgetLimits(snapshot));
        reportProcessingMetrics();
        return { ...snapshot.worker, snapshot };
      },
      recoverStale(request) {
        return workflow.recoverStale({
          kinds: ["source"],
          expiredBefore: request.expiredBefore,
          retryAt: request.retryAt,
          reasonCode: "STALE_LEASE",
          limit: request.limit
        });
      },
      createWorker({ snapshot, ...settings }) {
        const modelAssistance = modelGateway.resolve(snapshot);
        const graphExtractor = createStorageVnextSourceGraphExtractor({
          tokenizer,
          candidates,
          limits: {
            maximumCandidateNodes: snapshot.graph.candidateLimit,
            acceptedEdgeLimit: snapshot.graph.acceptedEdgeLimit,
            genericPhraseThreshold: snapshot.graph.genericPhraseThreshold
          },
          ...(snapshot.graph.modelReviewEnabled && modelAssistance
            ? {
                modelConfirmation: (request) => request.modelAssistanceSelected
                  ? {
                      client: modelAssistance.client,
                      modelName: modelAssistance.modelName,
                      contextWindowTokens: modelAssistance.contextWindowTokens,
                      receiveTimeouts: modelAssistance.receiveTimeouts
                    }
                  : null
              }
            : {})
        });
        const model = createStorageVnextSourceModelAdapter({
          ...(modelAssistance
            ? {
                selectModelAssistance:
                  createStorageVnextSourceModelAssistanceSelector(),
                async suggest(request) {
                  throwIfAborted(request.signal);
                  const result = await readModelSuggestions({
                    sources: [{
                      id: request.sourceFilePublicId,
                      fileName: request.fileName,
                      title: request.title,
                      type: request.type,
                      tags: request.tags,
                      body: request.body
                    }],
                    modelAssistance
                  });
                  throwIfAborted(request.signal);
                  return {
                    suggestions: result.suggestionsBySourceId.get(request.sourceFilePublicId) ?? null,
                    warningCount: result.warnings.length
                  };
                }
              }
            : {}),
          extractGraph: graphExtractor
        });
        const publicationDelayMilliseconds = snapshot.publication.mode === "per_file"
          ? 0
          : snapshot.publication.intervalSeconds * 1_000;
        const resultRetentionMilliseconds =
          settings.completedJobRetentionDays * MILLISECONDS_PER_DAY;
        const handoff = createStorageVnextSourceReleaseHandoff({
          graph,
          releases,
          workflow,
          publicationDelayMilliseconds,
          resultRetentionMilliseconds
        });
        const semanticHandoff = createSemanticSourceHandoff({
          generations: semanticGenerations,
          generationModels: runtimeSettingsRepository,
          stages: semanticStages,
          embeddingConfigurations,
          resolveRuntimeSettings: async () => snapshot,
          searchProviderKind: config.search!.provider,
          maximumAttempts: settings.jobMaxAttempts,
          maximumSourceBytes: config.pagination.generatedContentMaxBytes
        });
        return createStorageVnextSourceProcessingWorker({
          workflow,
          catalog,
          bodyStore,
          model,
          modelInvocation: modelAssistance
            ? { modelName: modelAssistance.modelName }
            : null,
          handoff,
          semanticHandoff,
          events: sourceEvents,
          webhooks: createStorageVnextWebhookOutbox({
            repository: webhookRepository,
            resultRetentionMilliseconds,
            clock: now
          }),
          onWebhookError(error) {
            logger.warn("source_worker.webhook_enqueue_failed", {
              errorClass: error instanceof Error ? error.name : "UnknownError"
            });
          },
          limits: {
            maximumConcurrency: settings.sourceFileConcurrency,
            maximumSourceBytes: config.pagination.generatedContentMaxBytes,
            maximumAttempts: settings.jobMaxAttempts,
            attemptDeadlineMilliseconds: settings.lockTtlSeconds * 1_000,
            retryDelayMilliseconds: settings.jobRetryDelayMs,
            resultRetentionMilliseconds
          },
          clock: now,
          onFailure(failure) {
            logger.error("source_worker.item_failed", {
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
    logger.info("source_worker.started");
    const roleRuns = [role.run(abort.signal), semanticRole.run(abort.signal)];
    try {
      await Promise.all(roleRuns);
    } finally {
      stop();
      await Promise.allSettled(roleRuns);
      await searchProvider.close();
      reportProcessingMetrics({ force: true });
      logger.info("source_worker.stopped");
    }
  } finally {
    stop();
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.removeListener(signal, stop);
    }
    if (redisConnected) await redisClient.close();
    await graphRagRuntime?.close();
    s3.destroy();
    await closeDatabaseClient(sql);
  }
}

function now(): string {
  return new Date().toISOString();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Source model request aborted", "AbortError");
  }
}
