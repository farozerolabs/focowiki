import type { SearchProviderKind } from
  "../../application/ports/search-provider-runtime.js";

export type StorageVnextSearchCleanupLease = {
  publicId: string;
  providerKind: SearchProviderKind;
  providerIndexUid: string;
  correlationPublicId: string;
  providerOperationRef: string | null;
};

export interface StorageVnextSearchCleanupRepository {
  claimFailedCandidate(input: {
    failedBefore: string;
    correlationPublicId: string;
    providerKind: SearchProviderKind;
  }): Promise<StorageVnextSearchCleanupLease | null>;
  listRetainedProviderIndexUids(input: {
    providerKind: SearchProviderKind;
    providerIndexUids: readonly string[];
  }): Promise<string[]>;
  claimActiveCompaction(input: {
    compactedBefore: string;
    correlationPublicId: string;
  }): Promise<StorageVnextSearchCleanupLease | null>;
  recordCleanupOperation(input: {
    projectionPublicId: string;
    correlationPublicId: string;
    providerOperationRef: string;
  }): Promise<void>;
  clearCleanupOperation(input: {
    projectionPublicId: string;
    correlationPublicId: string;
    providerOperationRef: string;
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
