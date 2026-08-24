import type { RuntimeConfig, WorkerRuntimeConfig } from "../../config.js";
import { getHeapStatistics } from "node:v8";
import type { DatabaseClient } from "../../db/client.js";
import type { createNodeJiebaTokenizer } from
  "../../infrastructure/tokenization/nodejieba-tokenizer.js";
import type { createRuntimeSearchProvider } from "../../runtime/search-provider.js";
import type { RuntimeSearchSettings } from "../../runtime-settings/types.js";
import { createStorageVnextSearchSettings } from
  "../../storage-vnext/search/settings.js";
import { createDocumentFixedDagRuntime } from "../application/document-fixed-dag-runtime.js";
import { createDocumentFixedDagScheduler } from "../application/document-fixed-dag-scheduler.js";
import type { DocumentResourceCapacityInput } from
  "../application/document-resource-capacity.js";
import {
  resolveDocumentResourceLaneCapacities,
  resolveDocumentPublicationS3Capacities,
  resolveDocumentProjectionCapacities,
  resolveDocumentPublicationMemoryCapacity
} from
  "../application/document-resource-capacity.js";
import { createWeightedGenerationTaskRunner } from "../application/weighted-generation-task-runner.js";
import { createProductionDocumentContentProjectionWorkHandler } from
  "./production-document-content-projection-work-handler.js";
import { createProductionDocumentFirstLayerWorkHandler } from
  "./production-document-first-layer-work-handler.js";
import { createProductionDocumentGraphRagWorkHandler } from
  "./production-document-graphrag-work-handler.js";
import { createProductionDocumentKnowledgeProjectionWorkHandler } from
  "./production-document-knowledge-projection-work-handler.js";
import { createProductionDocumentPageBase } from
  "./production-document-page-base.js";
import { createProductionDocumentPrepareWorkHandler } from
  "./production-document-prepare-work-handler.js";
import { createProductionDocumentRelationReconcileWorkHandler } from
  "./production-document-relation-reconcile-work-handler.js";
import { createProductionDocumentInternalHybridCandidateSearch } from
  "./production-document-internal-hybrid-candidate-search.js";
import { createProductionDocumentSemanticSearchProjection } from
  "./production-document-semantic-search-projection.js";
import { createProductionDocumentScopeRenderer } from
  "./production-document-scope-renderer.js";
import { createProductionDocumentSourceScopeProjection } from
  "./production-document-source-scope-projection.js";
import {
  awaitProviderReceipt,
  processorError
} from "./production-document-processor-support.js";
import { createWorkerDocumentSearchRuntime } from
  "./worker-document-search-runtime.js";
import {
  createProductionDocumentFixedLoaders,
  createProductionDocumentFixedRepositories
} from "./production-document-fixed-components.js";
import { isAutomaticallyRetryable, isRetryable, safeErrorCode } from
  "./production-document-error-diagnostic.js";
import {
  createDocumentCleanupReceiptHandler,
  waitForDocumentWork
} from "./production-document-fixed-runtime-support.js";
import type { DocumentWorkerObservability } from
  "../application/document-worker-observability.js";
import { createDocumentProjectionCleanupRuntime } from
  "../application/document-projection-cleanup-runtime.js";
import { createPostgresProjectionCleanupOutbox } from
  "./postgres-projection-cleanup-outbox.js";
import {
  observeProductionDocumentWorkEvent
} from "./production-document-failure-observability.js";
import { createProductionDocumentFixedResources } from
  "./production-document-fixed-resources.js";
import { createProductionDocumentPublicationScopeRuntime } from
  "./production-document-publication-scope-runtime.js";
import { createProductionDocumentPublicationCoordinatorRuntime } from
  "./production-document-publication-coordinator-runtime.js";
import { createProductionDocumentPublicationCutoverRuntime } from
  "./production-document-publication-cutover-runtime.js";

export function createProductionDocumentFixedProcessor(input: {
  sql: DatabaseClient;
  config: RuntimeConfig;
  workerConfig: Required<WorkerRuntimeConfig>;
  resourceCapacity: DocumentResourceCapacityInput;
  searchSettings: RuntimeSearchSettings;
  tokenizer: ReturnType<typeof createNodeJiebaTokenizer>;
  searchProvider: ReturnType<typeof createRuntimeSearchProvider>;
  workerId: string;
  observability?: Pick<
    DocumentWorkerObservability,
    "work" | "providerFailure" | "ingestionFailure" | "publication"
      | "publicationBacklog" | "publicationScope" | "publicationStorage"
      | "publicationProjection" | "publicationScopeStage"
      | "publicationResourcePressure" | "storageRequest" | "cleanup"
  >;
}) {
  let currentResourceCapacity = { ...input.resourceCapacity };
  const resources = createProductionDocumentFixedResources(input);
  const projectionCapacities = resolveDocumentProjectionCapacities({
    documentConcurrency: input.resourceCapacity.documentConcurrency
  });
  let publicationS3Capacities = resolveDocumentPublicationS3Capacities({
    documentConcurrency: input.resourceCapacity.documentConcurrency,
    sourceObjectReadConcurrency: input.resourceCapacity.sourceObjectReadConcurrency
  });
  const repositories = createProductionDocumentFixedRepositories(
    input.sql,
    input.workerConfig.completedJobRetentionDays * 86_400_000,
    projectionBacklogLimit(input.resourceCapacity.documentConcurrency)
  );
  const loaders = createProductionDocumentFixedLoaders({
    contexts: repositories.contexts,
    receipts: repositories.receipts,
    bodies: resources.bodies,
    maximumBytes: input.config.pagination.generatedContentMaxBytes
  });
  const generation = createWeightedGenerationTaskRunner({
    configuredMaximum: input.resourceCapacity.generationModelConcurrency,
    maximumWaiters: input.resourceCapacity.documentConcurrency * 8,
    weights: {
      first_layer: 8,
      graphrag: 4,
      candidate_delta: 2,
      slow_retry: 1
    }
  });
  const search = createWorkerDocumentSearchRuntime({
    provider: resources.searchProvider,
    settings: input.searchSettings,
    definition: createStorageVnextSearchSettings({
      searchCutoffMs: input.searchSettings.engineSearchCutoffMs
    }),
    owners: repositories.searchOwners,
    awaitReceipt: (receipt, signal) => awaitProviderReceipt(
      resources.searchProvider,
      receipt,
      input.searchSettings,
      signal
    )
  });
  const pageBase = createProductionDocumentPageBase({
    contexts: repositories.contexts,
    preparedSources: loaders.prepared,
    firstLayers: loaders.firstLayer,
    generatedContext: repositories.generatedContext,
    bases: repositories.bases,
    objectWriter: resources.writer,
    ownership: resources.ownership
  });
  const semanticSearch = createProductionDocumentSemanticSearchProjection({
    sql: input.sql,
    config: input.config,
    facts: loaders.facts,
    embeddingConfigurations: resources.embeddingConfigurations,
    embeddingArtifacts: resources.embeddingArtifacts,
    search,
    searchFamilies: repositories.searchFamilies,
    lanes: resources.lanes
  });
  const internalCandidates = createProductionDocumentInternalHybridCandidateSearch({
    sql: input.sql,
    config: input.config,
    provider: resources.searchProvider,
    embeddingConfigurations: resources.embeddingConfigurations,
    embeddingGateway: resources.embeddingGateway,
    referenceFacts: repositories.referenceFacts,
    lanes: resources.lanes
  });
  const handlers = {
    prepare: createProductionDocumentPrepareWorkHandler({
      contexts: repositories.contexts,
      receipts: repositories.receipts,
      bodyStore: resources.sourceBodies,
      snapshotBodies: resources.bodies,
      tokenizer: resources.tokenizer,
      objectWriter: resources.writer,
      ownership: resources.ownership,
      referenceFacts: repositories.referenceFacts,
      maximumSourceBytes: input.config.pagination.generatedContentMaxBytes
    }),
    first_layer: createProductionDocumentFirstLayerWorkHandler({
      contexts: repositories.contexts,
      preparedSources: loaders.prepared,
      modelRevisions: resources.runtimeSettings,
      modelTraces: repositories.modelTraces,
      modelLayerExecutions: repositories.modelLayers,
      modelEvaluations: repositories.modelEvaluations,
      tokenizer: resources.tokenizer,
      generation,
      objectWriter: resources.writer,
      ownership: resources.ownership,
      deploymentSecret: resources.deploymentSecret,
      onProviderFailure: resources.onProviderFailure
    }),
    content_projection: createProductionDocumentContentProjectionWorkHandler({
      sql: input.sql,
      config: input.config,
      contexts: repositories.contexts,
      preparedSources: loaders.prepared,
      embeddingConfigurations: resources.embeddingConfigurations,
      embeddingArtifacts: resources.embeddingArtifacts,
      search,
      searchFamilies: repositories.searchFamilies,
      lanes: resources.lanes
    }),
    graphrag: createProductionDocumentGraphRagWorkHandler({
      contexts: repositories.contexts,
      preparedSources: loaders.prepared,
      firstLayers: loaders.firstLayer,
      modelRevisions: resources.runtimeSettings,
      modelLayerExecutions: repositories.modelLayers,
      semanticFacts: repositories.semanticFacts,
      semanticFactReuse: repositories.semanticFactReuse,
      graphRag: resources.graphRag,
      generation,
      chunks: repositories.graphRagChunks,
      objectWriter: resources.writer,
      bodies: resources.bodies,
      ownership: resources.ownership,
      deploymentSecret: resources.deploymentSecret,
      onProviderFailure: resources.onProviderFailure,
      chunkLeaseDurationMs: input.workerConfig.lockTtlSeconds * 1_000
    }),
    relation_reconcile: createProductionDocumentRelationReconcileWorkHandler({
      contexts: repositories.contexts,
      preparedSources: loaders.prepared,
      firstLayers: loaders.firstLayer,
      semanticFacts: loaders.facts,
      referenceFacts: repositories.referenceFacts,
      internalCandidates,
      modelRevisions: resources.runtimeSettings,
      modelLayerExecutions: repositories.modelLayers,
      modelEvaluations: repositories.modelEvaluations,
      generation,
      deploymentSecret: resources.deploymentSecret,
      onProviderFailure: resources.onProviderFailure,
      pairs: repositories.pairs
    }),
    knowledge_projection: createProductionDocumentKnowledgeProjectionWorkHandler({
      contexts: repositories.contexts,
      preparedSources: loaders.prepared,
      receipts: repositories.receipts,
      pageBase,
      bases: repositories.bases,
      loadBase: loaders.pageBase,
      relations: repositories.relations,
      semanticSearch,
      work: repositories.work,
      tokenizer: resources.tokenizer,
      lanes: resources.lanes
    }),
    cleanup: createDocumentCleanupReceiptHandler({ sql: input.sql })
  };
  const scheduler = createDocumentFixedDagScheduler({
    claimLimit: input.workerConfig.claimBatchSize,
    work: repositories.work,
    lanes: resources.lanes
  });
  const runtime = createDocumentFixedDagRuntime({
    workerId: input.workerId,
    leaseDurationMs: input.workerConfig.lockTtlSeconds * 1_000,
    heartbeatIntervalMs: input.workerConfig.heartbeatIntervalMs,
    scheduler,
    work: repositories.work,
    handlers,
    now: () => new Date().toISOString(),
    wait: waitForDocumentWork,
    classifyError(error) {
      const code = safeErrorCode(error);
      return {
        code,
        safeMessage: null,
        retryable: isRetryable(code),
        automaticRetry: isAutomaticallyRetryable(error, code)
      };
    },
    retryDelayMs: (attempt) => input.workerConfig.jobRetryDelayMs * attempt,
    onWorkEvent(event) {
      observeProductionDocumentWorkEvent(input.observability, event);
    }
  });
  const graphConfig = input.config.graph;
  if (!graphConfig) missingGraphConfig();
  const scopeRenderer = createProductionDocumentScopeRenderer({
    machineProjection: resources.machineProjection,
    sourceProjection: createProductionDocumentSourceScopeProjection({
      bases: repositories.bases,
      relations: repositories.relations,
      loadBase: loaders.pageBase,
      readConcurrency: () => Math.min(
        publicationS3Capacities.readsPerScope,
        currentResourceCapacity.sourceObjectReadConcurrency
      )
    }),
    directoryNavigation: repositories.directoryNavigation,
    directoryLeafLimits: {
      maxEntries: input.config.generated.directoryIndexMaxEntries,
      maxBytes: input.config.generated.directoryIndexMaxBytes,
      mergeBelowEntries: Math.max(1,
        Math.floor(input.config.generated.directoryIndexMaxEntries / 4))
    },
    rootLimits: {
      rootSummaryLimit: input.config.generated.rootSummaryLimit,
      okfLogMaxEntries: input.config.generated.okfLogMaxEntries,
      okfLogMaxBytes: input.config.generated.okfLogMaxBytes
    },
    objectWriter: resources.writer,
    objectBodies: resources.bodies,
    ownership: resources.ownership,
    maximumRecordsPerShard: graphConfig.shardSize,
    maximumShardBytes: 1_048_576
  });
  const publicationScopeRuntime =
    createProductionDocumentPublicationScopeRuntime({
      sql: input.sql,
      workerId: input.workerId,
      leaseDurationMs: input.workerConfig.lockTtlSeconds * 1_000,
      heartbeatIntervalMs: input.workerConfig.heartbeatIntervalMs,
      maximumConcurrency: publicationMemoryCapacity(Math.min(
        projectionCapacities.scopeProjection,
        publicationS3Capacities.scopeProjection
      )),
      renderer: scopeRenderer,
      ...(input.observability
        ? { observability: input.observability } : {})
    });
  const publicationCoordinatorRuntime =
    createProductionDocumentPublicationCoordinatorRuntime({
      sql: input.sql,
      ...(input.observability
        ? { observability: input.observability } : {})
    });
  const publicationCutoverRuntime =
    createProductionDocumentPublicationCutoverRuntime({ sql: input.sql });
  const projectionCleanup = createDocumentProjectionCleanupRuntime({
    workerId: `${input.workerId}:projection-cleanup`,
    leaseDurationMs: input.workerConfig.lockTtlSeconds * 1_000,
    concurrency: Math.min(4, projectionCapacities.scopeProjection),
    retryDelayMs: input.workerConfig.jobRetryDelayMs,
    outbox: createPostgresProjectionCleanupOutbox(input.sql),
    ownership: resources.ownership,
    now: () => new Date().toISOString(),
    wait: waitForDocumentWork,
    ...(input.observability
      ? { onMetrics: (fields: Parameters<
        DocumentWorkerObservability["cleanup"]
      >[0]) => input.observability?.cleanup(fields) }
      : {})
  });
  return {
    async run(signal: AbortSignal) {
      await Promise.all([
        runtime.run(signal),
        publicationScopeRuntime.run(signal),
        publicationCoordinatorRuntime.run(signal),
        publicationCutoverRuntime.run(signal),
        projectionCleanup.run(signal)
      ]);
    },
    async start() { await resources.graphRag.start(); },
    async updateRuntime(next: {
      workerConfig: Required<WorkerRuntimeConfig>;
      resourceCapacity: DocumentResourceCapacityInput;
    }): Promise<void> {
      const projection = resolveDocumentProjectionCapacities({
        documentConcurrency: next.resourceCapacity.documentConcurrency
      });
      const capacities = resolveDocumentResourceLaneCapacities(
        next.resourceCapacity
      );
      publicationS3Capacities = resolveDocumentPublicationS3Capacities({
        documentConcurrency: next.resourceCapacity.documentConcurrency,
        sourceObjectReadConcurrency:
          next.resourceCapacity.sourceObjectReadConcurrency
      });
      await resources.graphRag.resize(next.resourceCapacity.graphRagConcurrency);
      resources.lanes.updateCapacities(capacities);
      generation.updateLimits(
        next.resourceCapacity.generationModelConcurrency,
        next.resourceCapacity.documentConcurrency * 8
      );
      scheduler.updateClaimLimit(next.workerConfig.claimBatchSize);
      repositories.work.updateProjectionBacklogLimit(
        projectionBacklogLimit(next.resourceCapacity.documentConcurrency)
      );
      publicationScopeRuntime.updateMaximumConcurrency(
        publicationMemoryCapacity(Math.min(
          projection.scopeProjection,
          publicationS3Capacities.scopeProjection
        ))
      );
      Object.assign(input.workerConfig, next.workerConfig);
      currentResourceCapacity = { ...next.resourceCapacity };
    },
    async close() {
      await Promise.allSettled([resources.graphRag.close()]);
      resources.s3.destroy();
    },
    snapshot() {
      return {
        activeWork: runtime.activeCount(),
        activeScopeProjection: 0,
        activePublicationScopeProjection:
          publicationScopeRuntime.activeCount(),
        resources: resources.lanes.snapshot(),
        generation: generation.snapshot()
      };
    }
  };
}

function projectionBacklogLimit(documentConcurrency: number): number {
  return Math.max(documentConcurrency, documentConcurrency * 8);
}

function publicationMemoryCapacity(requestedConcurrency: number): number {
  return resolveDocumentPublicationMemoryCapacity({
    requestedConcurrency,
    heapLimitBytes: getHeapStatistics().heap_size_limit
  });
}

function missingGraphConfig(): never {
  throw processorError("graph_configuration_missing");
}
