import type { StorageVnextBoundedMetadata } from "../shared/types.js";

export const STORAGE_VNEXT_MAINTENANCE_PHASES = [
  "planning",
  "search_rebuild",
  "projection_repair",
  "object_reconciliation",
  "catch_up",
  "validation",
  "activation",
  "cleanup"
] as const;

export type StorageVnextMaintenancePhase =
  typeof STORAGE_VNEXT_MAINTENANCE_PHASES[number];

export type StorageVnextMaintenanceTrigger = "manual" | "automatic";

export type StorageVnextMaintenanceCheckpoint = {
  version: 1;
  trigger: StorageVnextMaintenanceTrigger;
  phase: StorageVnextMaintenancePhase;
  cursor: string | null;
  batchOrdinal: number;
  baseResourceRevision: number;
  completedCount: number;
  expectedCount: number;
  processedBytes: number;
  startedAt: string;
  lastProgressAt: string;
  elapsedActiveMs: number;
  throughputPerSecond: number;
  estimatedCompletionAt: string | null;
  maxAttempts: number;
  resultExpiresAt: string;
};

export type StorageVnextMaintenanceRequest = {
  knowledgeBaseId: string;
  operationPublicId: string;
  trigger: StorageVnextMaintenanceTrigger;
  idempotencyKey: string;
  expectedResourceRevision: number;
  settingsRevisionPublicId: string;
  requestedAt: string;
  expiresAt: string;
  maxAttempts: number;
};

export type StorageVnextMaintenanceAcceptance = {
  outcome: "queued" | "replayed" | "already_active" | "deferred";
  operationPublicId: string | null;
  state: "queued" | "active" | "deferred";
  reasonCode: string | null;
};

export type StorageVnextMaintenanceClaim = {
  knowledgeBaseId: string;
  operationPublicId: string;
  state: "queued" | "running" | "retry" | "superseded";
  attempt: number;
  maxAttempts: number;
  leaseOwner: string | null;
  safeErrorCode: string | null;
  checkpoint: StorageVnextMaintenanceCheckpoint;
};

export type StorageVnextMaintenanceStatus = {
  requestId: string | null;
  state: "idle" | "queued" | "planning" | "running" | "validating"
    | "completed" | "failed" | "superseded";
  trigger: StorageVnextMaintenanceTrigger | null;
  stage: StorageVnextMaintenancePhase | null;
  active: boolean;
  completedCount: number;
  expectedCount: number;
  retryCount: number;
  lastProgressAt: string | null;
  lastCompletedAt: string | null;
  maintenanceRequired: boolean;
  safeErrorCode: string | null;
  safeErrorMessage: string | null;
  throughputPerSecond: number;
  estimatedCompletionAt: string | null;
};

export type StorageVnextMaintenanceResourcePermit = {
  outcome: "acquired";
  release(): void;
};

export type StorageVnextMaintenanceBackpressure = {
  outcome: "backpressured";
  reasonCode: string;
};

export interface StorageVnextMaintenanceResourceGate {
  tryAcquire(): Promise<
    StorageVnextMaintenanceResourcePermit | StorageVnextMaintenanceBackpressure
  >;
}

export type StorageVnextMaintenancePhaseResult =
  | {
      outcome: "progress";
      cursor: string;
      completedDelta: number;
      expectedCount: number;
      processedBytesDelta: number;
      batchOrdinalDelta?: number;
    }
  | {
      outcome: "phase_completed";
      completedDelta: number;
      expectedCount: number;
      processedBytesDelta: number;
      batchOrdinalDelta?: number;
    };

export interface StorageVnextMaintenanceRepository {
  acceptMaintenance(input: StorageVnextMaintenanceRequest & {
    requestHash: string;
    workKind: "maintenance";
    initialCheckpoint: StorageVnextMaintenanceCheckpoint;
  }): Promise<StorageVnextMaintenanceAcceptance>;
  claimOne(input: {
    workerId: string;
    leaseExpiresAt: string;
  }): Promise<StorageVnextMaintenanceClaim | null>;
  saveProgress(input: {
    operationPublicId: string;
    leaseOwner: string;
    checkpoint: StorageVnextMaintenanceCheckpoint;
  }): Promise<void>;
  releaseForRetry(input: {
    operationPublicId: string;
    leaseOwner: string;
    safeErrorCode: string;
  }): Promise<"retry" | "exhausted">;
  complete(input: {
    operationPublicId: string;
    leaseOwner: string;
    state: "completed" | "failed" | "superseded";
    resultCode: string;
    summary?: StorageVnextBoundedMetadata;
  }): Promise<void>;
  recoverStale(input: {
    expiredBefore: string;
    retryAt: string;
    limit: number;
  }): Promise<number>;
  getStatus(input: {
    knowledgeBaseId: string;
  }): Promise<StorageVnextMaintenanceStatus>;
}

export interface StorageVnextMaintenancePhaseRunner {
  runPhase(input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    checkpoint: StorageVnextMaintenanceCheckpoint;
    searchProjection: {
      activeRole: "active";
      candidateRole: "candidate";
      documentKinds: readonly ["content", "graph_seed"];
    };
    signal: AbortSignal;
  }): Promise<StorageVnextMaintenancePhaseResult>;
}

export interface StorageVnextMaintenanceCleanup {
  terminate(input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    outcome: "completed" | "failed" | "superseded";
  }): Promise<unknown>;
}
