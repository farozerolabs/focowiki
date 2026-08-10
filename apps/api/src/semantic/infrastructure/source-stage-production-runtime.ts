import type { S3Client } from "@aws-sdk/client-s3";
import type { ModelAssistanceOptions } from "../../admin/model-suggestions.js";
import type { SearchProviderVectorPort } from
  "../../application/ports/search-provider-runtime.js";
import type { DatabaseClient } from "../../db/client.js";
import type { RuntimeSettingsService } from "../../runtime-settings/service.js";
import type { RuntimeSettingsRepository } from
  "../../runtime-settings/repository.js";
import type { ModelAssistanceGateway } from
  "../../runtime-settings/model-assistance-gateway.js";
import { loadDeploymentSecret } from "../../security/runtime-secrets.js";
import type { StorageVnextCatalogRepository } from
  "../../storage-vnext/catalog/ports.js";
import type { StorageVnextSourceBodyReadPort } from
  "../../storage-vnext/catalog/s3-source-body-store.js";
import type {
  StorageVnextReleaseReadPort,
  StorageVnextReleaseWritePort
} from "../../storage-vnext/release/ports.js";
import { createStorageVnextSemanticPublicationHandoff } from
  "../../storage-vnext/release/semantic-handoff.js";
import type { StorageVnextWorkflowWritePort } from
  "../../storage-vnext/workflow/ports.js";
import { createSemanticCommunityStageHandler } from
  "../application/community-stage-handler.js";
import { createSemanticCommunitySummarizer } from
  "../application/community-summarizer.js";
import { createCommunityPartitionWorker } from
  "../application/community-worker.js";
import { createSemanticEmbeddingStageHandler } from
  "../application/embedding-stage-handler.js";
import { createSemanticExtractionStageHandler } from
  "../application/extraction-stage-handler.js";
import { createSemanticPublicationStageHandler } from
  "../application/publication-stage-handler.js";
import { createSemanticReconciliationStageHandler } from
  "../application/reconciliation-stage-handler.js";
import { createSemanticStageRoleRuntime } from
  "../application/stage-role-runtime.js";
import { resolveSemanticStageConcurrency } from
  "../application/stage-concurrency.js";
import { createSemanticStageMetrics } from
  "../application/stage-metrics.js";
import {
  createSemanticStageBudgetManager
} from "../application/stage-orchestration.js";
import { createSemanticStageWorker } from
  "../application/stage-worker.js";
import { createSemanticVectorStageHandler } from
  "../application/vector-stage-handler.js";
import { semanticVectorPlanSourcesAreCurrent } from
  "../application/vector-current-ownership.js";
import { createEmbeddingArtifactService } from
  "../embedding/artifact-service.js";
import { createEmbeddingGateway } from "../embedding/gateway.js";
import { createOpenAiCompatibleEmbeddingTransport } from
  "../embedding/openai-compatible-transport.js";
import { createPostgresSemanticSourceEmbeddingInputRepository } from
  "../embedding/source-input-repository.js";
import { createGraphRagExtractionGateway } from
  "../graphrag/extraction-gateway.js";
import {
  createGraphRagGenerationModelCompletion,
  createSemanticTextModelCompletion
} from "../graphrag/generation-model-completion.js";
import type { GraphRagPythonPool } from "../graphrag/python-pool.js";
import { createSemanticVectorProjectionService } from
  "../vector/projection-service.js";
import { createPostgresCommunityPartitionRepository } from
  "./postgres-community-partition-repository.js";
import { createPostgresCommunitySummaryArtifactRepository } from
  "./postgres-community-summary-artifacts.js";
import { createPostgresSemanticCommunitySummaryContext } from
  "./postgres-community-summary-context.js";
import { createPostgresEmbeddingArtifactRepository } from
  "./postgres-embedding-artifact-repository.js";
import { createPostgresEmbeddingConfigurationRepository } from
  "./postgres-embedding-configuration-repository.js";
import { createPostgresSemanticFactRepository } from
  "./postgres-fact-repository.js";
import { createPostgresSemanticGenerationRepository } from
  "./postgres-generation-repository.js";
import { createPostgresSemanticStageRepository } from
  "./postgres-stage-repository.js";
import { createPostgresSemanticStageSourceOwnership } from
  "./postgres-stage-source-ownership.js";
import { createPostgresSemanticSkeletonSignalRead } from
  "./postgres-skeleton-signals.js";
import { createPostgresSemanticVectorProjectionRepository } from
  "./postgres-vector-projection-repository.js";
import { createS3EmbeddingArtifactStore } from
  "./s3-embedding-artifact-store.js";

const SOURCE_STAGE_KINDS = [
  "extraction", "reconciliation", "community",
  "embedding", "vector", "publication"
] as const;

export function createSemanticSourceStageProductionRuntime(input: {
  sql: DatabaseClient;
  s3: S3Client;
  bucket: string;
  storagePrefix: string;
  searchIndexPrefix: string;
  searchVector: SearchProviderVectorPort;
  catalog: StorageVnextCatalogRepository;
  bodyStore: StorageVnextSourceBodyReadPort;
  releases: Pick<StorageVnextReleaseReadPort & StorageVnextReleaseWritePort,
    "getActiveRoot" | "getLiveCandidate" | "createCandidate" | "addCandidateFacts">;
  workflow: Pick<StorageVnextWorkflowWritePort, "enqueue" | "rescheduleQueued">;
  graphRagPool: GraphRagPythonPool;
  runtimeSettings: RuntimeSettingsService;
  generationModels: Pick<RuntimeSettingsRepository, "getModel">;
  modelGateway: ModelAssistanceGateway;
  owner: string;
  sourceConcurrency: number;
  pythonConcurrency: number;
  claimBatchSize: number;
  pollIntervalMs: number;
  leaseDurationMs: number;
  retryDelayMs: number;
  resultRetentionMilliseconds: number;
  deploymentSecretDirectory?: string;
  onFailure?: (input: { error: unknown; stagePublicId: string }) => void;
}) {
  const stages = createPostgresSemanticStageRepository(input.sql);
  const sourceOwnership = createPostgresSemanticStageSourceOwnership(input.sql);
  const skeletonSignals = createPostgresSemanticSkeletonSignalRead(input.sql);
  const facts = createPostgresSemanticFactRepository(input.sql);
  const generations = createPostgresSemanticGenerationRepository(input.sql);
  const communities = createPostgresCommunityPartitionRepository(input.sql);
  const embeddingConfigurations =
    createPostgresEmbeddingConfigurationRepository(input.sql);
  const artifactRepository = createPostgresEmbeddingArtifactRepository(input.sql);
  const artifactStore = createS3EmbeddingArtifactStore({
    client: input.s3,
    bucket: input.bucket,
    prefix: input.storagePrefix
  });
  const embeddingGateway = createEmbeddingGateway({
    transport: createOpenAiCompatibleEmbeddingTransport(),
    deploymentSecret: loadDeploymentSecret({
      directory: input.deploymentSecretDirectory
    })
  });
  const artifactService = createEmbeddingArtifactService({
    gateway: embeddingGateway,
    repository: artifactRepository,
    store: artifactStore
  });
  const stageMetrics = createSemanticStageMetrics();
  const sourceInputs = createPostgresSemanticSourceEmbeddingInputRepository(
    input.sql
  );
  const vectorProjections = createPostgresSemanticVectorProjectionRepository(
    input.sql
  );
  const vectorService = createSemanticVectorProjectionService({
    provider: input.searchVector,
    repository: vectorProjections,
    async isCurrent(plan) {
      if (!await generations.isWritableProjection({
        knowledgeBaseId: plan.knowledgeBaseId,
        semanticGenerationPublicId: plan.semanticGenerationPublicId,
        projectionContractPublicId: plan.projectionContractPublicId
      })) return false;
      return semanticVectorPlanSourcesAreCurrent(
        input.catalog,
        plan,
        sourceOwnership.isOwnedVectorPlan
      );
    }
  });
  const summaryContexts = createPostgresSemanticCommunitySummaryContext(input.sql);
  const summaryArtifacts = createPostgresCommunitySummaryArtifactRepository(input.sql);
  const summarizeCommunity = createSemanticCommunitySummarizer({
    contexts: summaryContexts,
    artifacts: summaryArtifacts,
    async resolveCompletion(stageClaim) {
      const assistance = await resolveModelAssistance(stageClaim);
      return createSemanticTextModelCompletion(assistance, {
        instructions: [
          "Write a concise factual summary from only the supplied entities and relationships.",
          "Do not invent facts and do not mention internal identifiers."
        ].join(" "),
        maximumOutputCharacters: 65_536
      });
    }
  });
  const publication = createStorageVnextSemanticPublicationHandoff({
    catalog: input.catalog,
    releases: input.releases,
    workflow: input.workflow,
    resultRetentionMilliseconds: input.resultRetentionMilliseconds
  });
  const handlers = {
    extraction: createSemanticExtractionStageHandler({
      catalog: input.catalog,
      isOwnedRevision: sourceOwnership.isOwnedRevision,
      bodyStore: input.bodyStore,
      loadSkeletonGraphSignals: skeletonSignals.load,
      facts,
      async resolveExtractor(claim) {
        const assistance = await resolveModelAssistance(claim);
        return createGraphRagExtractionGateway({
          pool: input.graphRagPool,
          model: createGraphRagGenerationModelCompletion(assistance),
          completionConcurrency: assistance.suggestionConcurrency,
          maximumChunkCharacters: snapshotInteger(
            claim.settingsSnapshot.maximumChunkCharacters, 1, 64_000
          ),
          maximumChunks: snapshotInteger(
            claim.settingsSnapshot.maximumChunks, 1, 32
          ),
          retryAttempt: claim.attemptCount,
          adapterTimeoutMs: snapshotInteger(
            claim.settingsSnapshot.communityAdapterTimeoutMs, 100, 300_000
          )
        });
      }
    }),
    reconciliation: createSemanticReconciliationStageHandler({ facts, communities }),
    community: createSemanticCommunityStageHandler({
      repository: communities,
      async processPartition(request) {
        const worker = createCommunityPartitionWorker({
          pool: input.graphRagPool,
          isCurrent: () => communities.isCurrent({ claim: request.claim }),
          summarize: ({ knowledgeBaseId, partitionKey, entityPublicIds, signal }) =>
            summarizeCommunity({
              stageClaim: request.stageClaim,
              knowledgeBaseId,
              semanticGenerationPublicId:
                request.stageClaim.semanticGenerationPublicId,
              partitionKey,
              entityPublicIds,
              signal: signal ?? new AbortController().signal
            }),
          replacePartition: ({ work, outputs }) =>
            communities.replacePartition({
              claim: request.claim,
              boundaryVersion: work.boundaryVersion,
              outputs
            }),
          async checkpoint({ outcome, safeCode }) {
            const saved = await communities.saveCheckpoint({
              claim: request.claim,
              entityCursor: null,
              relationshipTruncated: false,
              outcome: outcome === "retry" ? "failed" : outcome,
              safeCode,
              nextAttemptAt: outcome === "retry"
                ? addMilliseconds(now(), input.retryDelayMs)
                : now()
            });
            if (!saved && outcome !== "superseded") {
              throw stageError("semantic_community_checkpoint_conflict", true);
            }
          }
        });
        return worker.process(request.work, request.signal);
      }
    }),
    embedding: createSemanticEmbeddingStageHandler({
      catalog: input.catalog,
      isOwnedRevision: sourceOwnership.isOwnedRevision,
      bodyStore: input.bodyStore,
      sourceInputs,
      async resolveConfiguration(claim) {
        const configuration = await embeddingConfigurations.getRevision(
          claim.embeddingConfigurationRevisionPublicId
        );
        if (!configuration) {
          throw stageError("semantic_embedding_revision_unavailable", false);
        }
        return configuration;
      },
      artifacts: artifactService
    }),
    vector: createSemanticVectorStageHandler({
      artifacts: artifactRepository,
      cleanup: artifactRepository,
      store: artifactStore,
      projections: vectorProjections,
      applyPlan: (plan) => vectorService.apply(plan),
      indexPrefix: input.searchIndexPrefix,
      isOwnedRevision: sourceOwnership.isOwnedRevision,
      artifactReadConcurrency: Math.min(8, input.sourceConcurrency * 2)
    }),
    publication: createSemanticPublicationStageHandler({
      facts,
      publish: ({
        claim,
        closure,
        settingsRevisionPublicId,
        publicationDelayMilliseconds,
        publicationMaximumDelayMilliseconds,
        completedAt
      }) =>
        publication.apply({
          knowledgeBaseId: claim.knowledgeBaseId,
          sourceFilePublicId: claim.sourceFilePublicId,
          operationPublicId: claim.operationPublicId,
          closure,
          settingsRevisionPublicId,
          publicationDelayMilliseconds,
          publicationMaximumDelayMilliseconds,
          completedAt
        })
    }),
    validation: unsupportedStageHandler("validation"),
    cleanup: unsupportedStageHandler("cleanup")
  };
  const budgets = createSemanticStageBudgetManager(stageBudgetLimits(
    input.sourceConcurrency,
    input.pythonConcurrency,
    input.claimBatchSize
  ));
  const worker = createSemanticStageWorker({
    repository: stages,
    budgets,
    handlers,
    retryDelayMs: input.retryDelayMs,
    lease: {
      durationMs: input.leaseDurationMs,
      renewalIntervalMs: Math.max(1_000, Math.floor(input.leaseDurationMs / 3))
    },
    onSettled: stageMetrics.record
  });
  const stageConcurrency = resolveSemanticStageConcurrency(input.claimBatchSize);
  const role = createSemanticStageRoleRuntime({
    owner: input.owner,
    repository: stages,
    worker,
    stageKinds: SOURCE_STAGE_KINDS,
    settings: {
      claimLimit: stageConcurrency,
      maximumParallelStagesPerKnowledgeBase: stageConcurrency,
      pollIntervalMs: input.pollIntervalMs,
      leaseDurationMs: input.leaseDurationMs,
      recoveryBatchSize: Math.min(1_000, input.claimBatchSize * 4)
    },
    onFailure: ({ claim, error }) => input.onFailure?.({
      stagePublicId: claim.publicId,
      error
    })
  });
  return {
    ...role,
    stageDiagnosticFields() {
      return stageMetrics.diagnosticFields();
    },
    embeddingBatchDiagnosticFields() {
      const embedding = artifactService.batchStats();
      return {
        embeddingProviderRequestCount: embedding.providerRequestCount,
        embeddingInputCount: embedding.inputCount,
        embeddingCompletedInputCount: embedding.completedInputCount,
        embeddingFailedInputCount: embedding.failedInputCount,
        embeddingMaximumBatchSize: embedding.maximumBatchSize,
        embeddingBatchCapacity: embedding.batchCapacity,
        embeddingBatchFillRatio: embedding.batchFillRatio,
        embeddingActiveGroups: embedding.activeGroups,
        embeddingPendingInputs: embedding.pendingInputs,
        embeddingActiveFlushes: embedding.activeFlushes
      };
    }
  };

  async function resolveModelAssistance(
    claim: { settingsSnapshot: Readonly<Record<string, string | number | boolean | null>> }
  ): Promise<ModelAssistanceOptions> {
    const snapshot = await input.runtimeSettings.getSnapshot();
    const modelId = String(
      claim.settingsSnapshot.generationModelConfigurationPublicId ?? ""
    );
    const model = await input.generationModels.getModel(modelId);
    if (!model
      || model.id !== modelId
      || model.configurationRevision
        !== claim.settingsSnapshot.generationModelConfigurationRevision
      || model.status !== "active") {
      throw stageError("semantic_generation_model_revision_mismatch", false);
    }
    const assistance = input.modelGateway.resolve({
      ...snapshot,
      activeModel: model
    });
    if (!assistance) {
      throw stageError("semantic_generation_model_unavailable", false);
    }
    return assistance;
  }
}

function unsupportedStageHandler(stageKind: string) {
  return async (): Promise<never> => {
    throw stageError(`semantic_${stageKind}_stage_not_owned_by_source_runtime`, false);
  };
}

function stageBudgetLimits(
  concurrency: number,
  pythonConcurrency: number,
  backlog: number
) {
  const boundedConcurrency = snapshotInteger(concurrency, 1, 32);
  const boundedPythonConcurrency = snapshotInteger(
    pythonConcurrency,
    1,
    boundedConcurrency
  );
  const boundedBacklog = snapshotInteger(backlog, 1, 1_000);
  const limit = (value: number) => ({
    concurrency: Math.max(1, Math.min(boundedConcurrency, value)),
    maximumBacklog: boundedBacklog
  });
  return {
    generation: limit(boundedConcurrency),
    python: limit(boundedPythonConcurrency),
    embedding: limit(boundedConcurrency),
    s3_read: limit(boundedConcurrency * 2),
    s3_write: limit(boundedConcurrency),
    database_mutation: limit(boundedConcurrency * 2),
    search_write: limit(boundedConcurrency),
    publication: limit(1),
    maintenance: limit(1)
  };
}

function snapshotInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw stageError("semantic_settings_snapshot_invalid", false);
  }
  return Number(value);
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) throw stageError("semantic_stage_clock_invalid", false);
  return new Date(value + milliseconds).toISOString();
}

function now(): string {
  return new Date().toISOString();
}

function stageError(code: string, retryable: boolean): Error & {
  code: string;
  retryable: boolean;
} {
  return Object.assign(new Error(`Semantic production stage failed: ${code}`), {
    code,
    retryable
  });
}
