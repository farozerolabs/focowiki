export type MaintenanceMigrationProgress = {
  state: string;
  phase: string;
  attemptCount: number;
  maxAttempts: number;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  safeErrorCode: string | null;
  safeErrorMessage: string | null;
};

export type MaintenanceCompactionProgress = {
  state: string;
  attemptCount: number;
  maxAttempts: number;
  queuedAt: string;
  updatedAt: string;
  completedAt: string | null;
  safeErrorCode: string | null;
};

export type MaintenanceProjectionRepairProgress = {
  repairVersion: number;
  state: string;
  phase: string;
  attemptCount: number;
  requiredProjectionKinds: string[];
  completedProjectionKinds: string[];
  completedSubtaskCount: number;
  totalSubtaskCount: number;
  completedRecordCount: number;
  totalRecordCount: number;
  completedDirectoryCount: number;
  totalDirectoryCount: number;
  objectWriteCount: number;
  objectReuseCount: number;
  retryCount: number;
  recordsPerSecond: number | null;
  rollingBatchLatencyMs: number | null;
  lastProgressAt: string | null;
  lastHeartbeatAt: string | null;
  estimatedCompletionAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  safeErrorCode: string | null;
  safeErrorMessage: string | null;
};

export type MaintenanceLexicalRebuildProgress = {
  state: string;
  phase: string;
  searchSchemaVersion: string;
  tokenizerContractVersion: string;
  segmentationVersion: string;
  contentProfileVersion: string;
  graphLexicalProjectionVersion: string;
  processedSourceCount: number;
  pendingSourceCount: number;
  runningSourceCount: number;
  retrySourceCount: number;
  failedSourceCount: number;
  totalSourceCount: number;
  activeWorkerCount: number;
  sourceReadRetryCount: number;
  databaseRetryCount: number;
  filesPerSecond: number | null;
  sourceReadLatencyMs: number | null;
  databaseBatchLatencyMs: number | null;
  lastProgressAt: string | null;
  lastWorkerHeartbeatAt: string | null;
  estimatedCompletionAt: string | null;
  attemptCount: number;
  maxAttempts: number;
  updatedAt: string;
  completedAt: string | null;
  safeErrorCode: string | null;
  safeErrorMessage: string | null;
};

export type MaintenanceSearchProjectionProgress = {
  routeState: "postgres_compatibility" | "meilisearch";
  maintenanceRequired: boolean;
  activeEpoch: number;
  pendingEpoch: number | null;
  generationId: string | null;
  queuedCount: number;
  submittedCount: number;
  retryCount: number;
  succeededCount: number;
  failedCount: number;
  canceledCount: number;
  totalCount: number;
  updatedAt: string;
  safeErrorCode: string | null;
  safeErrorMessage: string | null;
};

export type MaintenanceProgressSummary = {
  migration: MaintenanceMigrationProgress | null;
  lexicalRebuild: MaintenanceLexicalRebuildProgress | null;
  searchProjection: MaintenanceSearchProjectionProgress | null;
  projectionRepair: MaintenanceProjectionRepairProgress | null;
  compaction: {
    active: MaintenanceCompactionProgress | null;
    latestCompleted: MaintenanceCompactionProgress | null;
  };
};

export type MaintenanceProgressRepository = {
  getSummary(input: {
    knowledgeBaseId: string;
  }): Promise<MaintenanceProgressSummary>;
};
