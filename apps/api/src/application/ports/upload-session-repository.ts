import type {
  UploadManifestEntryInput,
  UploadSessionEntryRecord,
  UploadSessionRecord
} from "../../domain/upload-session.js";

export type UploadSessionPage<T> = {
  items: T[];
  nextCursor: string | null;
};

export type UploadSessionRepository = {
  createSession: (input: {
    id: string;
    knowledgeBaseId: string;
    idempotencyKey: string;
    declaredFileCount: number;
    declaredByteCount: number;
    expiresAt: string;
  }) => Promise<UploadSessionRecord>;
  getSession: (input: {
    knowledgeBaseId: string;
    sessionId: string;
  }) => Promise<UploadSessionRecord | null>;
  addManifestEntries: (input: {
    knowledgeBaseId: string;
    sessionId: string;
    entries: UploadManifestEntryInput[];
  }) => Promise<UploadSessionRecord>;
  sealManifest: (input: {
    knowledgeBaseId: string;
    sessionId: string;
    manifestFingerprint: string;
  }) => Promise<UploadSessionRecord>;
  getEntry: (input: {
    knowledgeBaseId: string;
    sessionId: string;
    entryId: string;
  }) => Promise<UploadSessionEntryRecord | null>;
  markEntryUploaded: (input: {
    knowledgeBaseId: string;
    sessionId: string;
    entryId: string;
    stagingObjectKey: string;
    receivedSize: number;
    receivedChecksumSha256: string;
  }) => Promise<UploadSessionEntryRecord>;
  markEntryFailed: (input: {
    knowledgeBaseId: string;
    sessionId: string;
    entryId: string;
    errorCode: string;
  }) => Promise<void>;
  listEntries: (input: {
    knowledgeBaseId: string;
    sessionId: string;
    transferState?: "missing" | "failed" | "uploaded";
    limit: number;
    cursor: string | null;
  }) => Promise<UploadSessionPage<UploadSessionEntryRecord>>;
  reconcileReservations: (input: {
    knowledgeBaseId: string;
    sessionId: string;
  }) => Promise<UploadSessionRecord>;
  finalizeSession: (input: {
    knowledgeBaseId: string;
    sessionId: string;
    now: string;
  }) => Promise<UploadSessionRecord>;
  finalizeEntryBatch: (input: {
    knowledgeBaseId: string;
    sessionId: string;
    now: string;
    runAfter: string;
    limit: number;
    jobMaxAttempts: number;
  }) => Promise<{
    session: UploadSessionRecord;
    processedCount: number;
    completed: boolean;
    cancelled: boolean;
  }>;
  failFinalization: (input: {
    knowledgeBaseId: string;
    sessionId: string;
    errorCode: string;
    now: string;
  }) => Promise<UploadSessionRecord>;
  completeSession: (input: {
    knowledgeBaseId: string;
    sessionId: string;
    now: string;
  }) => Promise<UploadSessionRecord>;
  cancelSession: (input: {
    knowledgeBaseId: string;
    sessionId: string;
    now: string;
  }) => Promise<{ session: UploadSessionRecord; stagingObjectKeys: string[] }>;
  expireSessions: (input: {
    now: string;
    limit: number;
  }) => Promise<Array<{ sessionId: string; stagingObjectKeys: string[] }>>;
};
