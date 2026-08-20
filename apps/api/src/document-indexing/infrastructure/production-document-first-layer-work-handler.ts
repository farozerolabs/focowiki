import { createHash } from "node:crypto";
import type { StorageVnextImmutableObjectWriter } from
  "../../storage-vnext/ownership/immutable-object-writer.js";
import type { StorageVnextOwnershipRepository } from
  "../../storage-vnext/ownership/ports.js";
import type { LexicalTokenizer } from
  "../../application/ports/lexical-tokenizer.js";
import type { createRuntimeSettingsRepository } from
  "../../runtime-settings/repository.js";
import type { WeightedGenerationTaskRunner } from
  "../application/weighted-generation-task-runner.js";
import { createDocumentModelGraphEnrichment } from
  "../application/document-model-graph-enrichment.js";
import { createDocumentSemanticPlan } from
  "../application/document-semantic-plan.js";
import { resolvePinnedDocumentOutputSettings } from
  "../application/document-output-settings.js";
import type { ClaimedDocumentArtifactWork } from
  "../application/document-work-port.js";
import type { createPostgresDocumentModelEvaluationRepository } from
  "./postgres-document-model-evaluation.js";
import type { createPostgresDocumentModelLayerExecutionRepository } from
  "./postgres-document-model-layer-execution.js";
import type { createPostgresDocumentModelTraceRepository } from
  "./postgres-document-model-trace.js";
import type { createPostgresDocumentWorkContext } from
  "./postgres-document-work-context.js";
import type { createDocumentPreparedSourceLoader } from
  "./document-prepared-source-loader.js";
import { createProductionDocumentModelEvaluation } from
  "./production-document-model-evaluation.js";
import {
  failedFirstLayerExecution,
  modelLayerErrorCode,
  recordEvaluationLayers,
  recordFirstLayerFailure
} from "./production-document-model-layer-traces.js";
import {
  immutableArtifactWriteAttempt,
  ownerIdentity,
  processorError
} from "./production-document-identities.js";
import { resolvePinnedModelAssistance } from
  "./production-document-processor-support.js";
import type { DocumentJobContext } from
  "../application/document-job-context.js";
import type { SemanticDocument } from "./production-document-types.js";
import { isDocumentPathOnlyOperation } from
  "./production-document-prepared-source-reuse.js";
import type { ProviderRequestFailureReporter } from
  "../../semantic/provider-request-failure.js";

export type DocumentFirstLayerSnapshot = {
  schemaVersion: "document-first-layer-source-v1";
  suggestions: SemanticDocument["suggestions"];
  contentProfile: SemanticDocument["contentProfile"];
  modelExecution: SemanticDocument["modelExecution"];
  warnings: SemanticDocument["warnings"];
  plan: ReturnType<ReturnType<typeof createDocumentSemanticPlan>>;
};

export function relationshipDeltaEdgesForOperation<T>(
  operationKind: string,
  edges: readonly T[]
): readonly T[] {
  return isDocumentPathOnlyOperation(operationKind) ? [] : edges;
}

export function createProductionDocumentFirstLayerWorkHandler(input: {
  contexts: ReturnType<typeof createPostgresDocumentWorkContext>;
  preparedSources: ReturnType<typeof createDocumentPreparedSourceLoader>;
  modelRevisions: ReturnType<typeof createRuntimeSettingsRepository>;
  modelTraces: ReturnType<typeof createPostgresDocumentModelTraceRepository>;
  modelLayerExecutions: ReturnType<
    typeof createPostgresDocumentModelLayerExecutionRepository
  >;
  modelEvaluations: ReturnType<
    typeof createPostgresDocumentModelEvaluationRepository
  >;
  tokenizer: LexicalTokenizer;
  generation: WeightedGenerationTaskRunner;
  objectWriter: StorageVnextImmutableObjectWriter;
  ownership: StorageVnextOwnershipRepository;
  deploymentSecret: string;
  onProviderFailure?: ProviderRequestFailureReporter;
  now?: () => string;
}) {
  const clock = input.now ?? (() => new Date().toISOString());
  const evaluation = createProductionDocumentModelEvaluation({
    repository: input.modelEvaluations,
    generation: input.generation
  });
  return async (request: {
    claimed: ClaimedDocumentArtifactWork;
    signal: AbortSignal;
    releasePrimaryLane(): void;
  }) => {
    const [context, prepared] = await Promise.all([
      input.contexts.read(request.claimed),
      input.preparedSources({ claimed: request.claimed, signal: request.signal })
    ]);
    const job = documentJobContextFromWork(request.claimed, context.job);
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
    const outputSettings = resolvePinnedDocumentOutputSettings(
      context.runtimeSettings as never
    );
    const semanticPlan = createDocumentSemanticPlan({
      maximumChunkCharacters: outputSettings.semantic.maximumChunkCharacters,
      maximumChunks: outputSettings.semantic.maximumChunks
    });
    const startedAt = clock();
    await input.modelTraces.record({
      documentJobPublicId: job.publicId,
      trace: {
        status: "running",
        modelName: assistance.modelName,
        startedAt,
        endedAt: null,
        warningCount: 0,
        errorCode: null
      }
    });
    let enriched: Awaited<ReturnType<ReturnType<
      typeof createDocumentModelGraphEnrichment
    >>>;
    try {
      enriched = await createDocumentModelGraphEnrichment({
        tokenizer: input.tokenizer,
        candidates: { async find() { return []; } },
        model: {
          analyze: (modelRequest) => evaluation.analyze({
            knowledgeBaseId: request.claimed.knowledgeBaseId,
            sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
            modelConfigurationPublicId,
            modelConfigurationRevision,
            assistance,
            source: modelRequest.source,
            body: modelRequest.body,
            candidates: modelRequest.candidates,
            edges: relationshipDeltaEdgesForOperation(
              context.job.operationKind,
              modelRequest.edges
            ),
            signal: modelRequest.signal
          })
        }
      })({
        knowledgeBaseId: request.claimed.knowledgeBaseId,
        sourceFilePublicId: request.claimed.sourceFilePublicId,
        sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
        logicalPath: context.source.logicalPath,
        title: prepared.resolvedMetadata.title,
        type: prepared.resolvedMetadata.type,
        tags: prepared.resolvedMetadata.tags ?? [],
        body: prepared.body,
        metadata: prepared.parsedMetadata,
        contentProfile: prepared.contentProfile,
        modelName: assistance.modelName,
        candidateLimit: outputSettings.graph.candidateLimit,
        acceptedEdgeLimit: outputSettings.graph.acceptedEdgeLimit,
        genericPhraseThreshold: outputSettings.graph.genericPhraseThreshold,
        signal: request.signal
      });
      await recordEvaluationLayers({
        repository: input.modelLayerExecutions,
        job,
        modelName: assistance.modelName,
        execution: enriched.modelExecution,
        warningCount: enriched.warnings.length,
        recordCandidateDelta: false
      });
    } catch (error) {
      const execution = failedFirstLayerExecution(error);
      if (execution) {
        await recordFirstLayerFailure({
          repository: input.modelLayerExecutions,
          job,
          modelName: assistance.modelName,
          execution,
          errorCode: modelLayerErrorCode(error)
        });
      }
      await input.modelTraces.record({
        documentJobPublicId: job.publicId,
        trace: {
          status: "failed",
          modelName: assistance.modelName,
          startedAt,
          endedAt: clock(),
          warningCount: 0,
          errorCode: modelLayerErrorCode(error)
        }
      });
      throw error;
    }
    const plan = semanticPlan({
      sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
      logicalPath: context.source.logicalPath,
      title: prepared.resolvedMetadata.title,
      markdown: prepared.body,
      metadata: prepared.parsedMetadata,
      contentProfile: enriched.contentProfile,
      graphSignals: {
        acceptedEdgeCount: enriched.relationCandidates.length,
        inboundEdgeCount: 0,
        outboundEdgeCount: enriched.relationCandidates.length,
        distinctNeighborCount: new Set(enriched.relationCandidates.map(
          (candidate) => candidate.targetSourceFilePublicId
        )).size,
        relationKindCount: new Set(enriched.relationCandidates.map(
          (candidate) => candidate.relationType
        )).size
      }
    });
    const snapshotValue: DocumentFirstLayerSnapshot = {
      schemaVersion: "document-first-layer-source-v1",
      suggestions: enriched.suggestions,
      contentProfile: enriched.contentProfile,
      modelExecution: enriched.modelExecution,
      warnings: enriched.warnings,
      plan
    };
    const snapshotBytes = new TextEncoder().encode(JSON.stringify(snapshotValue));
    const snapshotChecksumSha256 = createHash("sha256")
      .update(snapshotBytes).digest("hex");
    const snapshot = await input.objectWriter.putVerified({
      bytes: snapshotBytes,
      objectFormat: "okf-generated-json-v1",
      writeAttemptPublicId: immutableArtifactWriteAttempt(
        request.claimed.documentJobPublicId,
        "first_layer",
        snapshotChecksumSha256
      ),
      createdAt: clock(),
      signal: request.signal
    });
    await input.ownership.attach({
      publicId: ownerIdentity(
        request.claimed.sourceRevisionPublicId,
        `first_layer:${snapshot.objectId}`
      ),
      knowledgeBaseId: request.claimed.knowledgeBaseId,
      objectId: snapshot.objectId,
      kind: "source_revision",
      ownerPublicId: request.claimed.sourceRevisionPublicId,
      createdAt: clock()
    });
    const outputFingerprintSha256 = createHash("sha256").update(JSON.stringify([
      snapshot.checksum,
      enriched.modelExecution.firstLayer.ownerIdentity,
      plan.graphragSelection.decisionSha256
    ])).digest("hex");
    await input.modelTraces.record({
      documentJobPublicId: job.publicId,
      trace: {
        status: "completed",
        modelName: assistance.modelName,
        startedAt,
        endedAt: clock(),
        warningCount: enriched.warnings.length,
        errorCode: null
      }
    });
    return {
      key: "mandatory",
      outputFingerprintSha256,
      value: {
        schemaVersion: "document-first-layer-receipt-v1",
        modelConfigurationPublicId,
        modelConfigurationRevision,
        modelName: assistance.modelName,
        graphRagSelected: plan.graphragSelection.selected,
        graphRagDecisionSha256: plan.graphragSelection.decisionSha256,
        warningCount: enriched.warnings.length,
        snapshot: {
          objectId: snapshot.objectId,
          storageKey: snapshot.storageKey,
          checksumSha256: snapshot.checksum,
          byteCount: snapshot.byteCount,
          contentType: snapshot.contentType,
          objectFormat: snapshot.objectFormat
        }
      },
      serviceEndedAt: clock()
    };
  };
}

export function documentJobContextFromWork(
  work: ClaimedDocumentArtifactWork,
  context: Awaited<ReturnType<ReturnType<
    typeof createPostgresDocumentWorkContext
  >["read"]>>["job"]
): DocumentJobContext {
  return {
    publicId: work.documentJobPublicId,
    knowledgeBaseId: work.knowledgeBaseId,
    operationPublicId: context.operationPublicId,
    operationKind: context.operationKind,
    sourceFilePublicId: work.sourceFilePublicId,
    sourceRevisionPublicId: work.sourceRevisionPublicId,
    runtimeSettingsRevisionPublicId: context.runtimeSettingsRevisionPublicId,
    generationModelConfigurationPublicId:
      context.generationModelConfigurationPublicId,
    generationModelConfigurationRevision:
      context.generationModelConfigurationRevision,
    embeddingConfigurationRevisionPublicId:
      context.embeddingConfigurationRevisionPublicId,
    semanticGenerationPublicId: context.semanticGenerationPublicId,
    semanticContractVersion: context.semanticContractVersion,
    readinessSequence: context.readinessSequence,
    attemptCount: work.attemptCount,
    maximumAttempts: work.maximumAttempts,
    acceptedAt: context.acceptedAt
  };
}
