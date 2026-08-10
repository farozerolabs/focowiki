import type {
  SemanticStageKind,
  SemanticStageSettingsSnapshot,
  SemanticStageWorkItem
} from "./stage-orchestration.js";

export type SemanticStageWorkState =
  | "queued" | "running" | "retry" | "completed"
  | "failed" | "cancelled" | "superseded";

export type SemanticStageWorkClaim = SemanticStageWorkItem & {
  state: "running";
  attemptCount: number;
  checkpoint: SemanticStageSettingsSnapshot;
  leaseOwner: string;
  leaseExpiresAt: string;
  cancellationRequestedAt: string | null;
  revision: number;
};

export type SemanticStageRepositoryPort = {
  enqueue(input: {
    items: readonly SemanticStageWorkItem[];
    enqueuedAt: string;
  }): Promise<number>;
  claim(input: {
    stageKinds: readonly SemanticStageKind[];
    owner: string;
    limit: number;
    maximumParallelStagesPerKnowledgeBase?: number;
    excludedKnowledgeBaseIds?: readonly string[];
    now: string;
    leaseExpiresAt: string;
  }): Promise<SemanticStageWorkClaim[]>;
  isOwned(input: { claim: SemanticStageWorkClaim }): Promise<boolean>;
  renew(input: {
    claim: SemanticStageWorkClaim;
    leaseExpiresAt: string;
  }): Promise<boolean>;
  saveCheckpoint(input: {
    claim: SemanticStageWorkClaim;
    checkpoint: SemanticStageSettingsSnapshot;
  }): Promise<boolean>;
  finish(input: {
    claim: SemanticStageWorkClaim;
    outcome: "completed" | "retry" | "failed" | "cancelled" | "superseded";
    safeCode: string | null;
    nextAttemptAt: string;
    completedAt: string;
  }): Promise<boolean>;
  requestCancellation(input: {
    knowledgeBaseId: string;
    semanticGenerationPublicId: string;
    sourceFilePublicIds: readonly string[] | null;
    exceptOperationPublicId?: string;
    requestedAt: string;
  }): Promise<number>;
  recoverExpired(input: {
    expiredBefore: string;
    nextAttemptAt: string;
    limit: number;
  }): Promise<number>;
  summarizeOperation(input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    semanticGenerationPublicId: string;
  }): Promise<{
    totalCount: number;
    completedCount: number;
    pendingCount: number;
    failedCount: number;
    cancelledCount: number;
    supersededCount: number;
    reusedArtifactCount: number;
  }>;
};
