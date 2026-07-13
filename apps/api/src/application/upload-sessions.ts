import { createHash } from "node:crypto";
import {
  assertUploadSessionMutable,
  UploadSessionError,
  type UploadSessionEntryRecord,
  type UploadSessionRecord
} from "../domain/upload-session.js";
import { normalizeSourceRelativePath } from "../domain/source-path.js";
import type { ApplicationRuntime } from "./ports/runtime.js";
import type {
  UploadSessionFinalizationPort,
  UploadSessionStoragePort
} from "./ports/upload-session-storage.js";
import type { UploadSessionRepository } from "./ports/upload-session-repository.js";

export type UploadManifestEntryDraft = {
  relativePath: string;
  declaredSize: number;
  checksumSha256: string;
};

export type UploadSessionService = ReturnType<typeof createUploadSessionService>;

export function createUploadSessionService(input: {
  repository: UploadSessionRepository;
  storage: UploadSessionStoragePort;
  finalization: UploadSessionFinalizationPort;
  runtime: ApplicationRuntime;
  sessionTtlSeconds: number;
  maxFileBytes: number;
}) {
  return {
    createSession: async (request: {
      knowledgeBaseId: string;
      idempotencyKey: string;
      declaredFileCount: number;
      declaredByteCount: number;
    }): Promise<UploadSessionRecord> => {
      validateSessionTotals(request.declaredFileCount, request.declaredByteCount);
      const now = input.runtime.clock.now();
      return input.repository.createSession({
        id: input.runtime.ids.create("upload-session"),
        knowledgeBaseId: request.knowledgeBaseId,
        idempotencyKey: request.idempotencyKey,
        declaredFileCount: request.declaredFileCount,
        declaredByteCount: request.declaredByteCount,
        expiresAt: new Date(now.getTime() + input.sessionTtlSeconds * 1_000).toISOString()
      });
    },

    addManifestEntries: async (request: {
      knowledgeBaseId: string;
      sessionId: string;
      entries: UploadManifestEntryDraft[];
    }): Promise<UploadSessionRecord> => {
      const session = await requireSession(input.repository, request);
      assertUploadSessionMutable(session);
      const entries = request.entries.map((entry) => ({
        id: input.runtime.ids.create("upload-entry"),
        sourceFileId: input.runtime.ids.create("source-file"),
        path: normalizeSourceRelativePath(entry.relativePath),
        declaredSize: validateSize(entry.declaredSize, input.maxFileBytes),
        checksumSha256: validateChecksum(entry.checksumSha256)
      }));
      const keys = new Set<string>();
      for (const entry of entries) {
        if (keys.has(entry.path.pathKey)) {
          throw new UploadSessionError("UPLOAD_MANIFEST_DUPLICATE_PATH");
        }
        keys.add(entry.path.pathKey);
      }
      return input.repository.addManifestEntries({ ...request, entries });
    },

    sealManifest: async (request: {
      knowledgeBaseId: string;
      sessionId: string;
    }): Promise<UploadSessionRecord> => {
      const session = await requireSession(input.repository, request);
      assertUploadSessionMutable(session);
      return input.repository.sealManifest({
        ...request,
        manifestFingerprint: createManifestFingerprint(session)
      });
    },

    putEntryContent: async (request: {
      knowledgeBaseId: string;
      sessionId: string;
      entryId: string;
      bytes: Uint8Array;
    }): Promise<UploadSessionEntryRecord> => {
      const entry = await input.repository.getEntry(request);
      if (!entry) {
        throw new UploadSessionError("UPLOAD_ENTRY_NOT_FOUND");
      }
      if (entry.disposition !== "upload_required") {
        throw new UploadSessionError("UPLOAD_ENTRY_NOT_REQUIRED");
      }
      if (request.bytes.byteLength > input.maxFileBytes) {
        throw new UploadSessionError("UPLOAD_FILE_TOO_LARGE");
      }
      if (entry.declaredSize !== request.bytes.byteLength) {
        throw new UploadSessionError("UPLOAD_ENTRY_SIZE_MISMATCH");
      }
      const checksum = sha256(request.bytes);
      if (entry.checksumSha256 !== checksum) {
        throw new UploadSessionError("UPLOAD_ENTRY_CHECKSUM_MISMATCH");
      }
      const stored = await input.storage.putEntry({
        knowledgeBaseId: request.knowledgeBaseId,
        sessionId: request.sessionId,
        entryId: request.entryId,
        bytes: request.bytes
      });
      try {
        return await input.repository.markEntryUploaded({
          ...request,
          stagingObjectKey: stored.objectKey,
          receivedSize: request.bytes.byteLength,
          receivedChecksumSha256: checksum
        });
      } catch (error) {
        await input.storage.deleteObject(stored.objectKey).catch(() => undefined);
        throw error;
      }
    },

    getSession: (request: { knowledgeBaseId: string; sessionId: string }) =>
      requireSession(input.repository, request),

    listEntries: input.repository.listEntries,

    reconcileReservations: input.repository.reconcileReservations,

    finalizeSession: async (request: {
      knowledgeBaseId: string;
      sessionId: string;
    }): Promise<UploadSessionRecord> => {
      const now = input.runtime.clock.now().toISOString();
      const session = await input.repository.finalizeSession({ ...request, now });
      if (session.counts.uploadRequired === 0) {
        return input.repository.completeSession({
          ...request,
          now: input.runtime.clock.now().toISOString()
        });
      }
      await input.finalization.enqueue({
        knowledgeBaseId: request.knowledgeBaseId,
        sessionId: request.sessionId
      });
      return session;
    },

    cancelSession: async (request: {
      knowledgeBaseId: string;
      sessionId: string;
    }): Promise<UploadSessionRecord> => {
      const result = await input.repository.cancelSession({
        ...request,
        now: input.runtime.clock.now().toISOString()
      });
      await input.storage.deleteObjects(result.stagingObjectKeys);
      return result.session;
    }
  };
}

async function requireSession(
  repository: UploadSessionRepository,
  request: { knowledgeBaseId: string; sessionId: string }
): Promise<UploadSessionRecord> {
  const session = await repository.getSession(request);
  if (!session) {
    throw new UploadSessionError("UPLOAD_SESSION_NOT_FOUND");
  }
  return session;
}

function validateSessionTotals(fileCount: number, byteCount: number): void {
  if (!Number.isSafeInteger(fileCount) || fileCount < 0) {
    throw new UploadSessionError("UPLOAD_MANIFEST_TOTAL_MISMATCH");
  }
  if (!Number.isSafeInteger(byteCount) || byteCount < 0) {
    throw new UploadSessionError("UPLOAD_MANIFEST_TOTAL_MISMATCH");
  }
}

function validateSize(size: number, maxFileBytes: number): number {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new UploadSessionError("UPLOAD_MANIFEST_TOTAL_MISMATCH");
  }
  if (size > maxFileBytes) {
    throw new UploadSessionError("UPLOAD_FILE_TOO_LARGE");
  }
  return size;
}

function validateChecksum(checksum: string): string {
  if (!/^[a-f0-9]{64}$/u.test(checksum)) {
    throw new UploadSessionError("UPLOAD_MANIFEST_TOTAL_MISMATCH");
  }
  return checksum;
}

function createManifestFingerprint(session: UploadSessionRecord): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        knowledgeBaseId: session.knowledgeBaseId,
        selected: session.counts.selected,
        declaredFileCount: session.declaredFileCount,
        declaredByteCount: session.declaredByteCount
      })
    )
    .digest("hex");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
