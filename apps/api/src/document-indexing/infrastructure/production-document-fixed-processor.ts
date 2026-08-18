import { S3Client } from "@aws-sdk/client-s3";
import type { RuntimeConfig, WorkerRuntimeConfig } from "../../config.js";
import type { DatabaseClient } from "../../db/client.js";
import type { createNodeJiebaTokenizer } from
  "../../infrastructure/tokenization/nodejieba-tokenizer.js";
import type { createRuntimeSearchProvider } from "../../runtime/search-provider.js";
import type { RuntimeSearchSettings } from "../../runtime-settings/types.js";
import { createRuntimeSettingsRepository } from
  "../../runtime-settings/repository.js";
import { loadDeploymentSecret } from "../../security/runtime-secrets.js";
import { createEmbeddingArtifactService } from "../../semantic/embedding/artifact-service.js";
import { createEmbeddingGateway } from "../../semantic/embedding/gateway.js";
import { createOpenAiCompatibleEmbeddingTransport } from
  "../../semantic/embedding/openai-compatible-transport.js";
import { createGraphRagRuntime } from
  "../../semantic/graphrag/graph-rag-runtime.js";
import { createPostgresEmbeddingArtifactRepository } from
  "../../semantic/infrastructure/postgres-embedding-artifact-repository.js";
import { createPostgresEmbeddingConfigurationRepository } from
  "../../semantic/infrastructure/postgres-embedding-configuration-repository.js";
import { createS3EmbeddingArtifactStore } from
  "../../semantic/infrastructure/s3-embedding-artifact-store.js";
import { createS3ClientConfig } from "../../storage/s3.js";
import { createS3StorageVnextSourceBodyStore } from
  "../../storage-vnext/catalog/s3-source-body-store.js";
import {
  createS3StorageVnextFailedWriteProvider,
  createStorageVnextFailedWriteCompensator
} from "../../storage-vnext/ownership/failed-write-compensation.js";
import { createStorageVnextImmutableObjectWriter } from
  "../../storage-vnext/ownership/immutable-object-writer.js";
import { createPostgresStorageVnextOwnershipRepository } from
  "../../storage-vnext/ownership/postgres-repository.js";
import { createS3StorageVnextImmutableBodyStore } from
  "../../storage-vnext/ownership/s3-immutable-body-store.js";
import { createStorageVnextSearchSettings } from
  "../../storage-vnext/search/settings.js";
import { createDocumentFixedDagRuntime } from "../application/document-fixed-dag-runtime.js";
import { createDocumentFixedDagScheduler } from "../application/document-fixed-dag-scheduler.js";
import { createDocumentResourceLanes } from "../application/document-resource-lanes.js";
import type { DocumentResourceCapacityInput } from
  "../application/document-resource-capacity.js";
import {
  resolveDocumentFinalizationCapacity,
  resolveDocumentProjectionCapacities
} from
  "../application/document-resource-capacity.js";
import { createWeightedGenerationTaskRunner } from "../application/weighted-generation-task-runner.js";
import { createPostgresDocumentMachineProjectionReader } from
  "./postgres-document-machine-projection-reader.js";
import { createProductionDocumentActivateWorkHandler } from
  "./production-document-activate-work-handler.js";
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
import { safeErrorCode, isRetryable } from
  "./production-document-error-diagnostic.js";
import {
  createDocumentCleanupReceiptHandler,
  waitForDocumentWork
} from "./production-document-fixed-runtime-support.js";
import type { DocumentWorkerObservability } from
  "../application/document-worker-observability.js";
import { createPostgresProjectionScopeSnapshot } from
  "./postgres-projection-scope-snapshot.js";
import { createPostgresProjectionScopeOutputRepository } from
  "./postgres-projection-scope-output-repository.js";
import { createProductionDocumentScopeProjector } from
  "./production-document-scope-projector.js";

export function createProductionDocumentFixedProcessor(input: {
  sql: DatabaseClient;
  config: RuntimeConfig;
  workerConfig: Required<WorkerRuntimeConfig>;
  resourceCapacity: DocumentResourceCapacityInput;
  searchSettings: RuntimeSearchSettings;
  tokenizer: ReturnType<typeof createNodeJiebaTokenizer>;
  searchProvider: ReturnType<typeof createRuntimeSearchProvider>;
  workerId: string;
  observability?: Pick<DocumentWorkerObservability, "work">;
}) {
  const resources = createFixedResources(input);
  const projectionCapacities = resolveDocumentProjectionCapacities({
    documentConcurrency: input.resourceCapacity.documentConcurrency
  });
  const repositories = createProductionDocumentFixedRepositories(
    input.sql,
    input.workerConfig.completedJobRetentionDays * 86_400_000
  );
  const scopeOutputs = createPostgresProjectionScopeOutputRepository(input.sql);
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
    referenceFacts: repositories.referenceFacts
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
      deploymentSecret: resources.deploymentSecret
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
      generatedContext: repositories.generatedContext,
      machineProjection: resources.machineProjection,
      semanticSearch,
      searchFamilies: repositories.searchFamilies,
      dirtyScopes: repositories.dirtyScopes,
      projectionFacts: repositories.projectionFacts,
      scopeContributions: repositories.scopeContributions,
      work: repositories.work,
      tokenizer: resources.tokenizer,
      activationOwners: repositories.activationOwners,
      objectWriter: resources.writer,
      ownership: resources.ownership,
      lanes: resources.lanes
    }),
    activate: createProductionDocumentActivateWorkHandler({
      work: repositories.work,
      receipts: repositories.receipts,
      loadManifest: loaders.manifest,
      pages: repositories.pages,
      scopeOutputs,
      activationOwners: repositories.activationOwners,
      directoryNavigation: repositories.directoryNavigation,
      lanes: resources.lanes
    }),
    cleanup: createDocumentCleanupReceiptHandler({ sql: input.sql })
  };
  const scheduler = createDocumentFixedDagScheduler({
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
      return { code, safeMessage: null, retryable: isRetryable(code) };
    },
    retryDelayMs: (attempt) => input.workerConfig.jobRetryDelayMs * attempt,
    onWorkEvent(event) {
      input.observability?.work({
        event: event.event,
        workPublicId: event.work.publicId,
        documentJobPublicId: event.work.documentJobPublicId,
        workKind: event.work.kind,
        resourceLane: event.work.resourceLane,
        attemptCount: event.work.attemptCount,
        errorCode: event.errorCode,
        ...(event.errorConstraint === undefined
          ? {} : { errorConstraint: event.errorConstraint }),
        ...(event.errorResource === undefined
          ? {} : { errorResource: event.errorResource }),
        ...(event.errorTarget === undefined
          ? {} : { errorTarget: event.errorTarget })
      });
    }
  });
  const scopeSnapshots = createPostgresProjectionScopeSnapshot(input.sql);
  const graphConfig = input.config.graph;
  if (!graphConfig) missingGraphConfig();
  const scopeRenderer = createProductionDocumentScopeRenderer({
    snapshots: scopeSnapshots,
    machineProjection: resources.machineProjection,
    scopeContributions: repositories.scopeContributions,
    sourceProjection: createProductionDocumentSourceScopeProjection({
      bases: repositories.bases,
      relations: repositories.relations,
      loadBase: loaders.pageBase,
      readConcurrency: input.resourceCapacity.sourceObjectReadConcurrency
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
    ownership: resources.ownership,
    maximumRecordsPerShard: graphConfig.shardSize,
    maximumShardBytes: 1_048_576
  });
  const scopeRuntime = createProductionDocumentScopeProjector({
    sql: input.sql,
    workerId: input.workerId,
    leaseDurationMs: input.workerConfig.lockTtlSeconds * 1_000,
    maximumConcurrency: projectionCapacities.scopeProjection,
    retryDelayMs: input.workerConfig.jobRetryDelayMs,
    repositories,
    outputs: scopeOutputs,
    renderer: scopeRenderer,
    ownership: resources.ownership
  });
  return {
    async run(signal: AbortSignal) {
      await Promise.all([runtime.run(signal), scopeRuntime.run(signal)]);
    },
    async start() { await resources.graphRag.start(); },
    async close() {
      await Promise.allSettled([resources.graphRag.close()]);
      resources.s3.destroy();
    },
    snapshot() {
      return {
        activeWork: runtime.activeCount(),
        activeScopeProjection: scopeRuntime.activeCount(),
        resources: resources.lanes.snapshot(),
        generation: generation.snapshot()
      };
    }
  };
}

function createFixedResources(input: Parameters<
  typeof createProductionDocumentFixedProcessor
>[0]) {
  const s3 = new S3Client(createS3ClientConfig(input.config.storage));
  const ownership = createPostgresStorageVnextOwnershipRepository(input.sql);
  const bodies = createS3StorageVnextImmutableBodyStore({
    client: s3,
    bucket: input.config.storage.bucket,
    prefix: input.config.storage.prefix
  });
  const writer = createStorageVnextImmutableObjectWriter({
    registrations: ownership,
    bodyStore: bodies,
    compensation: createStorageVnextFailedWriteCompensator({
      registrations: ownership,
      provider: createS3StorageVnextFailedWriteProvider({
        client: s3,
        bucket: input.config.storage.bucket,
        prefix: input.config.storage.prefix
      })
    }),
    clock: () => new Date().toISOString()
  });
  const projectionCapacities = resolveDocumentProjectionCapacities({
    documentConcurrency: input.resourceCapacity.documentConcurrency
  });
  const lanes = createDocumentResourceLanes({
    capacities: {
      postgres_s3: Math.min(
        input.resourceCapacity.sourceObjectReadConcurrency,
        Math.max(1, input.resourceCapacity.databaseConnectionLimit - 1)
      ),
      generation_model: input.resourceCapacity.generationModelConcurrency,
      graphrag_adapter: input.resourceCapacity.graphRagConcurrency,
      embedding: input.resourceCapacity.embeddingConcurrency,
      search_transport: input.resourceCapacity.searchConcurrency,
      projection: projectionCapacities.documentPreparation,
      activation: resolveDocumentFinalizationCapacity(input.resourceCapacity),
      cleanup: 1
    },
    maximumWaitersPerLane: input.resourceCapacity.documentConcurrency * 8
  });
  if (!input.config.search) missingSearchConfig();
  const embeddingConfigurations =
    createPostgresEmbeddingConfigurationRepository(input.sql);
  const deploymentSecret = loadDeploymentSecret();
  const embeddingGateway = createEmbeddingGateway({
    transport: createOpenAiCompatibleEmbeddingTransport(),
    deploymentSecret
  });
  const embeddingArtifacts = createEmbeddingArtifactService({
    gateway: embeddingGateway,
    repository: createPostgresEmbeddingArtifactRepository(input.sql),
    store: createS3EmbeddingArtifactStore({
      client: s3,
      bucket: input.config.storage.bucket,
      prefix: input.config.storage.prefix
    })
  });
  const machineProjection = createPostgresDocumentMachineProjectionReader(input.sql);
  return {
    s3,
    ownership,
    bodies,
    writer,
    sourceBodies: createS3StorageVnextSourceBodyStore({
      client: s3,
      bucket: input.config.storage.bucket,
      prefix: input.config.storage.prefix
    }),
    lanes,
    tokenizer: input.tokenizer,
    searchProvider: input.searchProvider,
    embeddingConfigurations,
    embeddingGateway,
    embeddingArtifacts,
    runtimeSettings: createRuntimeSettingsRepository(input.sql),
    graphRag: createGraphRagRuntime({
      poolSize: input.resourceCapacity.graphRagConcurrency
    }),
    deploymentSecret,
    machineProjection
  };
}

function missingSearchConfig(): never {
  throw processorError("search_configuration_missing");
}

function missingGraphConfig(): never {
  throw processorError("graph_configuration_missing");
}
