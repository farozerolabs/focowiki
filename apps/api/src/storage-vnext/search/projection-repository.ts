export type StorageVnextSearchProjectionState =
  | "preparing"
  | "indexing"
  | "validating"
  | "ready"
  | "failed";

export type StorageVnextSearchProjectionRecord = {
  publicId: string;
  knowledgeBaseId: string;
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
  providerTaskUid: number | null;
  revision: number;
};

export type StorageVnextSearchTaskResume = {
  outcome: "resume" | "start";
  providerTaskUid: number | null;
};

export type StorageVnextSearchBatchResume = {
  outcome: "completed" | "resume" | "start";
  providerTaskUid: number | null;
};

export interface StorageVnextSearchProjectionRepository {
  reserveCandidate(input: {
    publicId: string;
    knowledgeBaseId: string;
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
  beginProviderTask(input: {
    candidatePublicId: string;
    correlationPublicId: string;
  }): Promise<StorageVnextSearchTaskResume>;
  recordProviderTask(input: {
    candidatePublicId: string;
    correlationPublicId: string;
    providerTaskUid: number;
  }): Promise<void>;
  completeProviderTask(input: {
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
