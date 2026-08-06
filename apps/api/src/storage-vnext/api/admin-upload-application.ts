import type {
  UploadSessionEntryRecord,
  UploadSessionRecord
} from "../../domain/upload-session.js";

export class StorageVnextAdminUploadApplicationError extends Error {
  constructor(readonly code: "SERVICE_UNAVAILABLE" | "NOT_FOUND") {
    super(code);
    this.name = "StorageVnextAdminUploadApplicationError";
  }
}

type EntryPage = {
  items: UploadSessionEntryRecord[];
  nextCursor: string | null;
};

export type StorageVnextAdminUploadApplication = {
  createUploadSession(request: {
    knowledgeBaseId: string;
    idempotencyKey: string;
    declaredFileCount: number;
    declaredByteCount: number;
  }): Promise<UploadSessionRecord>;
  addUploadEntries(request: {
    knowledgeBaseId: string;
    sessionId: string;
    entries: Array<{
      relativePath: string;
      declaredSize: number;
      checksumSha256: string | null;
    }>;
  }): Promise<UploadSessionRecord>;
  sealUploadSession(request: {
    knowledgeBaseId: string;
    sessionId: string;
  }): Promise<{ session: UploadSessionRecord; entries: EntryPage }>;
  writeUploadContent(request: {
    knowledgeBaseId: string;
    sessionId: string;
    entryId: string;
    body: ReadableStream<Uint8Array>;
  }): Promise<UploadSessionEntryRecord>;
  getUploadSession(request: {
    knowledgeBaseId: string;
    sessionId: string;
    transferState?: "missing" | "failed" | "uploaded";
    limit: number;
    cursor: string | null;
  }): Promise<{ session: UploadSessionRecord; entries: EntryPage }>;
  reconcileUploadSession(request: {
    knowledgeBaseId: string;
    sessionId: string;
  }): Promise<UploadSessionRecord>;
  finalizeUploadSession(request: {
    knowledgeBaseId: string;
    sessionId: string;
  }): Promise<UploadSessionRecord>;
  cancelUploadSession(request: {
    knowledgeBaseId: string;
    sessionId: string;
  }): Promise<UploadSessionRecord>;
};

export function createStorageVnextAdminUploadApplication(input: {
  backend: StorageVnextAdminUploadApplication | null;
}): StorageVnextAdminUploadApplication {
  if (input.backend) return input.backend;
  const unavailable = async (): Promise<never> => {
    throw new StorageVnextAdminUploadApplicationError("SERVICE_UNAVAILABLE");
  };
  return {
    createUploadSession: unavailable,
    addUploadEntries: unavailable,
    sealUploadSession: unavailable,
    writeUploadContent: unavailable,
    getUploadSession: unavailable,
    reconcileUploadSession: unavailable,
    finalizeUploadSession: unavailable,
    cancelUploadSession: unavailable
  };
}
