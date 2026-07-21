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

export type MaintenanceProgressSummary = {
  migration: MaintenanceMigrationProgress | null;
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
