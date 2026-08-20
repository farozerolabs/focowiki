import { createHash } from "node:crypto";
import {
  GRAPH_RELATIONSHIP_PROMPT_CONTRACT_VERSION,
  MODEL_GRAPH_ANALYSIS_PROMPT_CONTRACT_VERSION,
  requestGraphRelationshipConfirmations,
  requestModelGraphAnalysis,
  validateModelSuggestions,
  type GraphRelationshipConfirmation,
  type ModelProviderObservation
} from "@focowiki/okf";
import type { ModelAssistanceOptions } from
  "../../runtime-settings/model-assistance-options.js";
import {
  createDocumentModelAnalysisFingerprint,
  createDocumentRelationshipEvaluationFingerprint,
  type DocumentModelEvaluationRepository,
  type DocumentRelationshipEvaluationFact
} from "../application/document-model-evaluation.js";
import type {
  DocumentGraphCandidate,
  DocumentProposedGraphEdge
} from "../application/document-model-graph-enrichment.js";
import type { createDocumentResourcePermits } from
  "../application/document-resource-permits.js";
import type { WeightedGenerationTaskRunner } from
  "../application/weighted-generation-task-runner.js";
import type { DocumentRedisAcceleration } from
  "./redis-document-acceleration.js";
import {
  documentModelContractDigest,
  modelEvaluationError,
  validateModelEvaluationWarnings
} from "./document-model-evaluation-validation.js";
import { runDocumentGeneration } from
  "./production-document-generation-runner.js";
import {
  confirmationFromDocumentFact as confirmationFromFact,
  documentCandidateFiles as candidateFiles,
  documentCandidateTokenMap as candidateTokenMap,
  documentEdgeInputs as edgeInputs,
  documentModelInput as modelInput,
  documentModelSource as modelSource,
  rejectedDocumentConfirmation as rejectedConfirmation,
  resolveDocumentCandidateConfirmations as resolveCandidateConfirmations,
  relationshipDeltaEvidenceBody,
  type DocumentModelEvaluationSource as ModelSource
} from "./production-document-model-evaluation-inputs.js";
import { findOrCopyDocumentModelAnalysis } from
  "./production-document-model-reuse.js";
import { createModelObservationCollector } from "../../semantic/provider-request-failure.js";
type EvaluationRequest = {
  knowledgeBaseId: string;
  sourceRevisionPublicId: string;
  modelConfigurationPublicId: string;
  modelConfigurationRevision: number;
  assistance: ModelAssistanceOptions;
  source: ModelSource;
  body: string;
  candidates: readonly DocumentGraphCandidate[];
  edges: readonly DocumentProposedGraphEdge[];
  signal: AbortSignal;
};
const RELATIONSHIP_MODEL_BATCH_SIZE = 64;

export function createProductionDocumentModelEvaluation(input: {
  repository: DocumentModelEvaluationRepository;
  permits?: ReturnType<typeof createDocumentResourcePermits>;
  generation?: WeightedGenerationTaskRunner;
  acceleration?: DocumentRedisAcceleration;
}) {
  return {
    async analyze(request: EvaluationRequest) {
      const promptContractSha256 = documentModelContractDigest(
        MODEL_GRAPH_ANALYSIS_PROMPT_CONTRACT_VERSION
      );
      const fingerprint = createDocumentModelAnalysisFingerprint({
        sourceRevisionPublicId: request.sourceRevisionPublicId,
        modelConfigurationPublicId: request.modelConfigurationPublicId,
        modelConfigurationRevision: request.modelConfigurationRevision,
        promptContractSha256,
        modelInput: modelInput(request)
      });
      const readIntrinsic = async () => {
        const stored = await findOrCopyDocumentModelAnalysis({
          repository: input.repository,
          fingerprint,
          knowledgeBaseId: request.knowledgeBaseId,
          sourceRevisionPublicId: request.sourceRevisionPublicId,
          modelConfigurationPublicId: request.modelConfigurationPublicId,
          modelConfigurationRevision: request.modelConfigurationRevision,
          promptContractSha256
        });
        if (!stored) return null;
        await input.acceleration?.markEvaluationDurable({
          fingerprint: fingerprint.publicId,
          ttlSeconds: 3_600
        });
        const suggestions = validateModelSuggestions(stored.result.suggestions);
        return {
          suggestions,
          warnings: validateModelEvaluationWarnings(stored.warnings),
          providerRequestCount: 0,
          waitTimeMs: 0,
          serviceTimeMs: 0,
          providerObservations: [] as ModelProviderObservation[],
          reused: true
        };
      };
      const evaluate = async () => {
        const raced = await readIntrinsic();
        if (raced) return raced;
        let providerRequestCount = 0;
        let waitTimeMs = 0;
        let serviceTimeMs = 0;
        const providerObservations: ModelProviderObservation[] = [];
        const result = await runDocumentGeneration(input, "first_layer", () =>
          requestModelGraphAnalysis({
            client: request.assistance.client,
            modelName: request.assistance.modelName,
            contextWindowTokens: request.assistance.contextWindowTokens,
            receiveTimeouts: request.assistance.receiveTimeouts,
            transientRetryDelayMs: request.assistance.transientRetryDelayMs,
            currentFile: modelSource(request.source),
            body: request.body,
            candidates: [],
            candidateFiles: [],
            onProviderRequest: () => {
              providerRequestCount += 1;
            },
            onProviderObservation: createModelObservationCollector(providerObservations,
              request.assistance.onProviderFailure,
              request.assistance.modelName
            )
          }), {
            signal: request.signal,
            ownerKey: `${request.modelConfigurationPublicId}:${request.modelConfigurationRevision}`,
            onMetric(metric) {
              waitTimeMs += metric.waitTimeMs;
              serviceTimeMs += metric.serviceTimeMs;
            }
          });
        if (result.suggestions === null) {
          return {
            suggestions: null,
            warnings: validateModelEvaluationWarnings(result.warnings),
            providerRequestCount,
            waitTimeMs,
            serviceTimeMs,
            providerObservations,
            reused: false
          };
        }
        await input.repository.storeAnalysis({
          ...fingerprint,
          knowledgeBaseId: request.knowledgeBaseId,
          sourceRevisionPublicId: request.sourceRevisionPublicId,
          modelConfigurationPublicId: request.modelConfigurationPublicId,
          modelConfigurationRevision: request.modelConfigurationRevision,
          promptContractSha256,
          result: {
            suggestions: result.suggestions
          },
          warnings: validateModelEvaluationWarnings(result.warnings)
        });
        const durable = await readIntrinsic();
        if (!durable) throw modelEvaluationError("MODEL_ANALYSIS_WRITE_MISSING");
        return {
          ...durable,
          providerRequestCount,
          waitTimeMs,
          serviceTimeMs,
          providerObservations,
          reused: false
        };
      };
      const intrinsic = input.acceleration
        ? input.acceleration.runEvaluationSingleflight({
            fingerprint: fingerprint.publicId,
            lockTtlSeconds: 30,
            signal: request.signal,
            readDurable: readIntrinsic,
            evaluate
          })
        : evaluate();
      const resolvedIntrinsic = await intrinsic;
      if (resolvedIntrinsic.suggestions === null) {
        throw Object.assign(modelEvaluationError("MODEL_GRAPH_ANALYSIS_INVALID"), {
          execution: {
            ownerIdentity: fingerprint.publicId,
            reused: false,
            providerRequestCount: resolvedIntrinsic.providerRequestCount,
            waitTimeMs: resolvedIntrinsic.waitTimeMs,
            serviceTimeMs: resolvedIntrinsic.serviceTimeMs,
            providerObservations: resolvedIntrinsic.providerObservations
          }
        });
      }
      const delta = await this.confirmDelta(request);
      return {
        suggestions: resolvedIntrinsic.suggestions,
        confirmations: delta.confirmations,
        warnings: [...resolvedIntrinsic.warnings, ...delta.warnings],
        execution: {
          firstLayer: {
            ownerIdentity: fingerprint.publicId,
              reused: resolvedIntrinsic.reused,
            providerRequestCount: resolvedIntrinsic.providerRequestCount,
            waitTimeMs: resolvedIntrinsic.waitTimeMs,
            serviceTimeMs: resolvedIntrinsic.serviceTimeMs,
            providerObservations: resolvedIntrinsic.providerObservations
          },
          candidateDelta: delta.execution
        }
      };
    },

    async confirmDelta(request: EvaluationRequest) {
      if (request.edges.length === 0) {
        return {
          confirmations: [],
          warnings: [],
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
      const promptContractSha256 = documentModelContractDigest(
        GRAPH_RELATIONSHIP_PROMPT_CONTRACT_VERSION
      );
      const keyed = relationshipKeys(request, promptContractSha256);
      const ownerIdentity = createHash("sha256")
        .update(keyed.map((item) => item.fingerprint.publicId).sort().join("\u001f"))
        .digest("hex");
      const exact = await input.repository.findRelationships({
        knowledgeBaseId: request.knowledgeBaseId,
        publicIds: keyed.map((item) => item.fingerprint.publicId)
      });
      const exactIds = new Set(exact.map((item) => item.publicId));
      const unresolved = keyed.filter((item) =>
        !exactIds.has(item.fingerprint.publicId));
      const reusable = unresolved.length === 0 ? []
        : await input.repository.findReusableRelationships({
            knowledgeBaseId: request.knowledgeBaseId,
            targetRevisionPublicIds: unresolved.map(
              (item) => item.candidate.sourceRevisionPublicId),
            evidenceFingerprintSha256s: unresolved.map(
              (item) => item.fingerprint.evidenceFingerprintSha256),
            modelConfigurationPublicId: request.modelConfigurationPublicId,
            modelConfigurationRevision: request.modelConfigurationRevision,
            promptContractSha256
          });
      const reusableByInput = new Map(reusable.map((item) => [
        relationshipReuseKey(
          item.targetRevisionPublicId,
          item.evidenceFingerprintSha256
        ),
        item
      ]));
      const copied = await input.repository.storeRelationships({
        evaluations: unresolved.flatMap((item) => {
          const prior = reusableByInput.get(relationshipReuseKey(
            item.candidate.sourceRevisionPublicId,
            item.fingerprint.evidenceFingerprintSha256
          ));
          return prior ? [{
            ...item.fingerprint,
            knowledgeBaseId: request.knowledgeBaseId,
            sourceRevisionPublicId: request.sourceRevisionPublicId,
            targetRevisionPublicId: item.candidate.sourceRevisionPublicId,
            modelConfigurationPublicId: request.modelConfigurationPublicId,
            modelConfigurationRevision: request.modelConfigurationRevision,
            promptContractSha256,
            decision: prior.decision,
            confidence: prior.confidence,
            result: prior.result
          }] : [];
        })
      });
      const existing = [...exact, ...copied];
      const existingIds = new Set(existing.map((item) => item.publicId));
      const missing = keyed.filter((item) =>
        !existingIds.has(item.fingerprint.publicId));
      let warnings: string[] = [];
      let storedMissing: readonly DocumentRelationshipEvaluationFact[] = [];
      let providerRequestCount = 0;
      let waitTimeMs = 0;
      let serviceTimeMs = 0;
      const providerObservations: ModelProviderObservation[] = [];
      if (missing.length > 0) {
        const tokens = candidateTokenMap(request.candidates);
        const publicIds = missing.map((item) => item.fingerprint.publicId);
        const readDurable = async () => {
          const facts = await input.repository.findRelationships({
            knowledgeBaseId: request.knowledgeBaseId,
            publicIds
          });
          return facts.length === publicIds.length
            ? { facts, warnings: [] as string[] } : null;
        };
        const evaluate = async () => {
          const raced = await readDurable();
          if (raced) return raced;
          const durableFacts: DocumentRelationshipEvaluationFact[] = [];
          const evaluatedWarnings: string[] = [];
          for (let offset = 0; offset < missing.length;
            offset += RELATIONSHIP_MODEL_BATCH_SIZE) {
            const batch = missing.slice(offset, offset + RELATIONSHIP_MODEL_BATCH_SIZE);
            const batchTargetIds = new Set(
              batch.map((item) => item.edge.toFileId)
            );
            const result = await runDocumentGeneration(
              input,
              "candidate_delta",
              () => requestGraphRelationshipConfirmations({
                client: request.assistance.client,
                modelName: request.assistance.modelName,
                contextWindowTokens: request.assistance.contextWindowTokens,
                receiveTimeouts: request.assistance.receiveTimeouts,
                transientRetryDelayMs: request.assistance.transientRetryDelayMs,
                currentFile: modelSource(request.source),
                body: relationshipDeltaEvidenceBody(
                  batch.map((item) => item.edge),
                  request.source.profile.summary
                ),
                candidates: edgeInputs(batch.map((item) => item.edge), tokens),
                candidateFiles: candidateFiles(request.candidates.filter((candidate) =>
                  batchTargetIds.has(candidate.sourceFilePublicId)), tokens),
                onProviderRequest: () => {
                  providerRequestCount += 1;
                },
                onProviderObservation: createModelObservationCollector(providerObservations,
                  request.assistance.onProviderFailure,
                  request.assistance.modelName
                )
              }), {
                signal: request.signal,
                ownerKey: `${request.modelConfigurationPublicId}:${request.modelConfigurationRevision}`,
                onMetric(metric) {
                  waitTimeMs += metric.waitTimeMs;
                  serviceTimeMs += metric.serviceTimeMs;
                }
              }
            );
            const batchWarnings = validateModelEvaluationWarnings(result.warnings);
            evaluatedWarnings.push(...batchWarnings);
            if (batchWarnings.length > 0 && result.confirmations.length === 0) {
              continue;
            }
            await persistRelationshipEvaluations({
              repository: input.repository,
              request: { ...request, edges: batch.map((item) => item.edge) },
              promptContractSha256,
              confirmations: resolveCandidateConfirmations(
                result.confirmations, tokens)
            });
            const batchFacts = await input.repository.findRelationships({
              knowledgeBaseId: request.knowledgeBaseId,
              publicIds: batch.map((item) => item.fingerprint.publicId)
            });
            durableFacts.push(...batchFacts);
            for (const fact of batchFacts) {
              await input.acceleration?.markEvaluationDurable({
                fingerprint: fact.publicId,
                ttlSeconds: 3_600
              });
            }
          }
          return { facts: durableFacts, warnings: evaluatedWarnings };
        };
        const evaluated = input.acceleration
          ? await input.acceleration.runEvaluationSingleflight({
              fingerprint: createHash("sha256")
                .update([...publicIds].sort().join("\u001f"))
                .digest("hex"),
              lockTtlSeconds: 30,
              signal: request.signal,
              readDurable,
              evaluate
            })
          : await evaluate();
        warnings = evaluated.warnings;
        storedMissing = evaluated.facts;
        if (warnings.length > 0 && storedMissing.length === 0) {
          return {
            confirmations: [],
            warnings,
            execution: {
              ownerIdentity,
              reusedDecisionCount: existing.length,
              evaluatedDecisionCount: 0,
              providerRequestCount,
              waitTimeMs,
              serviceTimeMs,
              providerObservations
            }
          };
        }
      }
      const byId = new Map([...existing, ...storedMissing].map((item) => [
        item.publicId,
        item
      ]));
      return {
        confirmations: keyed.flatMap((item) => {
          const fact = byId.get(item.fingerprint.publicId);
          return fact ? [confirmationFromFact(fact)] : [];
        }),
        warnings,
        execution: {
          ownerIdentity,
          reusedDecisionCount: existing.length,
          evaluatedDecisionCount: storedMissing.length,
          providerRequestCount,
          waitTimeMs,
          serviceTimeMs,
          providerObservations
        }
      };
    }
  };
}

async function persistRelationshipEvaluations(input: {
  repository: DocumentModelEvaluationRepository;
  request: EvaluationRequest;
  promptContractSha256: string;
  confirmations: readonly GraphRelationshipConfirmation[];
}): Promise<GraphRelationshipConfirmation[]> {
  const keyed = relationshipKeys(input.request, input.promptContractSha256);
  if (keyed.length === 0) return [];
  const confirmationByTarget = new Map(input.confirmations.map((item) => [
    item.targetFileId,
    item
  ]));
  const stored = await input.repository.storeRelationships({
    evaluations: keyed.map(({ edge, candidate, fingerprint }) => {
      const confirmation = confirmationByTarget.get(edge.toFileId);
      const normalized = confirmation ?? rejectedConfirmation(edge);
      return {
        ...fingerprint,
        knowledgeBaseId: input.request.knowledgeBaseId,
        sourceRevisionPublicId: input.request.sourceRevisionPublicId,
        targetRevisionPublicId: candidate.sourceRevisionPublicId,
        modelConfigurationPublicId: input.request.modelConfigurationPublicId,
        modelConfigurationRevision: input.request.modelConfigurationRevision,
        promptContractSha256: input.promptContractSha256,
        decision: normalized.accepted ? "accepted" as const : "rejected" as const,
        confidence: normalized.accepted ? normalized.weight : 0,
        result: { ...normalized }
      };
    })
  });
  return stored.map(confirmationFromFact);
}

function relationshipKeys(
  request: EvaluationRequest,
  promptContractSha256: string
) {
  const candidateById = new Map(request.candidates.map((candidate) => [
    candidate.sourceFilePublicId,
    candidate
  ]));
  return request.edges.flatMap((edge) => {
    const candidate = candidateById.get(edge.toFileId);
    if (!candidate) return [];
    return [{
      edge,
      candidate,
      fingerprint: createDocumentRelationshipEvaluationFingerprint({
        sourceRevisionPublicId: request.sourceRevisionPublicId,
        targetRevisionPublicId: candidate.sourceRevisionPublicId,
        evidence: {
          relationType: edge.relationType,
          weight: edge.weight,
          reason: edge.reason,
          evidence: edge.evidence
        },
        modelConfigurationPublicId: request.modelConfigurationPublicId,
        modelConfigurationRevision: request.modelConfigurationRevision,
        promptContractSha256
      })
    }];
  });
}

function relationshipReuseKey(
  targetRevisionPublicId: string,
  evidenceFingerprintSha256: string
): string {
  return `${targetRevisionPublicId}\u001f${evidenceFingerprintSha256}`;
}
