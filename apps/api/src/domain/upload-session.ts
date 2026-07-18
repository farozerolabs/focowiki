import type { SourceRelativePath } from "./source-path.js";

export type UploadSessionState =
  | "draft"
  | "manifest_building"
  | "manifest_sealed"
  | "uploading"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export type UploadEntryDisposition =
  | "pending"
  | "upload_required"
  | "skipped_existing"
  | "waiting_reservation"
  | "rejected_deleting";

export type UploadEntryTransferState =
  | "pending"
  | "missing"
  | "uploading"
  | "uploaded"
  | "failed"
  | "skipped";

export type UploadSessionCounts = {
  selected: number;
  uploadRequired: number;
  skippedExisting: number;
  waitingReservation: number;
  rejectedDeleting: number;
  uploaded: number;
  failed: number;
  finalized: number;
};

export type UploadSessionRecord = {
  id: string;
  knowledgeBaseId: string;
  state: UploadSessionState;
  idempotencyKey: string;
  manifestFingerprint: string | null;
  declaredFileCount: number;
  declaredByteCount: number;
  counts: UploadSessionCounts;
  errorCode: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type UploadManifestEntryInput = {
  id: string;
  sourceFileId: string;
  path: SourceRelativePath;
  declaredSize: number;
  checksumSha256: string | null;
};

export type UploadSessionEntryRecord = {
  id: string;
  sessionId: string;
  relativePath: string;
  pathKey: string;
  directoryPath: string;
  name: string;
  declaredSize: number;
  receivedSize: number | null;
  checksumSha256: string | null;
  receivedChecksumSha256: string | null;
  disposition: UploadEntryDisposition;
  transferState: UploadEntryTransferState;
  stagingObjectKey: string | null;
  sourceDirectoryId: string | null;
  sourceFileId: string | null;
  existingResourceRevision: number | null;
  generatedPath: string;
  errorCode: string | null;
};

export type UploadSessionErrorCode =
  | "UPLOAD_SESSION_NOT_FOUND"
  | "UPLOAD_SESSION_STATE_CONFLICT"
  | "UPLOAD_SESSION_EXPIRED"
  | "UPLOAD_IDEMPOTENCY_CONFLICT"
  | "UPLOAD_MANIFEST_DUPLICATE_PATH"
  | "UPLOAD_MANIFEST_TOTAL_MISMATCH"
  | "UPLOAD_ENTRY_NOT_FOUND"
  | "UPLOAD_ENTRY_NOT_REQUIRED"
  | "UPLOAD_ENTRY_SIZE_MISMATCH"
  | "UPLOAD_ENTRY_CHECKSUM_MISMATCH"
  | "UPLOAD_ENTRY_STORAGE_FAILED"
  | "UPLOAD_SESSION_INCOMPLETE";

export class UploadSessionError extends Error {
  public readonly code: UploadSessionErrorCode;

  public constructor(code: UploadSessionErrorCode) {
    super(code);
    this.name = "UploadSessionError";
    this.code = code;
  }
}

export function assertUploadSessionMutable(session: UploadSessionRecord): void {
  if (Date.parse(session.expiresAt) <= Date.now()) {
    throw new UploadSessionError("UPLOAD_SESSION_EXPIRED");
  }
  if (session.state !== "draft" && session.state !== "manifest_building") {
    throw new UploadSessionError("UPLOAD_SESSION_STATE_CONFLICT");
  }
}

export function emptyUploadSessionCounts(): UploadSessionCounts {
  return {
    selected: 0,
    uploadRequired: 0,
    skippedExisting: 0,
    waitingReservation: 0,
    rejectedDeleting: 0,
    uploaded: 0,
    failed: 0,
    finalized: 0
  };
}
