export type StorageVnextSearchCleanupLease = {
  publicId: string;
  providerIndexUid: string;
  correlationPublicId: string;
  providerTaskUid: number | null;
};

export interface StorageVnextSearchCleanupRepository {
  claimFailedCandidate(input: {
    failedBefore: string;
    correlationPublicId: string;
  }): Promise<StorageVnextSearchCleanupLease | null>;
  listRetainedProviderIndexUids(
    providerIndexUids: readonly string[]
  ): Promise<string[]>;
  claimActiveCompaction(input: {
    compactedBefore: string;
    correlationPublicId: string;
  }): Promise<StorageVnextSearchCleanupLease | null>;
  recordCleanupTask(input: {
    projectionPublicId: string;
    correlationPublicId: string;
    providerTaskUid: number;
  }): Promise<void>;
  clearCleanupTask(input: {
    projectionPublicId: string;
    correlationPublicId: string;
    providerTaskUid: number;
  }): Promise<void>;
  completeFailedCandidateCleanup(input: {
    candidatePublicId: string;
    correlationPublicId: string;
  }): Promise<void>;
  completeCompaction(input: {
    projectionPublicId: string;
    correlationPublicId: string;
    databaseSizeBytes: number;
    usedDatabaseSizeBytes: number;
  }): Promise<void>;
}
