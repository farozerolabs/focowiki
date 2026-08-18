import { createHash } from "node:crypto";
import { normalizeStorageVnextUploadManifest } from "./manifest.js";
import type {
  StorageVnextUploadBodyWriter,
  StorageVnextUploadRepository,
  StorageVnextUploadSessionReference,
  StorageVnextUploadTerminalPort
} from "./ports.js";

export type StorageVnextUploadCoordinator = ReturnType<
  typeof createStorageVnextUploadCoordinator
>;

export function createStorageVnextUploadSessionMaintenance(input: {
  repository: StorageVnextUploadRepository;
  terminal: StorageVnextUploadTerminalPort;
}) {
  return {
    async expireSessions(request: {
      expiredBefore: string;
      limit: number;
    }): Promise<number> {
      assertPageLimit(request.limit);
      const sessions = await input.repository.listExpiredSessions(request);
      const failures: unknown[] = [];
      for (const session of sessions) {
        try {
          await terminateKnownSession(input, session, {
            outcome: "timed_out",
            resultCode: "UPLOAD_EXPIRED",
            completedAt: request.expiredBefore,
            relatedOperationPublicId: null
          });
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "Storage vNext expired upload session convergence failed"
        );
      }
      return sessions.length;
    }
  };
}

export function createStorageVnextUploadCoordinator(input: {
  repository: StorageVnextUploadRepository;
  bodyWriter: StorageVnextUploadBodyWriter;
  terminal: StorageVnextUploadTerminalPort;
  limits: { maximumEntries: number; maximumManifestBytes: number };
}) {
  const sessionMaintenance = createStorageVnextUploadSessionMaintenance(input);
  return {
    async openSession(request: {
      knowledgeBaseId: string;
      operationPublicId: string;
      sessionPublicId: string;
      idempotencyKey: string;
      settingsRevisionPublicId: string;
      entries: ReadonlyArray<{
        entryPublicId: string;
        sourceFilePublicId: string;
        logicalPath: string;
        byteCount: number;
        checksumSha256: string;
        contentType: string;
      }>;
      createdAt: string;
      expiresAt: string;
    }) {
      const manifest = normalizeStorageVnextUploadManifest({
        knowledgeBaseId: request.knowledgeBaseId,
        settingsRevisionPublicId: request.settingsRevisionPublicId,
        entries: request.entries,
        ...input.limits
      });
      return input.repository.openSession({
        ...request,
        entries: manifest.entries,
        manifestFingerprint: manifest.manifestFingerprint,
        requestHash: manifest.requestHash
      });
    },

    async putEntry(request: {
      knowledgeBaseId: string;
      sessionPublicId: string;
      entryPublicId: string;
      body: AsyncIterable<Uint8Array>;
      signal?: AbortSignal;
    }) {
      const entry = await input.repository.getEntry(request);
      if (!entry) throw uploadError("entry_missing");
      if (entry.objectId) return { outcome: "reused" as const, objectId: entry.objectId };
      if (request.signal?.aborted) {
        const reason = abortReason(request.signal);
        await terminateAfterFailure(input, {
          entry,
          outcome: "cancelled",
          resultCode: "UPLOAD_CLIENT_DISCONNECTED",
          terminatedAt: new Date().toISOString(),
          temporaryObjectIds: []
        }, reason);
      }

      let writtenObjectId: string | null = null;
      try {
        const stored = await input.bodyWriter.putVerifiedStream({
          body: request.body,
          checksumSha256: entry.checksumSha256,
          byteCount: entry.byteCount,
          contentType: entry.contentType,
          writeAttemptPublicId: uploadWriteAttemptPublicId(entry),
          ...(request.signal ? { signal: request.signal } : {})
        });
        writtenObjectId = stored.objectId;
        assertStoredBody(entry, stored);
        const marked = await input.repository.markEntryUploaded({
          ...request,
          objectId: stored.objectId,
          checksumSha256: stored.checksumSha256,
          byteCount: stored.byteCount,
          contentType: stored.contentType
        });
        return { outcome: stored.outcome, objectId: marked.objectId! };
      } catch (error) {
        const exit = uploadFailureExit(error);
        await terminateAfterFailure(input, {
          entry,
          ...exit,
          terminatedAt: new Date().toISOString(),
          temporaryObjectIds: writtenObjectId ? [writtenObjectId] : []
        }, error);
      }
    },

    async finalizeSession(request: {
      knowledgeBaseId: string;
      sessionPublicId: string;
      completedAt: string;
    }) {
      const finalized = await input.repository.finalizeSession(request).catch((error: unknown) =>
        terminateSessionAfterFailure(input, {
          ...request,
          ...finalizationFailureExit(error)
        }, error));
      await converge(input.terminal, {
        ...finalized.session,
        temporaryObjectIds: [],
        outcome: "accepted",
        resultCode: "UPLOAD_ACCEPTED",
        completedAt: request.completedAt,
        relatedOperationPublicId: null
      });
      return {
        outcome: finalized.outcome,
        acceptedRevisionCount: finalized.acceptedRevisionCount,
        sourceWorkCount: finalized.sourceWorkCount,
        downstreamProcessingState: finalized.downstreamProcessingState
      };
    },

    async cancelSession(request: {
      knowledgeBaseId: string;
      sessionPublicId: string;
      cancelledAt: string;
    }): Promise<void> {
      const session = await input.repository.terminateSession({
        knowledgeBaseId: request.knowledgeBaseId,
        sessionPublicId: request.sessionPublicId,
        reasonCode: "UPLOAD_CANCELLED",
        terminatedAt: request.cancelledAt
      });
      await converge(input.terminal, {
        ...session,
        outcome: "cancelled",
        resultCode: "UPLOAD_CANCELLED",
        completedAt: request.cancelledAt,
        relatedOperationPublicId: null
      });
    },

    async supersedeSession(request: {
      knowledgeBaseId: string;
      sessionPublicId: string;
      relatedOperationPublicId: string;
      supersededAt: string;
    }): Promise<void> {
      const session = await input.repository.terminateSession({
        knowledgeBaseId: request.knowledgeBaseId,
        sessionPublicId: request.sessionPublicId,
        reasonCode: "UPLOAD_SUPERSEDED",
        terminatedAt: request.supersededAt
      });
      await converge(input.terminal, {
        ...session,
        outcome: "superseded",
        resultCode: "UPLOAD_SUPERSEDED",
        completedAt: request.supersededAt,
        relatedOperationPublicId: request.relatedOperationPublicId
      });
    },

    expireSessions: sessionMaintenance.expireSessions,

    async cancelKnowledgeBaseSessions(request: {
      knowledgeBaseId: string;
      deletionOperationPublicId: string;
      deletedAt: string;
      limit: number;
    }): Promise<number> {
      assertPageLimit(request.limit);
      const sessions = await input.repository.listKnowledgeBaseSessions({
        knowledgeBaseId: request.knowledgeBaseId,
        limit: request.limit
      });
      for (const session of sessions) {
        await terminateKnownSession(input, session, {
          outcome: "deleted",
          resultCode: "KNOWLEDGE_BASE_DELETED",
          completedAt: request.deletedAt,
          relatedOperationPublicId: request.deletionOperationPublicId
        });
      }
      return sessions.length;
    }
  };
}

async function terminateKnownSession(
  input: {
    repository: StorageVnextUploadRepository;
    terminal: StorageVnextUploadTerminalPort;
  },
  session: StorageVnextUploadSessionReference,
  exit: {
    outcome: "timed_out" | "deleted";
    resultCode: string;
    completedAt: string;
    relatedOperationPublicId: string | null;
  }
): Promise<void> {
  const current = await input.repository.terminateSession({
    knowledgeBaseId: session.knowledgeBaseId,
    sessionPublicId: session.sessionPublicId,
    reasonCode: exit.resultCode,
    terminatedAt: exit.completedAt
  });
  await converge(input.terminal, { ...current, ...exit });
}

async function terminateAfterFailure(
  input: {
    repository: StorageVnextUploadRepository;
    terminal: StorageVnextUploadTerminalPort;
  },
  request: {
    entry: { knowledgeBaseId: string; sessionPublicId: string };
    outcome: "failed" | "cancelled" | "timed_out";
    resultCode: string;
    terminatedAt: string;
    temporaryObjectIds: readonly string[];
  },
  originalError: unknown
): Promise<never> {
  try {
    const session = await input.repository.terminateSession({
      knowledgeBaseId: request.entry.knowledgeBaseId,
      sessionPublicId: request.entry.sessionPublicId,
      reasonCode: request.resultCode,
      terminatedAt: request.terminatedAt
    });
    await converge(input.terminal, {
      ...session,
      temporaryObjectIds: [
        ...new Set([...session.temporaryObjectIds, ...request.temporaryObjectIds])
      ],
      outcome: request.outcome,
      resultCode: request.resultCode,
      completedAt: request.terminatedAt,
      relatedOperationPublicId: null
    });
  } catch (cleanupError) {
    throw new AggregateError(
      [originalError, cleanupError],
      "Storage vNext upload and terminal cleanup both failed"
    );
  }
  throw originalError;
}

async function terminateSessionAfterFailure(
  input: {
    repository: StorageVnextUploadRepository;
    terminal: StorageVnextUploadTerminalPort;
  },
  request: {
    knowledgeBaseId: string;
    sessionPublicId: string;
    completedAt: string;
    outcome: "failed";
    resultCode: string;
  },
  originalError: unknown
): Promise<never> {
  try {
    const session = await input.repository.terminateSession({
      knowledgeBaseId: request.knowledgeBaseId,
      sessionPublicId: request.sessionPublicId,
      reasonCode: request.resultCode,
      terminatedAt: request.completedAt
    });
    await converge(input.terminal, {
      ...session,
      outcome: request.outcome,
      resultCode: request.resultCode,
      completedAt: request.completedAt,
      relatedOperationPublicId: null
    });
  } catch (cleanupError) {
    throw new AggregateError(
      [originalError, cleanupError],
      "Storage vNext upload finalization and terminal cleanup both failed"
    );
  }
  throw originalError;
}

function converge(
  terminal: StorageVnextUploadTerminalPort,
  input: Parameters<StorageVnextUploadTerminalPort["converge"]>[0]
): Promise<{ status: "completed" | "blocked" | "retry" }> {
  return terminal.converge(input);
}

function uploadFailureExit(error: unknown): {
  outcome: "failed" | "cancelled" | "timed_out";
  resultCode: string;
} {
  if (error instanceof Error && error.name === "TimeoutError") {
    return { outcome: "timed_out", resultCode: "UPLOAD_TIMED_OUT" };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { outcome: "cancelled", resultCode: "UPLOAD_CLIENT_DISCONNECTED" };
  }
  return { outcome: "failed", resultCode: "UPLOAD_ENTRY_FAILED" };
}

function finalizationFailureExit(error: unknown): {
  outcome: "failed";
  resultCode: string;
} {
  return {
    outcome: "failed",
    resultCode: errorCode(error) === "path_conflict"
      ? "UPLOAD_FINALIZATION_CONFLICT"
      : "UPLOAD_FINALIZATION_FAILED"
  };
}

function errorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

function assertStoredBody(
  entry: { checksumSha256: string; byteCount: number; contentType: string },
  stored: { checksumSha256: string; byteCount: number; contentType: string }
): void {
  if (
    stored.checksumSha256 !== entry.checksumSha256
    || stored.byteCount !== entry.byteCount
    || stored.contentType !== entry.contentType
  ) throw uploadError("object_verification_failed");
}

function uploadWriteAttemptPublicId(entry: {
  knowledgeBaseId: string;
  sessionPublicId: string;
  entryPublicId: string;
}): string {
  const digest = createHash("sha256")
    .update("storage-vnext-upload-write-v1\0")
    .update(entry.knowledgeBaseId)
    .update("\0")
    .update(entry.sessionPublicId)
    .update("\0")
    .update(entry.entryPublicId)
    .digest("hex");
  return `upload-write-${digest}`;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Upload aborted", "AbortError");
}

function assertPageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw uploadError("invalid_limit");
  }
}

function uploadError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Storage vNext upload error: ${code}`), { code });
}
