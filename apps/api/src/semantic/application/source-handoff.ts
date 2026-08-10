import type { RuntimeSettingsSnapshot } from "../../runtime-settings/types.js";
import type { RuntimeSettingsRepository } from
  "../../runtime-settings/repository.js";
import type { StorageVnextSemanticSourceHandoffPort } from
  "../../storage-vnext/source-processing/ports.js";
import type { SemanticGenerationRepositoryPort } from "./ports.js";
import type { SemanticStageRepositoryPort } from "./stage-ports.js";
import { planSemanticSourceStages } from "./stage-orchestration.js";
import type { EmbeddingConfigurationRepository } from
  "../embedding/repository.js";
import {
  SEMANTIC_EXTRACTION_CONTRACT_VERSION,
  SEMANTIC_GRAPH_SCHEMA_VERSION,
  SEMANTIC_PROMPT_CONTRACT_VERSION
} from "../domain/contracts.js";

export type SemanticSourceStageTarget = {
  semanticGenerationPublicId: string;
  extractionContractVersion: string;
  embeddingConfigurationRevisionPublicId: string;
  settingsSnapshot: ReturnType<typeof semanticSettingsSnapshot>;
  maximumAttempts: number;
};

export type SemanticSourceStageTargetResolution =
  | { state: "disabled"; target: null; safeCode: string }
  | { state: "blocked"; target: null; safeCode: string }
  | { state: "ready"; target: SemanticSourceStageTarget; safeCode: null };

type SemanticTargetDependencies = {
  generations: Pick<SemanticGenerationRepositoryPort, "getActiveProjection">;
  generationModels: Pick<RuntimeSettingsRepository, "getModel">;
  embeddingConfigurations: Pick<EmbeddingConfigurationRepository, "getRevision">;
  resolveRuntimeSettings(): Promise<RuntimeSettingsSnapshot>;
  searchProviderKind: "meilisearch" | "opensearch";
  maximumAttempts: number;
  maximumSourceBytes?: number;
};

export function createSemanticSourceHandoff(input: SemanticTargetDependencies & {
  stages: Pick<SemanticStageRepositoryPort, "enqueue" | "requestCancellation">;
}): StorageVnextSemanticSourceHandoffPort {
  const targets = createSemanticSourceStageTargetResolver(input);
  return {
    async enqueue(request) {
      const resolved = await targets.resolve({
        knowledgeBaseId: request.knowledgeBaseId,
        runtimeSettingsRevisionPublicId: request.settingsRevisionPublicId
      });
      if (resolved.state === "disabled") {
        return disabled(null, resolved.safeCode);
      }
      if (resolved.state === "blocked") {
        const active = await input.generations.getActiveProjection(
          request.knowledgeBaseId
        );
        return blocked(
          active?.publicId ?? "semantic-unavailable",
          resolved.safeCode
        );
      }
      const target = resolved.target;
      const settingsSnapshot = request.skeletonGraphSignals
        ? {
            ...target.settingsSnapshot,
            skeletonAcceptedEdgeCount:
              request.skeletonGraphSignals.acceptedEdgeCount,
            skeletonInboundEdgeCount:
              request.skeletonGraphSignals.inboundEdgeCount,
            skeletonOutboundEdgeCount:
              request.skeletonGraphSignals.outboundEdgeCount,
            skeletonDistinctNeighborCount:
              request.skeletonGraphSignals.distinctNeighborCount,
            skeletonRelationKindCount:
              request.skeletonGraphSignals.relationKindCount,
            skeletonContentProfileHeadingCount:
              request.skeletonGraphSignals.contentProfileHeadingCount ?? 0,
            skeletonContentProfileDefinitionCount:
              request.skeletonGraphSignals.contentProfileDefinitionCount ?? 0,
            skeletonContentProfileExplicitReferenceCount:
              request.skeletonGraphSignals.contentProfileExplicitReferenceCount ?? 0
          }
        : target.settingsSnapshot;
      const plan = planSemanticSourceStages({
        knowledgeBaseId: request.knowledgeBaseId,
        operationPublicId: request.operationPublicId,
        semanticGenerationPublicId: target.semanticGenerationPublicId,
        sourceFilePublicId: request.sourceFile.publicId,
        sourceRevisionPublicId: request.sourceRevision.publicId,
        extractionContractVersion: target.extractionContractVersion,
        embeddingConfigurationRevisionPublicId:
          target.embeddingConfigurationRevisionPublicId,
        settingsSnapshot,
        dirtyCommunityPartitionKeys: [],
        includeValidation: true,
        ...(request.resumeFromStage
          ? { resumeFromStage: request.resumeFromStage }
          : {}),
        maximumAttempts: target.maximumAttempts
      });
      await input.stages.requestCancellation({
        knowledgeBaseId: request.knowledgeBaseId,
        semanticGenerationPublicId: target.semanticGenerationPublicId,
        sourceFilePublicIds: [request.sourceFile.publicId],
        exceptOperationPublicId: request.operationPublicId,
        requestedAt: request.enqueuedAt
      });
      const stageCount = await input.stages.enqueue({
        items: plan,
        enqueuedAt: request.enqueuedAt
      });
      if (stageCount !== plan.length) {
        throw new Error("Semantic source handoff did not persist every stage");
      }
      return {
        state: "queued",
        semanticGenerationPublicId: target.semanticGenerationPublicId,
        stageCount,
        safeCode: null
      };
    }
  };
}

export function createSemanticSourceStageTargetResolver(
  input: SemanticTargetDependencies
) {
  if (!Number.isSafeInteger(input.maximumAttempts)
    || input.maximumAttempts < 1 || input.maximumAttempts > 100) {
    throw new Error("Semantic source handoff attempts are invalid");
  }
  return {
    async resolve(request: {
      knowledgeBaseId: string;
      runtimeSettingsRevisionPublicId: string;
    }): Promise<SemanticSourceStageTargetResolution> {
      const active = await input.generations.getActiveProjection(
        request.knowledgeBaseId
      );
      if (!active) {
        return {
          state: "disabled",
          target: null,
          safeCode: "semantic_contract_not_adopted"
        };
      }
      if (active.extractionContractVersion !== SEMANTIC_EXTRACTION_CONTRACT_VERSION
        || active.graphSchemaVersion !== SEMANTIC_GRAPH_SCHEMA_VERSION
        || active.promptContractVersion !== SEMANTIC_PROMPT_CONTRACT_VERSION) {
        return {
          state: "blocked",
          target: null,
          safeCode: "semantic_contract_adoption_required"
        };
      }
      const snapshot = await input.resolveRuntimeSettings();
      const model = await input.generationModels.getModel(
        active.generationModelConfigurationPublicId
      );
      if (!model
        || model.id !== active.generationModelConfigurationPublicId
        || model.configurationRevision
          !== active.generationModelConfigurationRevision
        || model.status !== "active") {
        return {
          state: "blocked",
          target: null,
          safeCode: "semantic_generation_model_revision_mismatch"
        };
      }
      const embedding = await input.embeddingConfigurations.getRevision(
        active.embeddingConfigurationRevisionPublicId
      );
      if (!embedding
        || embedding.validationStatus !== "valid"
        || embedding.resolvedDimension !== active.resolvedDimension
        || embedding.normalization !== active.normalization) {
        return {
          state: "blocked",
          target: null,
          safeCode: "semantic_embedding_revision_unavailable"
        };
      }
      if (active.searchProviderKind !== input.searchProviderKind) {
        return {
          state: "blocked",
          target: null,
          safeCode: "semantic_search_provider_adoption_required"
        };
      }
      return {
        state: "ready",
        safeCode: null,
        target: {
          semanticGenerationPublicId: active.publicId,
          extractionContractVersion: active.extractionContractVersion,
          embeddingConfigurationRevisionPublicId:
            active.embeddingConfigurationRevisionPublicId,
          settingsSnapshot: semanticSettingsSnapshot({
            active,
            embedding,
            model,
            snapshot,
            runtimeSettingsRevisionPublicId:
              request.runtimeSettingsRevisionPublicId,
            maximumSourceBytes: input.maximumSourceBytes ?? 16_777_216
          }),
          maximumAttempts: input.maximumAttempts
        }
      };
    }
  };
}

function semanticSettingsSnapshot(input: {
  active: NonNullable<Awaited<ReturnType<
    SemanticGenerationRepositoryPort["getActiveProjection"]
  >>>;
  embedding: NonNullable<Awaited<ReturnType<
    EmbeddingConfigurationRepository["getRevision"]
  >>>;
  model: NonNullable<RuntimeSettingsSnapshot["activeModel"]>;
  snapshot: RuntimeSettingsSnapshot;
  runtimeSettingsRevisionPublicId: string;
  maximumSourceBytes: number;
}) {
  const publicationDelayMilliseconds =
    input.snapshot.publication.mode === "per_file"
      ? 0
      : input.snapshot.publication.intervalSeconds * 1_000;
  return {
    runtimeSettingsRevisionPublicId: input.runtimeSettingsRevisionPublicId,
    generationModelConfigurationPublicId:
      input.active.generationModelConfigurationPublicId,
    generationModelConfigurationRevision:
      input.active.generationModelConfigurationRevision,
    embeddingConfigurationRevisionPublicId:
      input.active.embeddingConfigurationRevisionPublicId,
    projectionContractPublicId: input.active.projectionContractPublicId,
    semanticGenerationRole: "active",
    searchProviderKind: input.active.searchProviderKind,
    resolvedDimension: input.active.resolvedDimension,
    normalization: input.active.normalization,
    graphSchemaVersion: input.active.graphSchemaVersion,
    promptContractVersion: input.active.promptContractVersion,
    mappingFingerprintSha256: input.active.mappingFingerprintSha256,
    maximumChunkCharacters: input.snapshot.semantic.maximumChunkCharacters,
    maximumChunks: input.snapshot.semantic.maximumChunks,
    maximumEmbeddingCharacters: Math.min(
      64_000,
      input.embedding.maximumInputTokens * 4
    ),
    maximumEvidenceTargets: input.snapshot.semantic.maximumEvidenceTargets,
    maximumCommunityPartitions:
      input.snapshot.semantic.maximumCommunityPartitions,
    maximumCommunityEntities: input.snapshot.semantic.maximumCommunityEntities,
    maximumCommunityRelationships:
      input.snapshot.semantic.maximumCommunityRelationships,
    maximumCommunityBoundaryRelationships:
      input.snapshot.semantic.maximumCommunityBoundaryRelationships,
    maximumCommunitySummaryCharacters:
      input.snapshot.semantic.maximumCommunitySummaryCharacters,
    communityAdapterTimeoutMs: Math.min(
      input.snapshot.semantic.communityAdapterTimeoutMs,
      input.model.requestMaxTimeoutMs ?? 30_000
    ),
    publicationDelayMilliseconds:
      publicationDelayMilliseconds,
    publicationMaximumDelayMilliseconds: publicationDelayMilliseconds === 0
      ? 0
      : Math.min(86_400_000, publicationDelayMilliseconds * 12),
    maximumSourceBytes: input.maximumSourceBytes,
    vectorBatchDocumentCount: input.snapshot.search.indexBatchDocumentCount
  } as const;
}

function disabled(
  semanticGenerationPublicId: string | null,
  safeCode: string
) {
  return {
    state: "disabled" as const,
    semanticGenerationPublicId,
    stageCount: 0,
    safeCode
  };
}

function blocked(semanticGenerationPublicId: string, safeCode: string) {
  return {
    state: "blocked" as const,
    semanticGenerationPublicId,
    stageCount: 0,
    safeCode
  };
}
