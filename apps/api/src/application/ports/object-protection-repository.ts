import type {
  ObjectProtectionClass,
  ObjectProtectionRecord,
  ObjectProtectionReadiness
} from "../../domain/storage-object-protection.js";

export type ObjectProtectionIdentity = {
  objectKey: string;
  checksumSha256: string;
  formatVersion: number;
};

export type ObjectProtectionMaintenanceClaim = {
  schemaVersion: number;
  revision: number;
  state: Exclude<ObjectProtectionReadiness, "ready">;
  phase:
    | "immutable_objects"
    | "source_files"
    | "projection_segments"
    | "dirty_refresh"
    | "verify_immutable_objects"
    | "verify_source_files"
    | "verify_projection_segments";
  cursorObjectKey: string | null;
};

export type ObjectProtectionMaintenanceStatus = {
  readiness: ObjectProtectionReadiness;
  phase: ObjectProtectionMaintenanceClaim["phase"] | "ready";
  processedCount: number;
  expectedCount: number;
  verifiedCount: number;
  dirtyCount: number;
  retryCount: number;
  recentObjectsPerSecond: number | null;
  rollingBatchLatencyMs: number | null;
  lastProgressAt: string | null;
  heartbeatAt: string | null;
  estimatedCompletionAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
};

export type ObjectProtectionMaintenanceBatchResult = {
  processed: number;
  completed: boolean;
  phase: ObjectProtectionMaintenanceStatus["phase"];
};

export type ObjectProtectionRepository = {
  protectIdentities: (input: {
    identities: Array<ObjectProtectionIdentity & {
      protectionClass: ObjectProtectionClass;
    }>;
  }) => Promise<void>;
  markIdentitiesDirty: (input: {
    identities: Array<ObjectProtectionIdentity & { reason: string }>;
  }) => Promise<void>;
  lookupIdentities: (
    identities: ObjectProtectionIdentity[]
  ) => Promise<ObjectProtectionRecord[]>;
  getReadiness: () => Promise<ObjectProtectionReadiness>;
  claimMaintenance: (input: {
    leaseToken: string;
    now: string;
    leaseExpiresAt: string;
  }) => Promise<ObjectProtectionMaintenanceClaim | null>;
  renewMaintenanceLease: (input: {
    claim: ObjectProtectionMaintenanceClaim;
    leaseToken: string;
    now: string;
    leaseExpiresAt: string;
  }) => Promise<boolean>;
  runBackfillBatch: (input: {
    claim: ObjectProtectionMaintenanceClaim;
    leaseToken: string;
    limit: number;
    now: string;
  }) => Promise<ObjectProtectionMaintenanceBatchResult>;
  refreshDirtyBatch: (input: {
    claim: ObjectProtectionMaintenanceClaim;
    leaseToken: string;
    limit: number;
    now: string;
  }) => Promise<ObjectProtectionMaintenanceBatchResult>;
  failMaintenance: (input: {
    claim: ObjectProtectionMaintenanceClaim;
    leaseToken: string;
    errorCode: string;
    errorMessage: string;
    retryAt: string;
    failedAt: string;
  }) => Promise<void>;
  getStatus: () => Promise<ObjectProtectionMaintenanceStatus>;
};
