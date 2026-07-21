export type IncrementalStatisticsReconciliationClaim = {
  knowledgeBaseId: string;
  workerId: string;
  leaseToken: string;
};

export type IncrementalStatisticsRepository = {
  claimForReconciliation: (input: {
    workerId: string;
    leaseToken: string;
    now: string;
    leaseExpiresAt: string;
    reconciledBefore: string;
  }) => Promise<IncrementalStatisticsReconciliationClaim | null>;
  reconcile: (input: IncrementalStatisticsReconciliationClaim & {
    reconciledAt: string;
  }) => Promise<{ changed: boolean }>;
  release: (input: IncrementalStatisticsReconciliationClaim) => Promise<void>;
};
