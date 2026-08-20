import { createHash } from "node:crypto";
import type { StorageVnextImmutableBodyStore } from
  "../../storage-vnext/ownership/s3-immutable-body-store.js";
import type { StorageVnextImmutableObjectWriter } from
  "../../storage-vnext/ownership/immutable-object-writer.js";
import type { StorageVnextOwnershipRepository } from
  "../../storage-vnext/ownership/ports.js";
import type { createRuntimeSettingsRepository } from
  "../../runtime-settings/repository.js";
import { createGraphRagExtractionGateway } from
  "../../semantic/graphrag/extraction-gateway.js";
import { createGraphRagGenerationModelCompletion } from
  "../../semantic/graphrag/generation-model-completion.js";
import type { createGraphRagRuntime } from
  "../../semantic/graphrag/graph-rag-runtime.js";
import { buildSemanticDesiredFactSet } from
  "../../semantic/domain/graph-normalization.js";
import { remapSemanticSkeletonSelection } from
  "../../semantic/graphrag/skeleton-selector.js";
import type { createPostgresSemanticFactRepository } from
  "../../semantic/infrastructure/postgres-fact-repository.js";
import type { WeightedGenerationTaskRunner } from
  "../application/weighted-generation-task-runner.js";
import { resolvePinnedDocumentOutputSettings } from
  "../application/document-output-settings.js";
import type { ClaimedDocumentArtifactWork } from
  "../application/document-work-port.js";
import { createDurableGraphRagChunkOutputPort } from
  "./durable-graphrag-chunk-output-port.js";
import type { createDocumentPreparedSourceLoader } from
  "./document-prepared-source-loader.js";
import type { createDocumentFirstLayerSourceLoader } from
  "./document-first-layer-source-loader.js";
import type { createPostgresDocumentGraphRagChunkRepository } from
  "./postgres-document-graphrag-chunk-repository.js";
import type { createPostgresDocumentModelLayerExecutionRepository } from
  "./postgres-document-model-layer-execution.js";
import type { createPostgresDocumentSemanticFactReuse } from
  "./postgres-document-semantic-fact-reuse.js";
import type { createPostgresDocumentWorkContext } from
  "./postgres-document-work-context.js";
import { isDocumentPathOnlyOperation } from
  "./production-document-prepared-source-reuse.js";
import type { ProviderRequestFailureReporter } from
  "../../semantic/provider-request-failure.js";
import {
  modelLayerErrorCode,
  recordGraphRagLayer
} from "./production-document-model-layer-traces.js";
import {
  documentJobContextFromWork
} from "./production-document-first-layer-work-handler.js";
import {
  processorError,
  resolvePinnedModelAssistance
} from "./production-document-processor-support.js";
import { immutableArtifactWriteAttempt, ownerIdentity } from
  "./production-document-identities.js";

export function createProductionDocumentGraphRagWorkHandler(input: {
  contexts: ReturnType<typeof createPostgresDocumentWorkContext>;
  preparedSources: ReturnType<typeof createDocumentPreparedSourceLoader>;
  firstLayers: ReturnType<typeof createDocumentFirstLayerSourceLoader>;
  modelRevisions: ReturnType<typeof createRuntimeSettingsRepository>;
  modelLayerExecutions: ReturnType<
    typeof createPostgresDocumentModelLayerExecutionRepository
  >;
  semanticFacts: ReturnType<typeof createPostgresSemanticFactRepository>;
  semanticFactReuse: ReturnType<typeof createPostgresDocumentSemanticFactReuse>;
  graphRag: ReturnType<typeof createGraphRagRuntime>;
  generation: WeightedGenerationTaskRunner;
  chunks: ReturnType<typeof createPostgresDocumentGraphRagChunkRepository>;
  objectWriter: StorageVnextImmutableObjectWriter;
  bodies: StorageVnextImmutableBodyStore;
  ownership: StorageVnextOwnershipRepository;
  deploymentSecret: string;
  onProviderFailure?: ProviderRequestFailureReporter;
  chunkLeaseDurationMs: number;
  now?: () => string;
}) {
  const clock = input.now ?? (() => new Date().toISOString());
  return async (request: {
    claimed: ClaimedDocumentArtifactWork;
    signal: AbortSignal;
    releasePrimaryLane(): void;
  }) => {
    const [context, prepared, firstLayer] = await Promise.all([
      input.contexts.read(request.claimed),
      input.preparedSources({ claimed: request.claimed, signal: request.signal }),
      input.firstLayers({ claimed: request.claimed, signal: request.signal })
    ]);
    const job = documentJobContextFromWork(request.claimed, context.job);
    const semanticGenerationPublicId = context.job.semanticGenerationPublicId;
    if (!semanticGenerationPublicId) {
      throw processorError("semantic_generation_configuration_missing");
    }
    const modelConfigurationPublicId = context.job
      .generationModelConfigurationPublicId;
    const modelConfigurationRevision = context.job
      .generationModelConfigurationRevision;
    if (!modelConfigurationPublicId || modelConfigurationRevision === null) {
      throw processorError("generation_model_configuration_missing");
    }
    const assistance = await resolvePinnedModelAssistance({
      repository: input.modelRevisions,
      deploymentSecret: input.deploymentSecret,
      job,
      ...(input.onProviderFailure
        ? { onProviderFailure: input.onProviderFailure }
        : {})
    });
    const plannedSelection = firstLayer.plan.graphragSelection;
    const startedAt = clock();
    let requestCount = 0;
    let waitTimeMs = 0;
    let serviceTimeMs = 0;
    let laneReleased = false;
    const releaseLane = () => {
      if (laneReleased) return;
      laneReleased = true;
      request.releasePrimaryLane();
    };
    try {
      const outputSettings = resolvePinnedDocumentOutputSettings(
        context.runtimeSettings as never
      );
      const reused = isDocumentPathOnlyOperation(context.job.operationKind)
        ? await input.semanticFactReuse({
            knowledgeBaseId: request.claimed.knowledgeBaseId,
            semanticGenerationPublicId,
            sourceFilePublicId: request.claimed.sourceFilePublicId,
            toSourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
            targetLogicalPath: context.source.logicalPath,
            semanticContractVersion: context.job.semanticContractVersion
          })
        : null;
      const reusable = reused?.manifest.selectionDecisionSha256
        === plannedSelection.decisionSha256 ? reused : null;
      if (reusable) releaseLane();
      const result = reusable
        ? {
            desiredFacts: reusable.facts,
            canonicalInputHash: reusable.manifest.canonicalInputSha256,
            generationRequestCount: 0,
            selection: plannedSelection
          }
        : plannedSelection.selected
        ? await createGraphRagExtractionGateway({
            pool: input.graphRag.pool,
            model: createGraphRagGenerationModelCompletion(
              assistance,
              () => { requestCount += 1; }
            ),
            chunkOutputs: createDurableGraphRagChunkOutputPort({
              claimed: request.claimed,
              modelConfigurationIdentity:
                `${modelConfigurationPublicId}:${modelConfigurationRevision}`,
              chunks: input.chunks,
              objectWriter: input.objectWriter,
              bodies: input.bodies,
              ownership: input.ownership,
              leaseDurationMs: input.chunkLeaseDurationMs,
              now: clock
            }),
            requestRunner: {
              run: (operation) => input.generation.run("graphrag", operation, {
                signal: request.signal,
                ownerKey: `${modelConfigurationPublicId}:${modelConfigurationRevision}`,
                onMetric(metric) {
                  waitTimeMs += metric.waitTimeMs;
                  serviceTimeMs += metric.serviceTimeMs;
                }
              })
            },
            completionConcurrency: Math.min(assistance.suggestionConcurrency, 2),
            maximumChunkCharacters:
              outputSettings.semantic.maximumChunkCharacters,
            maximumChunks: outputSettings.semantic.maximumChunks,
            retryAttempt: request.claimed.attemptCount,
            adapterTimeoutMs: outputSettings.semantic.graphRagAdapterTimeoutMs,
            selectSkeleton: ({ chunks }) => remapSemanticSkeletonSelection({
              selection: plannedSelection,
              originalChunks: firstLayer.plan.contentVectorInputs.map((chunk) => ({
                id: chunk.publicId,
                startOffset: chunk.startOffset,
                endOffset: chunk.endOffset
              })),
              retryChunks: chunks
            }),
            onPromptsPrepared: releaseLane
          }).extract({
            knowledgeBaseId: request.claimed.knowledgeBaseId,
            semanticGenerationPublicId,
            sourceFilePublicId: request.claimed.sourceFilePublicId,
            sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
            logicalPath: context.source.logicalPath,
            markdown: prepared.body,
            signal: request.signal
          })
        : {
            desiredFacts: buildSemanticDesiredFactSet({
              knowledgeBaseId: request.claimed.knowledgeBaseId,
              semanticGenerationPublicId,
              sourceFilePublicId: request.claimed.sourceFilePublicId,
              sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
              logicalPath: context.source.logicalPath,
              chunks: [],
              extraction: { entities: [], mentions: [], relationships: [] }
            }),
            canonicalInputHash: createHash("sha256")
              .update(JSON.stringify(firstLayer.plan.contentVectorInputs))
              .digest("hex"),
            generationRequestCount: 0,
            selection: plannedSelection
          };
      const selection = result.selection;
      releaseLane();
      await input.semanticFacts.replaceSourceFacts(result.desiredFacts, {
        extractionContractVersion: context.job.semanticContractVersion,
        canonicalInputSha256: result.canonicalInputHash,
        skeletonPolicyVersion: selection.policyVersion,
        skeletonSelected: selection.selected,
        sourceChunkCount: selection.sourceChunkCount,
        selectedChunkCount: selection.selectedChunkIds.length,
        selectionReasons: selection.reasons,
        selectionDecisionSha256: selection.decisionSha256
      });
      const factSnapshotBytes = new TextEncoder().encode(canonicalJson({
        schemaVersion: "document-semantic-facts-v1",
        desiredFacts: result.desiredFacts
      }));
      const factSnapshotChecksumSha256 = createHash("sha256")
        .update(factSnapshotBytes).digest("hex");
      const factSnapshot = await input.objectWriter.putVerified({
        bytes: factSnapshotBytes,
        objectFormat: "okf-generated-json-v1",
        writeAttemptPublicId: immutableArtifactWriteAttempt(
          request.claimed.documentJobPublicId,
          "semantic_facts",
          factSnapshotChecksumSha256
        ),
        createdAt: clock(),
        signal: request.signal
      });
      await input.ownership.attach({
        publicId: ownerIdentity(
          request.claimed.sourceRevisionPublicId,
          `semantic_facts:${factSnapshot.objectId}`
        ),
        knowledgeBaseId: request.claimed.knowledgeBaseId,
        objectId: factSnapshot.objectId,
        kind: "source_revision",
        ownerPublicId: request.claimed.sourceRevisionPublicId,
        createdAt: clock()
      });
      await recordGraphRagLayer({
        repository: input.modelLayerExecutions,
        job,
        modelName: assistance.modelName,
        selected: selection.selected,
        decisionSha256: selection.decisionSha256,
        providerRequestCount: requestCount,
        waitTimeMs,
        serviceTimeMs,
        warningCount: 0,
        reused: reusable !== null,
        startedAt,
        errorCode: null
      });
      const outputFingerprintSha256 = createHash("sha256")
        .update(JSON.stringify([
          selection.decisionSha256,
          result.canonicalInputHash,
          result.desiredFacts.entities.map((fact) => fact.publicId),
          result.desiredFacts.relationships.map((fact) => fact.publicId)
        ]))
        .digest("hex");
      return {
        key: "semantic",
        outputFingerprintSha256,
        value: {
          schemaVersion: "document-graphrag-receipt-v1",
          selected: selection.selected,
          selectionDecisionSha256: selection.decisionSha256,
          canonicalInputSha256: result.canonicalInputHash,
          providerRequestCount: requestCount,
          entityCount: result.desiredFacts.entities.length,
          relationshipCount: result.desiredFacts.relationships.length,
          evidenceCount: result.desiredFacts.evidence.length,
          factSnapshot: {
            objectId: factSnapshot.objectId,
            storageKey: factSnapshot.storageKey,
            checksumSha256: factSnapshot.checksum,
            byteCount: factSnapshot.byteCount,
            contentType: factSnapshot.contentType,
            objectFormat: factSnapshot.objectFormat
          }
        },
        serviceEndedAt: clock()
      };
    } catch (error) {
      releaseLane();
      await recordGraphRagLayer({
        repository: input.modelLayerExecutions,
        job,
        modelName: assistance.modelName,
        selected: plannedSelection.selected,
        decisionSha256: plannedSelection.decisionSha256,
        providerRequestCount: requestCount,
        waitTimeMs,
        serviceTimeMs,
        warningCount: 0,
        reused: false,
        startedAt,
        errorCode: modelLayerErrorCode(error)
      });
      throw error;
    }
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}
