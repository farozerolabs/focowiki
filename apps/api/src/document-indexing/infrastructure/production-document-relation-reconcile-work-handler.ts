import { createHash } from "node:crypto";
import type { createRuntimeSettingsRepository } from "../../runtime-settings/repository.js";
import type { ClaimedDocumentArtifactWork } from "../application/document-work-port.js";
import { buildDocumentIdentityKeys, buildDocumentRelationCandidates } from
  "../application/document-relation-candidates.js";
import {
  documentGraphCandidateTerms,
  type DocumentGraphCandidate
} from "../application/document-model-graph-enrichment.js";
import {
  documentModelRelationCandidates,
  proposeDocumentModelEdges,
  resolveAcceptedDocumentModelEdges
} from "../application/document-model-graph-edge-resolution.js";
import { buildSemanticFileReferenceCandidates } from
  "../application/document-semantic-relation-candidates.js";
import { resolvePinnedDocumentOutputSettings } from
  "../application/document-output-settings.js";
import type { WeightedGenerationTaskRunner } from
  "../application/weighted-generation-task-runner.js";
import type { createDocumentPreparedSourceLoader } from "./document-prepared-source-loader.js";
import type { createDocumentFirstLayerSourceLoader } from "./document-first-layer-source-loader.js";
import type { createDocumentSemanticFactLoader } from "./document-semantic-fact-loader.js";
import type {
  createPostgresDocumentReferenceFactRepository,
  DocumentReferenceSource
} from "./postgres-document-reference-fact-repository.js";
import type { createPostgresDocumentModelEvaluationRepository } from
  "./postgres-document-model-evaluation.js";
import type { createPostgresDocumentModelLayerExecutionRepository } from
  "./postgres-document-model-layer-execution.js";
import type { createPostgresDocumentWorkContext } from "./postgres-document-work-context.js";
import type { createPostgresRelationPairRepository } from "./postgres-relation-pair-repository.js";
import type { createProductionDocumentInternalHybridCandidateSearch } from
  "./production-document-internal-hybrid-candidate-search.js";
import { createProductionDocumentModelEvaluation } from
  "./production-document-model-evaluation.js";
import { recordCandidateDeltaLayer } from "./production-document-model-layer-traces.js";
import { metadataAliases } from "./production-document-metadata.js";
import { documentJobContextFromWork } from "./production-document-first-layer-work-handler.js";
import { isDocumentPathOnlyOperation } from "./production-document-prepared-source-reuse.js";
import { resolvePinnedModelAssistance } from "./production-document-processor-support.js";
import type { ProviderRequestFailureReporter } from
  "../../semantic/provider-request-failure.js";

const MAX_RELATION_PROJECTION_CLOSURE = 10_000;

export function createProductionDocumentRelationReconcileWorkHandler(input: {
  contexts: ReturnType<typeof createPostgresDocumentWorkContext>;
  preparedSources: ReturnType<typeof createDocumentPreparedSourceLoader>;
  firstLayers: ReturnType<typeof createDocumentFirstLayerSourceLoader>;
  semanticFacts: ReturnType<typeof createDocumentSemanticFactLoader>;
  referenceFacts: ReturnType<typeof createPostgresDocumentReferenceFactRepository>;
  internalCandidates: ReturnType<typeof createProductionDocumentInternalHybridCandidateSearch>;
  modelRevisions: ReturnType<typeof createRuntimeSettingsRepository>;
  modelLayerExecutions: ReturnType<typeof createPostgresDocumentModelLayerExecutionRepository>;
  modelEvaluations: ReturnType<typeof createPostgresDocumentModelEvaluationRepository>;
  generation: WeightedGenerationTaskRunner;
  deploymentSecret: string;
  onProviderFailure?: ProviderRequestFailureReporter;
  pairs: ReturnType<typeof createPostgresRelationPairRepository>;
  now?: () => string;
}) {
  const clock = input.now ?? (() => new Date().toISOString());
  const evaluation = createProductionDocumentModelEvaluation({
    repository: input.modelEvaluations,
    generation: input.generation
  });
  return async (request: { claimed: ClaimedDocumentArtifactWork; signal: AbortSignal }) => {
    request.signal.throwIfAborted();
    const [context, prepared, firstLayer, semanticFacts] = await Promise.all([
      input.contexts.read(request.claimed),
      input.preparedSources({ claimed: request.claimed, signal: request.signal }),
      input.firstLayers({ claimed: request.claimed, signal: request.signal }),
      input.semanticFacts({ claimed: request.claimed, signal: request.signal })
    ]);
    const settings = resolvePinnedDocumentOutputSettings(context.runtimeSettings as never);
    const aliases = metadataAliases(prepared.parsedMetadata);
    const identityKeys = buildDocumentIdentityKeys({
      logicalPath: context.source.logicalPath,
      title: prepared.resolvedMetadata.title,
      aliases,
      genericPhraseThreshold: settings.graph.genericPhraseThreshold
    });
    const deterministic = buildDocumentRelationCandidates({
      sourceLogicalPath: context.source.logicalPath,
      references: prepared.referenceProfile.references,
      metadata: prepared.parsedMetadata,
      semanticCandidates: buildSemanticFileReferenceCandidates({
        body: prepared.body,
        facts: semanticFacts,
        maximumCandidates: settings.graph.candidateLimit
      }),
      candidateLimit: settings.graph.candidateLimit,
      genericPhraseThreshold: settings.graph.genericPhraseThreshold
    });
    const targetKeys = [...new Set(deterministic.map((item) => item.normalizedTargetKey))];
    const possibleTargets = targetKeys.length === 0 ? []
      : await input.referenceFacts.findTargetsByIdentityKeys({
          knowledgeBaseId: request.claimed.knowledgeBaseId,
          identityKeys: targetKeys,
          excludeSourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
          limit: settings.graph.candidateLimit
        });
    const targetsByKey = mapTargetsByIdentity(possibleTargets);
    const resolved: ResolvedRelation[] = [];
    let unresolvedCount = 0;
    let ambiguousCount = 0;
    for (const candidate of deterministic) {
      const targets = targetsByKey.get(candidate.normalizedTargetKey) ?? [];
      if (targets.length !== 1) {
        if (targets.length === 0) unresolvedCount += 1;
        else ambiguousCount += 1;
        continue;
      }
      resolved.push({
        target: targets[0]!,
        evidenceKind: candidate.referenceKind === "semantic" ? "graphrag" : "explicit_reference",
        relationKind: candidate.referenceKind === "semantic" ? "related" : "references",
        evidenceFingerprintSha256: candidate.evidenceChecksumSha256,
        evidence: candidate.evidence
      });
    }
    const modelDelta = await evaluateHybridRelationshipDelta({
      dependencies: input,
      request,
      context,
      prepared,
      firstLayer,
      settings,
      evaluation
    });
    for (const candidate of modelDelta.relations) {
      const target = modelDelta.candidates.find((item) =>
        item.sourceFilePublicId === candidate.targetSourceFilePublicId
        && item.sourceRevisionPublicId === candidate.targetSourceRevisionPublicId);
      if (!target) { unresolvedCount += 1; continue; }
      const evidence = {
        target: candidate.target,
        confidence: candidate.confidence,
        sourceExcerpt: candidate.sourceExcerpt,
        startOffset: candidate.startOffset,
        endOffset: candidate.endOffset,
        evidenceTerms: candidate.evidenceTerms,
        relationType: candidate.relationType,
        reason: candidate.reason
      };
      resolved.push({
        target: graphCandidateSource(request.claimed.knowledgeBaseId, target),
        evidenceKind: "first_layer",
        relationKind: candidate.relationType === "references" ? "references" : "related",
        evidenceFingerprintSha256: hash([JSON.stringify(evidence)]),
        evidence
      });
    }
    const incoming = await input.referenceFacts.findReferencingIdentityKeys({
      knowledgeBaseId: request.claimed.knowledgeBaseId,
      identityKeys,
      excludeSourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
      limit: settings.graph.candidateLimit
    });
    for (const source of incoming) {
      resolved.push({
        target: {
          knowledgeBaseId: request.claimed.knowledgeBaseId,
          sourceFilePublicId: request.claimed.sourceFilePublicId,
          sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
          normalizedPath: context.source.normalizedPath,
          title: prepared.resolvedMetadata.title,
          aliases,
          sourceType: prepared.resolvedMetadata.type,
          tags: prepared.resolvedMetadata.tags ?? []
        },
        evidenceKind: "explicit_reference",
        relationKind: "references",
        evidenceFingerprintSha256: hash([
          source.sourceRevisionPublicId,
          request.claimed.sourceRevisionPublicId,
          source.matchedIdentityKey
        ]),
        evidence: {
          ...source.evidence,
          matchedIdentityKey: source.matchedIdentityKey,
          incomingSourceFilePublicId: source.sourceFilePublicId,
          incomingSourceRevisionPublicId: source.sourceRevisionPublicId
        }
      });
    }
    const reusableEvidence = isDocumentPathOnlyOperation(context.job.operationKind)
      && context.source.priorActiveSourceRevisionPublicId
      && context.source.priorActiveSourceRevisionPublicId !== request.claimed.sourceRevisionPublicId
      ? await input.pairs.listReusableEvidence({
          knowledgeBaseId: request.claimed.knowledgeBaseId,
          sourceFilePublicId: request.claimed.sourceFilePublicId,
          priorSourceRevisionPublicId: context.source.priorActiveSourceRevisionPublicId,
          currentSourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
          limit: settings.graph.acceptedEdgeLimit
        }) : [];
    const priorActiveNeighbors = context.source.priorActiveSourceRevisionPublicId
      && context.source.priorActiveSourceRevisionPublicId !== request.claimed.sourceRevisionPublicId
      ? await input.pairs.listActiveNeighborSourceFilePublicIds({
          knowledgeBaseId: request.claimed.knowledgeBaseId,
          sourceFilePublicId: request.claimed.sourceFilePublicId,
          limit: settings.graph.acceptedEdgeLimit
        }) : [];
    const pairs = new Set<string>();
    const relations = new Set<string>();
    const affectedSources = new Set([request.claimed.sourceFilePublicId, ...priorActiveNeighbors]);
    const stageRelation = async (relation: StagedRelation) => {
      if (relation.sourceFilePublicId === relation.targetSourceFilePublicId) return;
      const pairPublicId = await input.pairs.enqueue({
        knowledgeBaseId: request.claimed.knowledgeBaseId,
        sourceFilePublicId: relation.sourceFilePublicId,
        sourceRevisionPublicId: relation.sourceRevisionPublicId,
        targetSourceFilePublicId: relation.targetSourceFilePublicId,
        targetSourceRevisionPublicId: relation.targetSourceRevisionPublicId,
        evidenceFingerprintSha256: relation.evidenceFingerprintSha256,
        nextEligibleAt: clock()
      });
      await input.pairs.addEvidence({
        knowledgeBaseId: request.claimed.knowledgeBaseId,
        pairPublicId,
        ...relation
      });
      const relationPublicId = await input.pairs.stageCanonical({
        pairPublicId,
        relationKind: relation.relationKind,
        now: clock()
      });
      pairs.add(pairPublicId);
      relations.add(relationPublicId);
      affectedSources.add(relation.sourceFilePublicId);
      affectedSources.add(relation.targetSourceFilePublicId);
    };
    for (const relation of reusableEvidence) await stageRelation(relation);
    for (const relation of resolved) {
      if (pairs.size >= settings.graph.acceptedEdgeLimit) break;
      const incomingSourceFilePublicId = typeof relation.evidence.incomingSourceFilePublicId
        === "string" ? relation.evidence.incomingSourceFilePublicId
          : request.claimed.sourceFilePublicId;
      const incomingSourceRevisionPublicId = typeof relation.evidence.incomingSourceRevisionPublicId
        === "string" ? relation.evidence.incomingSourceRevisionPublicId
          : request.claimed.sourceRevisionPublicId;
      await stageRelation({
        sourceFilePublicId: incomingSourceFilePublicId,
        sourceRevisionPublicId: incomingSourceRevisionPublicId,
        targetSourceFilePublicId: incomingSourceFilePublicId === request.claimed.sourceFilePublicId
          ? relation.target.sourceFilePublicId : request.claimed.sourceFilePublicId,
        targetSourceRevisionPublicId: incomingSourceFilePublicId === request.claimed.sourceFilePublicId
          ? relation.target.sourceRevisionPublicId : request.claimed.sourceRevisionPublicId,
        evidenceKind: relation.evidenceKind,
        relationKind: relation.relationKind,
        evidenceFingerprintSha256: relation.evidenceFingerprintSha256,
        evidence: relation.evidence
      });
    }
    const projectionClosure = await input.pairs.listProjectionClosureForRevision({
      knowledgeBaseId: request.claimed.knowledgeBaseId,
      sourceFilePublicId: request.claimed.sourceFilePublicId,
      sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
      limit: MAX_RELATION_PROJECTION_CLOSURE
    });
    for (const entry of projectionClosure) {
      pairs.add(entry.pairPublicId);
      relations.add(entry.relationPublicId);
      affectedSources.add(entry.neighborSourceFilePublicId);
    }
    const outputFingerprintSha256 = hash([
      ...[...pairs].sort(), ...[...affectedSources].sort(),
      String(unresolvedCount), String(ambiguousCount)
    ]);
    return {
      key: "relationships",
      outputFingerprintSha256,
      value: {
        schemaVersion: "document-relation-reconciliation-receipt-v1",
        pairPublicIds: [...pairs].sort(),
        relationPublicIds: [...relations].sort(),
        affectedSourceFilePublicIds: [...affectedSources].sort(),
        dirtyScopeCount: 0,
        unresolvedCount,
        ambiguousCount,
        semanticCandidateCount: modelDelta.candidates.length,
        candidateModelRequestCount: modelDelta.execution.providerRequestCount
      },
      serviceEndedAt: clock()
    };
  };
}

async function evaluateHybridRelationshipDelta(input: {
  dependencies: Parameters<typeof createProductionDocumentRelationReconcileWorkHandler>[0];
  request: { claimed: ClaimedDocumentArtifactWork; signal: AbortSignal };
  context: Awaited<ReturnType<ReturnType<typeof createPostgresDocumentWorkContext>["read"]>>;
  prepared: Awaited<ReturnType<ReturnType<typeof createDocumentPreparedSourceLoader>>>;
  firstLayer: Awaited<ReturnType<ReturnType<typeof createDocumentFirstLayerSourceLoader>>>;
  settings: ReturnType<typeof resolvePinnedDocumentOutputSettings>;
  evaluation: ReturnType<typeof createProductionDocumentModelEvaluation>;
}) {
  const { request, context, prepared, firstLayer } = input;
  const job = documentJobContextFromWork(request.claimed, context.job);
  const modelConfigurationPublicId = context.job.generationModelConfigurationPublicId;
  const modelConfigurationRevision = context.job.generationModelConfigurationRevision;
  const semanticGenerationPublicId = context.job.semanticGenerationPublicId;
  const embeddingConfigurationRevisionPublicId =
    context.job.embeddingConfigurationRevisionPublicId;
  if (!semanticGenerationPublicId || !embeddingConfigurationRevisionPublicId) {
    throw new Error("Semantic projection configuration is unavailable");
  }
  const candidates = isDocumentPathOnlyOperation(context.job.operationKind) ? []
    : await input.dependencies.internalCandidates.find({
        knowledgeBaseId: request.claimed.knowledgeBaseId,
        sourceFilePublicId: request.claimed.sourceFilePublicId,
        sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
        semanticGenerationPublicId,
        embeddingConfigurationRevisionPublicId,
        terms: documentGraphCandidateTerms(prepared.resolvedMetadata.title, firstLayer.contentProfile),
        limit: input.settings.graph.candidateLimit,
        signal: request.signal
      });
  if (candidates.length === 0) {
    return {
      relations: [],
      candidates,
      execution: noCandidateDelta().execution
    };
  }
  if (!modelConfigurationPublicId || modelConfigurationRevision === null) {
    throw new Error("Generation model configuration is unavailable");
  }
  const assistance = await resolvePinnedModelAssistance({
    repository: input.dependencies.modelRevisions,
    deploymentSecret: input.dependencies.deploymentSecret,
    job,
    ...(input.dependencies.onProviderFailure
      ? { onProviderFailure: input.dependencies.onProviderFailure }
      : {})
  });
  const source = {
    fileId: request.claimed.sourceFilePublicId,
    path: `pages/${context.source.logicalPath}`,
    title: prepared.resolvedMetadata.title,
    type: prepared.resolvedMetadata.type,
    profile: firstLayer.contentProfile
  };
  const edges = proposeDocumentModelEdges({
    request: {
      knowledgeBaseId: request.claimed.knowledgeBaseId,
      sourceFilePublicId: request.claimed.sourceFilePublicId,
      sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
      logicalPath: context.source.logicalPath,
      title: prepared.resolvedMetadata.title,
      type: prepared.resolvedMetadata.type,
      tags: prepared.resolvedMetadata.tags ?? [],
      body: prepared.body,
      metadata: prepared.parsedMetadata,
      contentProfile: firstLayer.contentProfile,
      modelName: assistance.modelName,
      candidateLimit: input.settings.graph.candidateLimit,
      acceptedEdgeLimit: input.settings.graph.acceptedEdgeLimit,
      genericPhraseThreshold: input.settings.graph.genericPhraseThreshold,
      signal: request.signal
    },
    contentProfile: firstLayer.contentProfile,
    suggestions: firstLayer.suggestions,
    candidates
  });
  const delta = edges.length === 0 ? noCandidateDelta()
    : await input.evaluation.confirmDelta({
        knowledgeBaseId: request.claimed.knowledgeBaseId,
        sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
        modelConfigurationPublicId,
        modelConfigurationRevision,
        assistance,
        source,
        body: prepared.body,
        candidates,
        edges,
        signal: request.signal
      });
  await recordCandidateDeltaLayer({
    repository: input.dependencies.modelLayerExecutions,
    job,
    modelName: assistance.modelName,
    execution: delta.execution,
    warningCount: delta.warnings.length
  });
  return {
    relations: documentModelRelationCandidates(resolveAcceptedDocumentModelEdges({
      proposed: edges,
      confirmations: delta.confirmations
    }), candidates),
    candidates,
    execution: delta.execution
  };
}

function noCandidateDelta() {
  return {
    confirmations: [], warnings: [],
    execution: {
      ownerIdentity: "no-candidates",
      reusedDecisionCount: 0,
      evaluatedDecisionCount: 0,
      providerRequestCount: 0,
      waitTimeMs: 0,
      serviceTimeMs: 0,
      providerObservations: []
    }
  };
}

type ResolvedRelation = {
  target: DocumentReferenceSource;
  evidenceKind: "explicit_reference" | "first_layer" | "graphrag";
  relationKind: "references" | "related";
  evidenceFingerprintSha256: string;
  evidence: Readonly<Record<string, unknown>>;
};

type StagedRelation = {
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  targetSourceFilePublicId: string;
  targetSourceRevisionPublicId: string;
  evidenceKind: "explicit_reference" | "title_alias" | "first_layer" | "graphrag";
  relationKind: "references" | "related";
  evidenceFingerprintSha256: string;
  evidence: Readonly<Record<string, unknown>>;
};

function graphCandidateSource(
  knowledgeBaseId: string,
  candidate: DocumentGraphCandidate
): DocumentReferenceSource {
  return {
    knowledgeBaseId,
    sourceFilePublicId: candidate.sourceFilePublicId,
    sourceRevisionPublicId: candidate.sourceRevisionPublicId,
    normalizedPath: candidate.logicalPath,
    title: candidate.title,
    aliases: [],
    sourceType: candidate.kind,
    tags: []
  };
}

function mapTargetsByIdentity(sources: readonly DocumentReferenceSource[]) {
  const result = new Map<string, DocumentReferenceSource[]>();
  for (const source of sources) {
    for (const key of buildDocumentIdentityKeys({
      logicalPath: source.normalizedPath,
      title: source.title,
      aliases: source.aliases
    })) {
      const values = result.get(key) ?? [];
      values.push(source);
      result.set(key, values);
    }
  }
  return result;
}

function hash(values: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
