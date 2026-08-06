import type {
  StorageVnextKnowledgeBaseId,
  StorageVnextPublicId,
  StorageVnextTimestamp
} from "../shared/types.js";

export const STORAGE_VNEXT_MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";

export type StorageVnextUploadManifestEntry = {
  entryPublicId: StorageVnextPublicId;
  sourceFilePublicId: StorageVnextPublicId;
  logicalPath: string;
  normalizedPath: string;
  byteCount: number;
  checksumSha256: string;
  contentType: typeof STORAGE_VNEXT_MARKDOWN_CONTENT_TYPE;
};

export type StorageVnextUploadEntry = StorageVnextUploadManifestEntry & {
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  sessionPublicId: StorageVnextPublicId;
  objectId: string | null;
};

export type StorageVnextUploadSessionReference = {
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  operationPublicId: StorageVnextPublicId;
  sessionPublicId: StorageVnextPublicId;
  temporaryObjectIds: readonly string[];
};

export type StorageVnextUploadFinalization = {
  outcome: "accepted" | "replayed";
  acceptedRevisionCount: number;
  sourceWorkCount: number;
  downstreamProcessingState: "queued";
  session: StorageVnextUploadSessionReference;
};

export type StorageVnextUploadRepository = {
  openSession(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    operationPublicId: StorageVnextPublicId;
    sessionPublicId: StorageVnextPublicId;
    idempotencyKey: string;
    requestHash: string;
    settingsRevisionPublicId: StorageVnextPublicId;
    manifestFingerprint: string;
    entries: readonly StorageVnextUploadManifestEntry[];
    createdAt: StorageVnextTimestamp;
    expiresAt: StorageVnextTimestamp;
  }): Promise<{ outcome: "opened" | "replayed"; sessionPublicId: string }>;
  getEntry(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    sessionPublicId: StorageVnextPublicId;
    entryPublicId: StorageVnextPublicId;
  }): Promise<StorageVnextUploadEntry | null>;
  markEntryUploaded(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    sessionPublicId: StorageVnextPublicId;
    entryPublicId: StorageVnextPublicId;
    objectId: string;
    checksumSha256: string;
    byteCount: number;
    contentType: string;
  }): Promise<StorageVnextUploadEntry>;
  finalizeSession(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    sessionPublicId: StorageVnextPublicId;
    completedAt: StorageVnextTimestamp;
  }): Promise<StorageVnextUploadFinalization>;
  terminateSession(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    sessionPublicId: StorageVnextPublicId;
    reasonCode: string;
    terminatedAt: StorageVnextTimestamp;
  }): Promise<StorageVnextUploadSessionReference>;
  listExpiredSessions(input: {
    expiredBefore: StorageVnextTimestamp;
    limit: number;
  }): Promise<readonly StorageVnextUploadSessionReference[]>;
  listKnowledgeBaseSessions(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    limit: number;
  }): Promise<readonly StorageVnextUploadSessionReference[]>;
};

export type StorageVnextUploadBodyWriter = {
  putVerifiedStream(input: {
    body: AsyncIterable<Uint8Array>;
    checksumSha256: string;
    byteCount: number;
    contentType: typeof STORAGE_VNEXT_MARKDOWN_CONTENT_TYPE;
    writeAttemptPublicId: StorageVnextPublicId;
    signal?: AbortSignal;
  }): Promise<{
    outcome: "stored" | "reused";
    objectId: string;
    checksumSha256: string;
    byteCount: number;
    contentType: string;
  }>;
};

export type StorageVnextUploadTerminalPort = {
  converge(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    operationPublicId: StorageVnextPublicId;
    sessionPublicId: StorageVnextPublicId;
    outcome: "completed" | "failed" | "cancelled" | "superseded" | "timed_out" | "deleted";
    resultCode: string;
    completedAt: StorageVnextTimestamp;
    temporaryObjectIds: readonly string[];
    successorOperationPublicId: StorageVnextPublicId | null;
  }): Promise<{ status: "completed" | "blocked" | "retry" }>;
};
