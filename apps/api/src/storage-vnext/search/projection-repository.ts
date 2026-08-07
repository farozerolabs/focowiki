import type { SearchProviderKind } from
  "../../application/ports/search-provider-runtime.js";

export type StorageVnextSearchProjectionState =
  | "preparing"
  | "indexing"
  | "validating"
  | "ready"
  | "failed";

export type StorageVnextSearchProjectionRecord = {
  publicId: string;
  knowledgeBaseId: string;
  providerKind: SearchProviderKind;
  providerIndexUid: string;
  schemaChecksum: string;
  settingsChecksum: string;
  documentChecksum: string | null;
  state: StorageVnextSearchProjectionState;
  documentCount: number;
  nextBatchOrdinal: number;
  lastBatchOrdinal: number | null;
  lastBatchChecksum: string | null;
  correlationPublicId: string | null;
  providerOperationRef: string | null;
  revision: number;
};

export type StorageVnextSearchOperationResume = {
  outcome: "resume" | "start";
  providerOperationRef: string | null;
};

export type StorageVnextSearchBatchResume = {
  outcome: "completed" | "resume" | "start";
  providerOperationRef: string | null;
};

export interface StorageVnextSearchProjectionRepository {
  reserveCandidate(input: {
    publicId: string;
    knowledgeBaseId: string;
    providerKind: SearchProviderKind;
    providerIndexUid: string;
    schemaChecksum: string;
    settingsChecksum: string;
  }): Promise<{
    outcome: "created" | "existing";
    projection: StorageVnextSearchProjectionRecord;
  }>;
  getCandidate(
    candidatePublicId: string
  ): Promise<StorageVnextSearchProjectionRecord | null>;
  beginProviderOperation(input: {
    candidatePublicId: string;
    correlationPublicId: string;
  }): Promise<StorageVnextSearchOperationResume>;
  recordProviderOperation(input: {
    candidatePublicId: string;
    correlationPublicId: string;
    providerOperationRef: string;
  }): Promise<void>;
  completeProviderOperation(input: {
    candidatePublicId: string;
    correlationPublicId: string;
  }): Promise<void>;
  markCandidateIndexing(candidatePublicId: string): Promise<void>;
  beginDocumentBatch(input: {
    candidatePublicId: string;
    batchOrdinal: number;
    payloadChecksum: string;
    correlationPublicId: string;
  }): Promise<StorageVnextSearchBatchResume>;
  completeDocumentBatch(input: {
    candidatePublicId: string;
    batchOrdinal: number;
    payloadChecksum: string;
    correlationPublicId: string;
    documentCount: number;
  }): Promise<void>;
  beginCandidateValidation(input: {
    candidatePublicId: string;
    expectedDocumentCount: number;
    documentChecksum: string;
    schemaChecksum: string;
    settingsChecksum: string;
  }): Promise<{ outcome: "completed" | "validate" }>;
  completeCandidateValidation(input: {
    candidatePublicId: string;
    documentChecksum: string;
  }): Promise<void>;
  failCandidateValidation(input: {
    candidatePublicId: string;
    safeErrorCode: string;
  }): Promise<void>;
}
