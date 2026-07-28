export type ManagedImmutableObjectIdentity = {
  key: string;
  sizeBytes: number;
  etag: string | null;
  lastModified: string | null;
  checksumSha256: string;
  formatVersion: number;
};

export type StorageReconciliationCycle = {
  prefix: string;
  cycleId: string;
  state: "scanning" | "verifying";
  continuationToken: string | null;
  verificationCursor: string | null;
  databaseChunkSize: number | null;
};

export type StorageReconciliationCandidate = ManagedImmutableObjectIdentity & {
  confirmationCount: number;
  attemptCount: number;
};

export type RegisteredImmutableObjectCheck = {
  checksumSha256: string;
  formatVersion: number;
  objectKey: string;
};

export type StorageReconciliationStatus = {
  state: "idle" | "scanning" | "verifying" | "failed";
  lastScanStartedAt: string | null;
  lastScanCompletedAt: string | null;
  listedCount: number;
  quarantinedCount: number;
  deletedCount: number;
  missingCount: number;
  retryCount: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  resolvedCount: number;
  pendingCount: number;
  databaseChunkSize: number | null;
  recentObjectsPerSecond: number | null;
  rollingBatchLatencyMs: number | null;
  heartbeatAt: string | null;
  lastProgressAt: string | null;
};

export type StorageReconciliationRepository = {
  claimCycle: (input: {
    prefix: string;
    cycleId: string;
    leaseToken: string;
    now: string;
    leaseExpiresAt: string;
  }) => Promise<StorageReconciliationCycle | null>;
  renewCycleLease: (input: {
    cycle: StorageReconciliationCycle;
    leaseToken: string;
    renewedAt: string;
    leaseExpiresAt: string;
  }) => Promise<boolean>;
  getProtectionReadiness: () => Promise<
    "pending" | "backfilling" | "verifying" | "ready" | "retrying" | "failed"
  >;
  prepareScanPage: (input: {
    cycle: StorageReconciliationCycle;
    leaseToken: string;
    pageId: string;
    nextContinuationToken: string | null;
    listedCount: number;
    databaseChunkSize: number;
    preparedAt: string;
  }) => Promise<{
    completedObjectCount: number;
    databaseChunkSize: number;
    committed: boolean;
  } | null>;
  recordScanChunk: (input: {
    cycle: StorageReconciliationCycle;
    leaseToken: string;
    pageId: string;
    objectOffset: number;
    objects: ManagedImmutableObjectIdentity[];
    allowQuarantine: boolean;
    recordedAt: string;
  }) => Promise<boolean>;
  reduceScanPageChunkSize: (input: {
    cycle: StorageReconciliationCycle;
    leaseToken: string;
    pageId: string;
    databaseChunkSize: number;
    reducedAt: string;
  }) => Promise<boolean>;
  completeScanPage: (input: {
    cycle: StorageReconciliationCycle;
    leaseToken: string;
    pageId: string;
    completedAt: string;
    batchLatencyMs: number;
  }) => Promise<boolean>;
  claimDeletionCandidates: (input: {
    cycle: StorageReconciliationCycle;
    leaseToken: string;
    now: string;
    staleDeletingBefore: string;
    graceBefore: string;
    confirmationPasses: number;
    maxAttempts: number;
    limit: number;
  }) => Promise<StorageReconciliationCandidate[]>;
  authorizeCandidateDeletion: (input: {
    cycle: StorageReconciliationCycle;
    leaseToken: string;
    objectKey: string;
    checksumSha256: string;
    formatVersion: number;
    authorizedAt: string;
  }) => Promise<boolean>;
  refreshCandidateObservation: (input: {
    cycle: StorageReconciliationCycle;
    leaseToken: string;
    object: ManagedImmutableObjectIdentity;
    observedAt: string;
  }) => Promise<void>;
  completeCandidateDeletion: (input: {
    cycle: StorageReconciliationCycle;
    leaseToken: string;
    objectKey: string;
    completedAt: string;
  }) => Promise<void>;
  failCandidateDeletion: (input: {
    cycle: StorageReconciliationCycle;
    leaseToken: string;
    objectKey: string;
    errorCode: string;
    retryAt: string;
    failedAt: string;
  }) => Promise<void>;
  listRegisteredObjectsForVerification: (input: {
    cycle: StorageReconciliationCycle;
    leaseToken: string;
    limit: number;
  }) => Promise<RegisteredImmutableObjectCheck[]>;
  recordRegisteredObjectCheck: (input: {
    cycle: StorageReconciliationCycle;
    leaseToken: string;
    object: RegisteredImmutableObjectCheck;
    exists: boolean;
    checkedAt: string;
  }) => Promise<boolean>;
  finishCycle: (input: {
    cycle: StorageReconciliationCycle;
    leaseToken: string;
    nextScanAt: string;
    completedAt: string;
  }) => Promise<boolean>;
  failCycle: (input: {
    cycle: StorageReconciliationCycle;
    leaseToken: string;
    errorCode: string;
    retryAt: string;
    failedAt: string;
    databaseChunkSize?: number;
  }) => Promise<void>;
  getStatus: (prefix: string) => Promise<StorageReconciliationStatus | null>;
};
