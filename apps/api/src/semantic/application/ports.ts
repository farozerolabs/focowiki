import type {
  SemanticDesiredFactSet,
  SemanticEntity,
  SemanticAffectedClosure,
  SemanticMaintenanceTarget,
  SemanticPublicId,
  SemanticSourceExtractionManifest
} from "../domain/contracts.js";

export type SemanticGenerationRecord = {
  publicId: SemanticPublicId;
  knowledgeBaseId: string;
  operationPublicId: SemanticPublicId;
  expectedPredecessorPublicId: SemanticPublicId | null;
  role: "candidate" | "active" | "historical";
  state: "building" | "validating" | "ready" | "active" | "failed" | "cancelled" | "superseded" | "cleanup_failed";
  contractFingerprintSha256: string;
  revision: number;
};

export type SemanticActiveProjectionRecord = SemanticGenerationRecord & {
  generationModelConfigurationPublicId: string;
  generationModelConfigurationRevision: number;
  extractionContractVersion: string;
  graphSchemaVersion: string;
  promptContractVersion: string;
  projectionContractPublicId: string;
  embeddingConfigurationRevisionPublicId: string;
  embeddingQueryPolicyRevisionPublicId: string;
  minimumVectorRelevance: number;
  searchProviderKind: "meilisearch" | "opensearch";
  resolvedDimension: number;
  normalization: "none" | "l2";
  artifactSchemaVersion: string;
  vectorSchemaVersion: string;
  mappingFingerprintSha256: string;
};

export type SemanticGenerationRepositoryPort = {
  createCandidate(input: {
    operationPublicId: SemanticPublicId;
    candidatePublicId: SemanticPublicId;
    expectedPredecessorPublicId: SemanticPublicId | null;
    target: SemanticMaintenanceTarget;
    contractFingerprintSha256: string;
  }): Promise<SemanticGenerationRecord>;
  getActive(knowledgeBaseId: string): Promise<SemanticGenerationRecord | null>;
  getActiveProjection(
    knowledgeBaseId: string
  ): Promise<SemanticActiveProjectionRecord | null>;
  cloneReusableFacts(input: {
    knowledgeBaseId: string;
    predecessorPublicId: string;
    candidatePublicId: string;
  }): Promise<{
    sourceCount: number;
    factCount: number;
  }>;
  adoptQueryPolicy(input: {
    knowledgeBaseId: string;
    semanticGenerationPublicId: string;
    expectedGenerationRevision: number;
    embeddingQueryPolicyRevisionPublicId: string;
    minimumVectorRelevance: number;
    contractFingerprintSha256: string;
  }): Promise<boolean>;
  isWritableProjection(input: {
    knowledgeBaseId: string;
    semanticGenerationPublicId: SemanticPublicId;
    projectionContractPublicId: SemanticPublicId;
  }): Promise<boolean>;
  getCandidateByOperation(input: {
    knowledgeBaseId: string;
    operationPublicId: SemanticPublicId;
  }): Promise<SemanticGenerationRecord | null>;
  transitionCandidate(input: {
    knowledgeBaseId: string;
    candidatePublicId: SemanticPublicId;
    expectedRevision: number;
    fromState: "building" | "validating" | "ready";
    toState: "validating" | "ready" | "failed" | "cancelled" | "superseded";
  }): Promise<SemanticGenerationRecord>;
  activateCandidate(input: {
    knowledgeBaseId: string;
    candidatePublicId: SemanticPublicId;
    expectedPredecessorPublicId: SemanticPublicId | null;
    expectedCandidateRevision: number;
    activatedAt: string;
  }): Promise<SemanticGenerationRecord>;
  markCleanupFailed(input: {
    knowledgeBaseId: string;
    candidatePublicId: SemanticPublicId;
    expectedRevision: number;
  }): Promise<boolean>;
  discardCandidateByOperation(input: {
    knowledgeBaseId: string;
    operationPublicId: SemanticPublicId;
  }): Promise<"deleted" | "missing">;
};

export type SemanticFactRepositoryPort = {
  replaceSourceFacts(
    input: SemanticDesiredFactSet,
    manifest: SemanticSourceExtractionManifest
  ): Promise<SemanticAffectedClosure>;
  hasSourceRevisionFacts(input: {
    knowledgeBaseId: string;
    semanticGenerationPublicId: string;
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
  }): Promise<boolean>;
  listSourceEntityPublicIds(input: {
    knowledgeBaseId: string;
    semanticGenerationPublicId: string;
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
    limit: number;
  }): Promise<readonly string[]>;
  getSourceAffectedClosure(input: {
    knowledgeBaseId: string;
    semanticGenerationPublicId: string;
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
  }): Promise<SemanticAffectedClosure | null>;
  listActiveEntities(input: {
    knowledgeBaseId: string;
    limit: number;
    cursor: string | null;
  }): Promise<{ items: readonly SemanticEntity[]; nextCursor: string | null }>;
};

export type SemanticSourceBodyReadPort = {
  readVerifiedStream(request: {
    objectId: string;
    checksum: string;
    byteCount: number;
    contentType: string;
    maxBytes: number;
    signal?: AbortSignal;
  }): Promise<AsyncIterable<Uint8Array>>;
};
