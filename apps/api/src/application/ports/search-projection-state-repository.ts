export type SearchRouteState = "postgres_compatibility" | "meilisearch";
export type SearchPendingActivationState = "indexing" | "swapping";
export type SearchIndexKind = "content" | "graph";
export type SearchWorkKind =
  | "prepare_index"
  | "documents"
  | "delete_documents"
  | "validate"
  | "activate"
  | "cleanup";
export type SearchWorkState =
  | "queued"
  | "submitted"
  | "succeeded"
  | "retry"
  | "failed"
  | "canceled"
  | "superseded";

export type KnowledgeBaseSearchState = {
  knowledgeBaseId: string;
  routeState: SearchRouteState;
  activeEpoch: number;
  pendingEpoch: number | null;
  pendingActivationState: SearchPendingActivationState;
  pendingFullRebuild: boolean;
  activeGenerationId: string | null;
  pendingGenerationId: string | null;
  contentSchemaVersion: string | null;
  graphSchemaVersion: string | null;
  contentSettingsChecksum: string | null;
  graphSettingsChecksum: string | null;
  pendingContentSchemaVersion: string | null;
  pendingGraphSchemaVersion: string | null;
  pendingContentSettingsChecksum: string | null;
  pendingGraphSettingsChecksum: string | null;
  maintenanceRequired: boolean;
  updatedAt: string;
};

export type SearchProjectionWork = {
  id: string;
  knowledgeBaseId: string;
  epoch: number;
  generationId: string | null;
  maintenanceRequestId: string | null;
  indexKind: SearchIndexKind;
  workKind: SearchWorkKind;
  batchOrdinal: number;
  payloadChecksum: string;
  documentCount: number;
  compressedBytes: number;
  state: SearchWorkState;
  taskUid: number | null;
  taskCorrelation: string;
  checkpoint: Record<string, unknown>;
  leaseOwner: string | null;
  leaseToken: string | null;
  attemptCount: number;
  maxAttempts: number;
  runAfter: string;
  safeErrorCode: string | null;
  safeErrorMessage: string | null;
};

export type SearchProjectionWorkDraft = Pick<
  SearchProjectionWork,
  | "id"
  | "knowledgeBaseId"
  | "epoch"
  | "generationId"
  | "maintenanceRequestId"
  | "indexKind"
  | "workKind"
  | "batchOrdinal"
  | "payloadChecksum"
  | "documentCount"
  | "compressedBytes"
  | "taskCorrelation"
  | "maxAttempts"
> & {
  checkpoint?: Record<string, unknown>;
};

export type SearchProjectionEpochProgress = {
  total: number;
  queued: number;
  submitted: number;
  retry: number;
  succeeded: number;
  failed: number;
  canceled: number;
  superseded: number;
  activationReady: boolean;
};

export interface SearchProjectionStateRepository {
  getState(knowledgeBaseId: string): Promise<KnowledgeBaseSearchState | null>;
  reservePendingEpoch(input: {
    knowledgeBaseId: string;
    generationId: string;
    maintenanceRequestId: string | null;
    forceFullRebuild?: boolean;
    contract: {
      contentSchemaVersion: string;
      graphSchemaVersion: string;
      contentSettingsChecksum: string;
      graphSettingsChecksum: string;
    };
    reservedAt: string;
  }): Promise<
    | { outcome: "reserved" | "existing"; state: KnowledgeBaseSearchState }
    | { outcome: "busy"; state: KnowledgeBaseSearchState }
    | { outcome: "not_found" }
  >;
  createWork(items: SearchProjectionWorkDraft[]): Promise<number>;
  getEpochProgress(input: {
    knowledgeBaseId: string;
    epoch: number;
  }): Promise<SearchProjectionEpochProgress>;
  claimWork(input: {
    workerId: string;
    leaseTokenPrefix: string;
    limit: number;
    maxInFlightTasks: number;
    allowNewSubmissions: boolean;
    now: string;
    leaseExpiresAt: string;
  }): Promise<SearchProjectionWork[]>;
  markSubmitted(input: {
    work: SearchProjectionWork;
    taskUid: number;
    submittedAt: string;
    leaseExpiresAt: string;
  }): Promise<boolean>;
  markSucceeded(input: {
    work: SearchProjectionWork;
    completedAt: string;
  }): Promise<boolean>;
  retryOrFail(input: {
    work: SearchProjectionWork;
    code: string;
    message: string;
    retryAt: string;
    failedAt: string;
  }): Promise<"retry" | "failed" | "lost">;
  restartFailedEpoch(input: {
    knowledgeBaseId: string;
    generationId: string;
    maintenanceRequestId: string | null;
    epoch: number;
    resetAll: boolean;
    maxAttempts: number;
    contract: {
      contentSchemaVersion: string;
      graphSchemaVersion: string;
      contentSettingsChecksum: string;
      graphSettingsChecksum: string;
    };
    restartedAt: string;
  }): Promise<boolean>;
  rebaseFailedEpoch(input: {
    knowledgeBaseId: string;
    generationId: string;
    maintenanceRequestId: string | null;
    epoch: number;
    maxAttempts: number;
    contract: {
      contentSchemaVersion: string;
      graphSchemaVersion: string;
      contentSettingsChecksum: string;
      graphSettingsChecksum: string;
    };
    rebasedAt: string;
  }): Promise<KnowledgeBaseSearchState | null>;
  beginActivation(input: {
    knowledgeBaseId: string;
    generationId: string;
    epoch: number;
    startedAt: string;
  }): Promise<boolean>;
  activateEpoch(input: {
    knowledgeBaseId: string;
    generationId: string;
    epoch: number;
    contentSchemaVersion: string;
    graphSchemaVersion: string;
    contentSettingsChecksum: string;
    graphSettingsChecksum: string;
    activatedAt: string;
  }): Promise<boolean>;
  cancelForKnowledgeBase(input: {
    knowledgeBaseId: string;
    canceledAt: string;
  }): Promise<number>;
}
