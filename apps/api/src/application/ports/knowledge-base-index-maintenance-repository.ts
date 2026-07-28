export type KnowledgeBaseIndexMaintenanceTrigger = "manual" | "automatic";

export type KnowledgeBaseIndexMaintenanceState =
  | "queued"
  | "planning"
  | "running"
  | "validating"
  | "completed"
  | "failed"
  | "superseded"
  | "canceled";

export const ACTIVE_KNOWLEDGE_BASE_INDEX_MAINTENANCE_STATES = [
  "queued",
  "planning",
  "running",
  "validating"
] as const satisfies readonly KnowledgeBaseIndexMaintenanceState[];

export type KnowledgeBaseIndexMaintenanceRequest = {
  id: string;
  knowledgeBaseId: string;
  trigger: KnowledgeBaseIndexMaintenanceTrigger;
  state: KnowledgeBaseIndexMaintenanceState;
  baseGenerationId: string | null;
  sourceWatermark: number | null;
  settingsRevision: number;
  plannedScopes: string[];
  completedScopes: string[];
  stage: string | null;
  completedCount: number;
  expectedCount: number;
  retryCount: number;
  maxAttempts: number;
  lastProgressAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeBaseIndexMaintenanceClaim =
  KnowledgeBaseIndexMaintenanceRequest & {
    leaseOwner: string;
    leaseToken: string;
  };

export type KnowledgeBaseIndexMaintenanceSummary = {
  requestId: string | null;
  state: KnowledgeBaseIndexMaintenanceState | "idle";
  trigger: KnowledgeBaseIndexMaintenanceTrigger | null;
  stage: string | null;
  active: boolean;
  completedCount: number;
  expectedCount: number;
  retryCount: number;
  lastProgressAt: string | null;
  lastCompletedAt: string | null;
  maintenanceRequired: boolean;
  safeErrorCode: string | null;
  safeErrorMessage: string | null;
};

export type KnowledgeBaseIndexMaintenanceRepository = {
  createOrGet: (input: {
    requestId: string;
    knowledgeBaseId: string;
    trigger: KnowledgeBaseIndexMaintenanceTrigger;
    idempotencyKey: string | null;
    actor: string | null;
    settingsRevision: number;
    settingsSnapshot: Record<string, string | number | boolean>;
    maxAttempts: number;
    now: string;
  }) => Promise<
    | {
        outcome: "accepted" | "already_active";
        request: KnowledgeBaseIndexMaintenanceRequest;
      }
    | { outcome: "not_found" | "deleted" }
  >;
  discoverAutomaticDue: (input: {
    requestIdPrefix: string;
    settingsRevision: number;
    settingsSnapshot: Record<string, string | number | boolean>;
    maxAttempts: number;
    dueBefore: string;
    limit: number;
    now: string;
  }) => Promise<number>;
  cancelQueuedAutomatic: (input: { canceledAt: string }) => Promise<number>;
  claimBatch: (input: {
    workerId: string;
    leaseTokenPrefix: string;
    limit: number;
    now: string;
    leaseExpiresAt: string;
  }) => Promise<KnowledgeBaseIndexMaintenanceClaim[]>;
  start: (input: {
    request: KnowledgeBaseIndexMaintenanceClaim;
    plannedScopes: string[];
    startedAt: string;
  }) => Promise<boolean>;
  heartbeat: (input: {
    request: KnowledgeBaseIndexMaintenanceClaim;
    stage: string;
    completedCount: number;
    expectedCount: number;
    heartbeatAt: string;
    leaseExpiresAt: string;
  }) => Promise<boolean>;
  complete: (input: {
    request: KnowledgeBaseIndexMaintenanceClaim;
    completedScopes: string[];
    completedAt: string;
  }) => Promise<boolean>;
  retryOrFail: (input: {
    request: KnowledgeBaseIndexMaintenanceClaim;
    errorCode: string;
    errorMessage: string;
    retryAt: string;
    failedAt: string;
  }) => Promise<"retry" | "failed" | "lost">;
  cancelForKnowledgeBase: (input: {
    knowledgeBaseId: string;
    canceledAt: string;
  }) => Promise<number>;
  getSummary: (input: {
    knowledgeBaseId: string;
  }) => Promise<KnowledgeBaseIndexMaintenanceSummary>;
  listActiveKnowledgeBaseIds: (input: { limit: number }) => Promise<string[]>;
};
