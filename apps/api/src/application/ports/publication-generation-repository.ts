import type { SerializableJson } from "./source-dispatch-repository.js";
import type { ChangeFactKind } from "../../domain/generation.js";
import type { PublicationImpact } from "../../publication/impact-planner.js";

export type SourceCompletionCommitResult = {
  generationId: string | null;
  changeFactId: string;
  impactCount: number;
  replayed: boolean;
};

export type PublicationMutationCommitResult = SourceCompletionCommitResult;

export type PublicationProgressSummary = {
  generationId: string | null;
  stage: string | null;
  processedImpactCount: number;
  totalImpactCount: number;
  touchedShardCount: number;
  throughputPerMinute: number | null;
  oldestDirtyAt: string | null;
  queuedAt: string | null;
  startedAt: string | null;
  heartbeatAt: string | null;
  completedAt: string | null;
  lastSuccessAt: string | null;
  safeErrorCode: string | null;
  safeErrorMessage: string | null;
};

export type FrozenGeneration = {
  generationId: string;
  predecessorGenerationId: string | null;
  state: "frozen" | "building" | "validating";
  totalImpactCount: number;
  frozenAt: string;
};

export type PublicationGenerationRepository = {
  getProgressSummary: (input: {
    knowledgeBaseId: string;
  }) => Promise<PublicationProgressSummary>;
  commitSourceCompletion: (input: {
    knowledgeBaseId: string;
    sourceFileId: string;
    sourceRevisionId: string;
    kind: Extract<ChangeFactKind, "source_created" | "source_replaced">;
    previousPath: string | null;
    path: string;
    resourceRevision: number;
    operationId: string | null;
    changeFactId: string;
    impacts?: PublicationImpact[];
    planningContext?: {
      graphNeighborSourceFileIds: string[];
      graphEdgeIds: string[];
      removedGraphEdgeIds: string[];
      impactPlanner: {
        searchShardCount: number;
        linkShardCount: number;
        manifestShardCount: number;
        treeShardCount: number;
        graphNodeShardCount: number;
        graphEdgeShardCount: number;
      };
    };
    publicationSettingsSnapshot: SerializableJson;
    publicationMaxAttempts: number;
    completedAt: string;
  }) => Promise<SourceCompletionCommitResult>;
  commitMutation: (input: {
    knowledgeBaseId: string;
    sourceFileId: string | null;
    sourceRevisionId: string | null;
    kind: ChangeFactKind;
    previousPath: string | null;
    path: string | null;
    resourceRevision: number;
    operationId: string | null;
    deletionIntentId: string | null;
    changeFactId: string;
    impacts: PublicationImpact[];
    publicationSettingsSnapshot: SerializableJson;
    publicationMaxAttempts: number;
    schedulePublication?: boolean | undefined;
    committedAt: string;
  }) => Promise<PublicationMutationCommitResult>;
  assemblePendingChanges: (input: {
    knowledgeBaseId: string;
    assemblerJobId: string;
    limit: number;
    assembledAt: string;
  }) => Promise<{
    generationId: string | null;
    assembledChangeCount: number;
    impactCount: number;
    hasMore: boolean;
  }>;
  freezeGeneration: (input: {
    knowledgeBaseId: string;
    generationId: string;
    frozenAt: string;
  }) => Promise<FrozenGeneration | null>;
  markGenerationState: (input: {
    knowledgeBaseId: string;
    generationId: string;
    expectedState: "frozen" | "building" | "validating";
    state: "building" | "validating";
    updatedAt: string;
  }) => Promise<boolean>;
  activateGeneration: (input: {
    knowledgeBaseId: string;
    generationId: string;
    expectedPredecessorGenerationId: string | null;
    rootManifestChecksumSha256: string;
    rootManifestObjectKey: string;
    activatedAt: string;
  }) => Promise<boolean>;
  failGeneration: (input: {
    knowledgeBaseId: string;
    generationId: string;
    code: string;
    message: string;
    failedAt: string;
  }) => Promise<void>;
};
