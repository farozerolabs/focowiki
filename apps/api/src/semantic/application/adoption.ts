import { createHash } from "node:crypto";
import type { StorageVnextCatalogReadPort } from
  "../../storage-vnext/catalog/ports.js";
import { isStorageVnextStablePublicationSource } from
  "../../storage-vnext/publication/source-eligibility.js";
import type { SemanticMaintenanceTarget } from "../domain/contracts.js";
import { planSemanticSourceStages, type SemanticStageSettingsSnapshot } from
  "./stage-orchestration.js";
import type {
  SemanticGenerationRecord,
  SemanticGenerationRepositoryPort
} from "./ports.js";
import type { SemanticStageRepositoryPort } from "./stage-ports.js";

type GenerationPort = Pick<
  SemanticGenerationRepositoryPort,
  | "createCandidate"
  | "getCandidateByOperation"
  | "transitionCandidate"
  | "activateCandidate"
  | "adoptQueryPolicy"
  | "cloneReusableFacts"
>;

type StagePort = Pick<
  SemanticStageRepositoryPort,
  "enqueue" | "summarizeOperation" | "requestCancellation"
>;

export function createSemanticAdoptionService(input: {
  generations: GenerationPort;
  stages: StagePort;
  catalog: Pick<StorageVnextCatalogReadPort, "listCurrentSources">;
}) {
  return {
    async planSourcePage(request: {
      knowledgeBaseId: string;
      operationPublicId: string;
      expectedPredecessorPublicId: string | null;
      target: SemanticMaintenanceTarget;
      settingsSnapshot: SemanticStageSettingsSnapshot;
      cursor: string | null;
      pageSize: number;
      maximumAttempts: number;
      reusePredecessorFacts: boolean;
      enqueuedAt: string;
    }) {
      assertPlanRequest(request);
      const fingerprint = semanticContractFingerprint(request.target);
      const candidate = await ensureCandidate({
        generations: input.generations,
        knowledgeBaseId: request.knowledgeBaseId,
        operationPublicId: request.operationPublicId,
        expectedPredecessorPublicId: request.expectedPredecessorPublicId,
        target: request.target,
        contractFingerprintSha256: fingerprint
      });
      if (candidate.contractFingerprintSha256 !== fingerprint) {
        throw adoptionError("semantic_adoption_contract_conflict");
      }
      if (request.reusePredecessorFacts && request.cursor === null) {
        if (!request.expectedPredecessorPublicId) {
          throw adoptionError("semantic_adoption_predecessor_missing");
        }
        await input.generations.cloneReusableFacts({
          knowledgeBaseId: request.knowledgeBaseId,
          predecessorPublicId: request.expectedPredecessorPublicId,
          candidatePublicId: candidate.publicId
        });
      }
      const page = await input.catalog.listCurrentSources({
        knowledgeBaseId: request.knowledgeBaseId,
        limit: request.pageSize,
        cursor: request.cursor
      });
      const sources = page.items.filter(({ sourceFile }) =>
        isStorageVnextStablePublicationSource(sourceFile));
      const plans = sources.flatMap(({ sourceFile, sourceRevision }) =>
        planSemanticSourceStages({
          knowledgeBaseId: request.knowledgeBaseId,
          operationPublicId: request.operationPublicId,
          semanticGenerationPublicId: candidate.publicId,
          sourceFilePublicId: sourceFile.publicId,
          sourceRevisionPublicId: sourceRevision.publicId,
          extractionContractVersion: request.target.extractionContractVersion,
          embeddingConfigurationRevisionPublicId:
            request.target.embeddingConfigurationRevisionPublicId,
          settingsSnapshot: {
            ...request.settingsSnapshot,
            projectionContractPublicId: `semantic-contract-${candidate.publicId}`
          },
          dirtyCommunityPartitionKeys: [],
          includeValidation: false,
          includePublication: false,
          ...(request.reusePredecessorFacts
            ? { resumeFromStage: "embedding" as const }
            : {}),
          maximumAttempts: request.maximumAttempts
        }));
      const stageCount = await enqueueBounded(input.stages, plans, request.enqueuedAt);
      return {
        candidate,
        sourceCount: sources.length,
        stageCount,
        nextCursor: page.nextCursor
      };
    },

    async validateCandidate(request: {
      knowledgeBaseId: string;
      operationPublicId: string;
    }) {
      const candidate = await requireCandidate(input.generations, request);
      const summary = await input.stages.summarizeOperation({
        ...request,
        semanticGenerationPublicId: candidate.publicId
      });
      if (summary.failedCount > 0) {
        await failCandidate(input.generations, candidate);
        throw adoptionError("semantic_adoption_stage_failed");
      }
      if (summary.cancelledCount > 0 || summary.supersededCount > 0) {
        throw adoptionError("semantic_adoption_cancelled");
      }
      if (summary.pendingCount > 0) {
        return { outcome: "pending" as const, candidate, summary };
      }
      if (candidate.state === "ready") {
        return { outcome: "ready" as const, candidate, summary };
      }
      if (candidate.state !== "building" && candidate.state !== "validating") {
        throw adoptionError("semantic_adoption_candidate_terminal");
      }
      let validating = candidate;
      if (candidate.state === "building") {
        validating = await input.generations.transitionCandidate({
          knowledgeBaseId: request.knowledgeBaseId,
          candidatePublicId: candidate.publicId,
          expectedRevision: candidate.revision,
          fromState: "building",
          toState: "validating"
        });
      }
      const ready = await input.generations.transitionCandidate({
        knowledgeBaseId: request.knowledgeBaseId,
        candidatePublicId: validating.publicId,
        expectedRevision: validating.revision,
        fromState: "validating",
        toState: "ready"
      });
      return { outcome: "ready" as const, candidate: ready, summary };
    },

    async activateCandidate(request: {
      knowledgeBaseId: string;
      operationPublicId: string;
      activatedAt: string;
    }) {
      const candidate = await requireCandidate(input.generations, request);
      if (candidate.state !== "ready") {
        throw adoptionError("semantic_adoption_candidate_not_ready");
      }
      return input.generations.activateCandidate({
        knowledgeBaseId: request.knowledgeBaseId,
        candidatePublicId: candidate.publicId,
        expectedPredecessorPublicId: candidate.expectedPredecessorPublicId,
        expectedCandidateRevision: candidate.revision,
        activatedAt: request.activatedAt
      });
    },

    async adoptQueryPolicy(request: {
      knowledgeBaseId: string;
      semanticGenerationPublicId: string;
      expectedGenerationRevision: number;
      target: SemanticMaintenanceTarget;
    }) {
      const adopted = await input.generations.adoptQueryPolicy({
        knowledgeBaseId: request.knowledgeBaseId,
        semanticGenerationPublicId: request.semanticGenerationPublicId,
        expectedGenerationRevision: request.expectedGenerationRevision,
        embeddingQueryPolicyRevisionPublicId:
          request.target.embeddingQueryPolicyRevisionPublicId,
        minimumVectorRelevance: request.target.minimumVectorRelevance,
        contractFingerprintSha256: semanticContractFingerprint(request.target)
      });
      if (!adopted) throw adoptionError("semantic_query_policy_adoption_stale");
      return { adopted: true as const, reusedVectorArtifacts: true as const };
    },

    async cancel(request: {
      knowledgeBaseId: string;
      operationPublicId: string;
      requestedAt: string;
    }) {
      const candidate = await requireCandidate(input.generations, request);
      await input.stages.requestCancellation({
        knowledgeBaseId: request.knowledgeBaseId,
        semanticGenerationPublicId: candidate.publicId,
        sourceFilePublicIds: null,
        requestedAt: request.requestedAt
      });
      if (
        candidate.state !== "building"
        && candidate.state !== "validating"
        && candidate.state !== "ready"
      ) {
        return candidate;
      }
      return input.generations.transitionCandidate({
        knowledgeBaseId: request.knowledgeBaseId,
        candidatePublicId: candidate.publicId,
        expectedRevision: candidate.revision,
        fromState: candidate.state,
        toState: "cancelled"
      });
    }
  };
}

export function semanticContractFingerprint(
  target: SemanticMaintenanceTarget
): string {
  return createHash("sha256").update(JSON.stringify([
    target.knowledgeBaseId,
    target.generationModelConfigurationPublicId,
    target.generationModelConfigurationRevision,
    target.extractionContractVersion,
    target.graphSchemaVersion,
    target.promptContractVersion,
    target.embeddingConfigurationRevisionPublicId,
    target.embeddingQueryPolicyRevisionPublicId,
    target.minimumVectorRelevance,
    target.resolvedDimension,
    target.normalization,
    target.artifactSchemaVersion,
    target.vectorSchemaVersion,
    target.searchProviderKind,
    target.mappingFingerprintSha256
  ])).digest("hex");
}

async function ensureCandidate(input: {
  generations: GenerationPort;
  knowledgeBaseId: string;
  operationPublicId: string;
  expectedPredecessorPublicId: string | null;
  target: SemanticMaintenanceTarget;
  contractFingerprintSha256: string;
}): Promise<SemanticGenerationRecord> {
  const existing = await input.generations.getCandidateByOperation(input);
  if (existing) return existing;
  return input.generations.createCandidate({
    operationPublicId: input.operationPublicId,
    candidatePublicId: candidatePublicId(input),
    expectedPredecessorPublicId: input.expectedPredecessorPublicId,
    target: input.target,
    contractFingerprintSha256: input.contractFingerprintSha256
  });
}

async function requireCandidate(
  generations: GenerationPort,
  input: { knowledgeBaseId: string; operationPublicId: string }
): Promise<SemanticGenerationRecord> {
  const candidate = await generations.getCandidateByOperation(input);
  if (!candidate) throw adoptionError("semantic_adoption_candidate_missing");
  return candidate;
}

async function failCandidate(
  generations: GenerationPort,
  candidate: SemanticGenerationRecord
): Promise<void> {
  if (candidate.state !== "building" && candidate.state !== "validating") return;
  await generations.transitionCandidate({
    knowledgeBaseId: candidate.knowledgeBaseId,
    candidatePublicId: candidate.publicId,
    expectedRevision: candidate.revision,
    fromState: candidate.state,
    toState: "failed"
  });
}

async function enqueueBounded(
  stages: Pick<SemanticStageRepositoryPort, "enqueue">,
  plans: ReturnType<typeof planSemanticSourceStages>,
  enqueuedAt: string
): Promise<number> {
  let total = 0;
  for (let offset = 0; offset < plans.length; offset += 1_000) {
    const items = plans.slice(offset, offset + 1_000);
    total += await stages.enqueue({ items, enqueuedAt });
  }
  if (total !== plans.length) throw adoptionError("semantic_adoption_enqueue_incomplete");
  return total;
}

function candidatePublicId(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
}): string {
  const digest = createHash("sha256")
    .update(`${input.knowledgeBaseId}\u001f${input.operationPublicId}`)
    .digest("hex");
  return `semantic-generation-${digest}`;
}

function assertPlanRequest(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  target: SemanticMaintenanceTarget;
  pageSize: number;
  maximumAttempts: number;
  reusePredecessorFacts: boolean;
  enqueuedAt: string;
}): void {
  if (
    !input.knowledgeBaseId
    || !input.operationPublicId
    || input.target.knowledgeBaseId !== input.knowledgeBaseId
    || !Number.isSafeInteger(input.pageSize)
    || input.pageSize < 1
    || input.pageSize > 100
    || !Number.isSafeInteger(input.maximumAttempts)
    || input.maximumAttempts < 1
    || input.maximumAttempts > 100
    || typeof input.reusePredecessorFacts !== "boolean"
    || !Number.isFinite(Date.parse(input.enqueuedAt))
  ) throw adoptionError("semantic_adoption_invalid_request");
}

function adoptionError(code: string): Error & { code: string; retryable: boolean } {
  return Object.assign(
    new Error(`Semantic adoption failed: ${code}`),
    { code, retryable: false }
  );
}
