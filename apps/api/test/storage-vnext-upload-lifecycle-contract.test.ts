import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { mapUploadEntry } from
  "../src/storage-vnext/api/postgres-admin-upload-session-store.js";

type ManifestEntry = {
  entryPublicId: string;
  sourceFilePublicId: string;
  logicalPath: string;
  byteCount: number;
  checksumSha256: string;
  contentType: string;
};

type SessionReference = {
  knowledgeBaseId: string;
  operationPublicId: string;
  sessionPublicId: string;
  temporaryObjectIds: readonly string[];
};

type UploadCoordinator = {
  openSession(input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    sessionPublicId: string;
    idempotencyKey: string;
    settingsRevisionPublicId: string;
    entries: readonly ManifestEntry[];
    createdAt: string;
    expiresAt: string;
  }): Promise<{ outcome: "opened" | "replayed"; sessionPublicId: string }>;
  putEntry(input: {
    knowledgeBaseId: string;
    sessionPublicId: string;
    entryPublicId: string;
    body: AsyncIterable<Uint8Array>;
    signal?: AbortSignal;
  }): Promise<{ outcome: "stored" | "reused"; objectId: string }>;
  finalizeSession(input: {
    knowledgeBaseId: string;
    sessionPublicId: string;
    completedAt: string;
  }): Promise<{
    outcome: "accepted" | "replayed";
    acceptedRevisionCount: number;
    sourceWorkCount: number;
    downstreamProcessingState: "queued";
  }>;
  cancelSession(input: {
    knowledgeBaseId: string;
    sessionPublicId: string;
    cancelledAt: string;
  }): Promise<void>;
  supersedeSession(input: {
    knowledgeBaseId: string;
    sessionPublicId: string;
    successorOperationPublicId: string;
    supersededAt: string;
  }): Promise<void>;
  expireSessions(input: {
    expiredBefore: string;
    limit: number;
  }): Promise<number>;
  cancelKnowledgeBaseSessions(input: {
    knowledgeBaseId: string;
    deletionOperationPublicId: string;
    deletedAt: string;
    limit: number;
  }): Promise<number>;
};

type UploadCoordinatorFactory = (input: {
  repository: ReturnType<typeof createFixture>["repository"];
  bodyWriter: ReturnType<typeof createFixture>["bodyWriter"];
  terminal: ReturnType<typeof createFixture>["terminal"];
  limits: { maximumEntries: number; maximumManifestBytes: number };
}) => UploadCoordinator;

let factory: UploadCoordinatorFactory | undefined;

beforeAll(async () => {
  const modulePath = resolve(
    import.meta.dirname,
    "../src/storage-vnext/upload/upload-coordinator.ts"
  );
  const loaded = await import(/* @vite-ignore */ pathToFileURL(modulePath).href)
    .catch(() => ({})) as { createStorageVnextUploadCoordinator?: UploadCoordinatorFactory };
  factory = loaded.createStorageVnextUploadCoordinator;
});

describe("storage vNext upload lifecycle contract", () => {
  it("preserves the released skipped-existing entry contract", () => {
    expect(mapUploadEntry({
      upload_session_public_id: "upload-overlap",
      entry_public_id: "entry-overlap",
      source_file_public_id: "file-existing",
      logical_path: "Guides/Existing.md",
      normalized_path: "guides/existing.md",
      checksum_sha256: "a".repeat(64),
      byte_count: 128,
      object_id: "source-sha256:existing",
      state: "verified",
      existing_resource_revision: 3
    })).toMatchObject({
      disposition: "skipped_existing",
      transferState: "skipped",
      sourceFileId: "file-existing",
      existingResourceRevision: 3,
      receivedSize: null,
      receivedChecksumSha256: null
    });
  });

  it("accepts a complete upload without waiting for downstream processing", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);
    const entry = markdownEntry("entry-intro", "file-intro", "Guides/Intro.md", "# Intro\n");

    await expect(coordinator.openSession(sessionRequest([entry])))
      .resolves.toEqual({ outcome: "opened", sessionPublicId: "upload-contract" });
    await expect(coordinator.putEntry(putRequest(entry, "# Intro\n")))
      .resolves.toMatchObject({ outcome: "stored" });
    await expect(coordinator.finalizeSession(finalizeRequest()))
      .resolves.toEqual({
        outcome: "accepted",
        acceptedRevisionCount: 1,
        sourceWorkCount: 1,
        downstreamProcessingState: "queued"
      });

    expect(fixture.repository.openSession).toHaveBeenCalledWith(expect.objectContaining({
      manifestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      entries: [expect.objectContaining({
        logicalPath: "Guides/Intro.md",
        normalizedPath: "guides/intro.md"
      })]
    }));
    expect(fixture.repository.finalizeSession).toHaveBeenCalledTimes(1);
    expect(fixture.terminal.converge).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "completed",
      resultCode: "UPLOAD_ACCEPTED"
    }));
  });

  it("cancels a partial session and converges its temporary ownership", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);
    const entry = markdownEntry("entry-partial", "file-partial", "Partial.md", "# Partial\n");
    await coordinator.openSession(sessionRequest([entry]));
    await coordinator.putEntry(putRequest(entry, "# Partial\n"));

    await coordinator.cancelSession({
      knowledgeBaseId: "kb-upload-contract",
      sessionPublicId: "upload-contract",
      cancelledAt: "2026-08-01T00:02:00.000Z"
    });

    expect(fixture.repository.terminateSession).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "UPLOAD_CANCELLED"
    }));
    expect(fixture.terminal.converge).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "cancelled",
      temporaryObjectIds: [`source-sha256:${entry.checksumSha256}`]
    }));
  });

  it("expires only a bounded page of live sessions", async () => {
    const fixture = createFixture();
    fixture.expired.push(
      sessionReference("upload-expired-one", "operation-expired-one"),
      sessionReference("upload-expired-two", "operation-expired-two")
    );
    const coordinator = createCoordinator(fixture);

    await expect(coordinator.expireSessions({
      expiredBefore: "2026-08-02T00:00:00.000Z",
      limit: 2
    })).resolves.toBe(2);
    expect(fixture.repository.listExpiredSessions).toHaveBeenCalledWith({
      expiredBefore: "2026-08-02T00:00:00.000Z",
      limit: 2
    });
    expect(fixture.terminal.converge).toHaveBeenCalledTimes(2);
    expect(fixture.terminal.converge).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "timed_out",
      resultCode: "UPLOAD_EXPIRED"
    }));
  });

  it("rejects unsupported files before creating durable state", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);
    const entry = {
      ...markdownEntry("entry-pdf", "file-pdf", "Manual.pdf", "pdf"),
      contentType: "application/pdf"
    };

    await expect(coordinator.openSession(sessionRequest([entry])))
      .rejects.toMatchObject({ code: "unsupported_file" });
    expect(fixture.repository.openSession).not.toHaveBeenCalled();
  });

  it("rejects malformed or traversing paths before creating durable state", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);
    const entry = markdownEntry("entry-path", "file-path", "../escape.md", "# Escape\n");

    await expect(coordinator.openSession(sessionRequest([entry])))
      .rejects.toMatchObject({ code: "malformed_path" });
    expect(fixture.repository.openSession).not.toHaveBeenCalled();
  });

  it("rejects duplicate normalized manifest paths", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);
    const entries = [
      markdownEntry("entry-left", "file-left", "Guides/Intro.md", "# Left\n"),
      markdownEntry("entry-right", "file-right", "guides/intro.md", "# Right\n")
    ];

    await expect(coordinator.openSession(sessionRequest(entries)))
      .rejects.toMatchObject({ code: "duplicate_path" });
    expect(fixture.repository.openSession).not.toHaveBeenCalled();
  });

  it("reuses an identical uploaded entry without another object write", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);
    const entry = markdownEntry("entry-replay", "file-replay", "Replay.md", "# Replay\n");
    await coordinator.openSession(sessionRequest([entry]));

    const first = await coordinator.putEntry(putRequest(entry, "# Replay\n"));
    const replay = await coordinator.putEntry(putRequest(entry, "# Replay\n"));

    expect(first).toMatchObject({ outcome: "stored" });
    expect(replay).toEqual({
      outcome: "reused",
      objectId: `source-sha256:${entry.checksumSha256}`
    });
    expect(fixture.bodyWriter.putVerifiedStream).toHaveBeenCalledTimes(1);
    expect(fixture.repository.markEntryUploaded).toHaveBeenCalledTimes(1);
  });

  it("propagates an idempotency or path conflict without writing a body", async () => {
    const fixture = createFixture();
    fixture.repository.openSession.mockRejectedValueOnce(errorWithCode("idempotency_conflict"));
    const coordinator = createCoordinator(fixture);
    const entry = markdownEntry("entry-conflict", "file-conflict", "Conflict.md", "# Conflict\n");

    await expect(coordinator.openSession(sessionRequest([entry])))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(fixture.bodyWriter.putVerifiedStream).not.toHaveBeenCalled();
    expect(fixture.terminal.converge).not.toHaveBeenCalled();
  });

  it("terminalizes a finalization conflict after releasing uploaded ownership", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);
    const entry = markdownEntry(
      "entry-finalize-conflict",
      "file-finalize-conflict",
      "FinalizeConflict.md",
      "# Finalize conflict\n"
    );
    await coordinator.openSession(sessionRequest([entry]));
    await coordinator.putEntry(putRequest(entry, "# Finalize conflict\n"));
    const conflict = errorWithCode("path_conflict");
    fixture.repository.finalizeSession.mockRejectedValueOnce(conflict);

    await expect(coordinator.finalizeSession(finalizeRequest())).rejects.toBe(conflict);
    expect(fixture.repository.terminateSession).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "UPLOAD_FINALIZATION_CONFLICT"
    }));
    expect(fixture.terminal.converge).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failed",
      resultCode: "UPLOAD_FINALIZATION_CONFLICT",
      temporaryObjectIds: [`source-sha256:${entry.checksumSha256}`]
    }));
  });

  it("supersedes one unfinalized session and preserves its successor identity", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);
    const entry = markdownEntry(
      "entry-superseded",
      "file-superseded",
      "Superseded.md",
      "# Superseded\n"
    );
    await coordinator.openSession(sessionRequest([entry]));
    await coordinator.putEntry(putRequest(entry, "# Superseded\n"));

    await coordinator.supersedeSession({
      knowledgeBaseId: "kb-upload-contract",
      sessionPublicId: "upload-contract",
      successorOperationPublicId: "operation-upload-successor",
      supersededAt: "2026-08-01T00:02:30.000Z"
    });

    expect(fixture.repository.terminateSession).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "UPLOAD_SUPERSEDED"
    }));
    expect(fixture.terminal.converge).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "superseded",
      resultCode: "UPLOAD_SUPERSEDED",
      successorOperationPublicId: "operation-upload-successor",
      temporaryObjectIds: [`source-sha256:${entry.checksumSha256}`]
    }));
  });

  it("terminalizes an upload timeout and schedules deterministic cleanup", async () => {
    const fixture = createFixture();
    const timeout = new Error("Upload timed out");
    timeout.name = "TimeoutError";
    fixture.bodyWriter.putVerifiedStream.mockRejectedValueOnce(timeout);
    const coordinator = createCoordinator(fixture);
    const entry = markdownEntry("entry-timeout", "file-timeout", "Timeout.md", "# Timeout\n");
    await coordinator.openSession(sessionRequest([entry]));

    await expect(coordinator.putEntry(putRequest(entry, "# Timeout\n")))
      .rejects.toBe(timeout);
    expect(fixture.repository.terminateSession).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "UPLOAD_TIMED_OUT"
    }));
    expect(fixture.terminal.converge).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "timed_out",
      resultCode: "UPLOAD_TIMED_OUT"
    }));
  });

  it("treats client disconnect as cancellation and closes the live session", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);
    const entry = markdownEntry("entry-disconnect", "file-disconnect", "Disconnect.md", "# Disconnect\n");
    await coordinator.openSession(sessionRequest([entry]));
    const controller = new AbortController();
    controller.abort(new DOMException("Client disconnected", "AbortError"));

    await expect(coordinator.putEntry({
      ...putRequest(entry, "# Disconnect\n"),
      signal: controller.signal
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.bodyWriter.putVerifiedStream).not.toHaveBeenCalled();
    expect(fixture.terminal.converge).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "cancelled",
      resultCode: "UPLOAD_CLIENT_DISCONNECTED"
    }));
  });

  it("lets knowledge-base deletion supersede every live upload directly", async () => {
    const fixture = createFixture();
    fixture.knowledgeBaseSessions.push(
      sessionReference("upload-delete-one", "operation-delete-one"),
      sessionReference("upload-delete-two", "operation-delete-two")
    );
    const coordinator = createCoordinator(fixture);

    await expect(coordinator.cancelKnowledgeBaseSessions({
      knowledgeBaseId: "kb-upload-contract",
      deletionOperationPublicId: "operation-delete-kb",
      deletedAt: "2026-08-01T00:03:00.000Z",
      limit: 10
    })).resolves.toBe(2);
    expect(fixture.repository.listKnowledgeBaseSessions).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-upload-contract",
      limit: 10
    });
    expect(fixture.repository.terminateSession).toHaveBeenCalledTimes(2);
    expect(fixture.terminal.converge).toHaveBeenCalledTimes(2);
    expect(fixture.terminal.converge).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "deleted",
      resultCode: "KNOWLEDGE_BASE_DELETED",
      successorOperationPublicId: "operation-delete-kb"
    }));
  });
});

function createCoordinator(fixture: ReturnType<typeof createFixture>): UploadCoordinator {
  expect(factory).toBeTypeOf("function");
  if (!factory) throw new Error("Storage vNext upload coordinator is unavailable");
  return factory({
    repository: fixture.repository,
    bodyWriter: fixture.bodyWriter,
    terminal: fixture.terminal,
    limits: { maximumEntries: 500, maximumManifestBytes: 1_048_576 }
  });
}

function createFixture() {
  const entries = new Map<string, {
    knowledgeBaseId: string;
    sessionPublicId: string;
    entryPublicId: string;
    sourceFilePublicId: string;
    logicalPath: string;
    normalizedPath: string;
    byteCount: number;
    checksumSha256: string;
    contentType: string;
    objectId: string | null;
  }>();
  const sessions = new Map<string, SessionReference>();
  const expired: SessionReference[] = [];
  const knowledgeBaseSessions: SessionReference[] = [];

  const repository = {
    openSession: vi.fn(async (input: {
      knowledgeBaseId: string;
      operationPublicId: string;
      sessionPublicId: string;
      entries: Array<ManifestEntry & { normalizedPath: string }>;
    }) => {
      sessions.set(input.sessionPublicId, sessionReference(
        input.sessionPublicId,
        input.operationPublicId
      ));
      for (const entry of input.entries) {
        entries.set(entry.entryPublicId, {
          knowledgeBaseId: input.knowledgeBaseId,
          sessionPublicId: input.sessionPublicId,
          ...entry,
          objectId: null
        });
      }
      return { outcome: "opened" as const, sessionPublicId: input.sessionPublicId };
    }),
    getEntry: vi.fn(async (input: {
      knowledgeBaseId: string;
      sessionPublicId: string;
      entryPublicId: string;
    }) => {
      const entry = entries.get(input.entryPublicId);
      return entry?.knowledgeBaseId === input.knowledgeBaseId
        && entry.sessionPublicId === input.sessionPublicId
        ? entry
        : null;
    }),
    markEntryUploaded: vi.fn(async (input: {
      entryPublicId: string;
      objectId: string;
    }) => {
      const entry = entries.get(input.entryPublicId);
      if (!entry) throw errorWithCode("entry_missing");
      entry.objectId = input.objectId;
      const session = sessions.get(entry.sessionPublicId);
      if (session) {
        sessions.set(entry.sessionPublicId, {
          ...session,
          temporaryObjectIds: [
            ...new Set([...session.temporaryObjectIds, input.objectId])
          ]
        });
      }
      return { ...entry, outcome: "stored" as const };
    }),
    finalizeSession: vi.fn(async (input: {
      sessionPublicId: string;
    }) => {
      const accepted = [...entries.values()].filter(
        (entry) => entry.sessionPublicId === input.sessionPublicId && entry.objectId
      );
      return {
        outcome: "accepted" as const,
        acceptedRevisionCount: accepted.length,
        sourceWorkCount: accepted.length,
        downstreamProcessingState: "queued" as const,
        session: sessions.get(input.sessionPublicId)
          ?? sessionReference(input.sessionPublicId, `operation-${input.sessionPublicId}`)
      };
    }),
    terminateSession: vi.fn(async (input: {
      sessionPublicId: string;
      reasonCode: string;
    }) => sessions.get(input.sessionPublicId)
      ?? sessionReference(input.sessionPublicId, `operation-${input.sessionPublicId}`)),
    listExpiredSessions: vi.fn(async (input: { limit: number }) =>
      expired.slice(0, input.limit)),
    listKnowledgeBaseSessions: vi.fn(async (input: {
      knowledgeBaseId: string;
      limit: number;
    }) => knowledgeBaseSessions
      .filter((session) => session.knowledgeBaseId === input.knowledgeBaseId)
      .slice(0, input.limit))
  };

  const bodyWriter = {
    putVerifiedStream: vi.fn(async (input: {
      body: AsyncIterable<Uint8Array>;
      checksumSha256: string;
      byteCount: number;
      contentType: string;
    }) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of input.body) chunks.push(chunk);
      const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      if (
        bytes.byteLength !== input.byteCount
        || createHash("sha256").update(bytes).digest("hex") !== input.checksumSha256
      ) throw errorWithCode("object_verification_failed");
      return {
        outcome: "stored" as const,
        objectId: `source-sha256:${input.checksumSha256}`,
        checksumSha256: input.checksumSha256,
        byteCount: input.byteCount,
        contentType: input.contentType
      };
    })
  };
  const terminal = {
    converge: vi.fn(async () => ({ status: "completed" as const }))
  };
  return {
    repository,
    bodyWriter,
    terminal,
    expired,
    knowledgeBaseSessions
  };
}

function sessionRequest(entries: readonly ManifestEntry[]) {
  return {
    knowledgeBaseId: "kb-upload-contract",
    operationPublicId: "operation-upload-contract",
    sessionPublicId: "upload-contract",
    idempotencyKey: "request-upload-contract",
    settingsRevisionPublicId: "settings-upload-contract",
    entries,
    createdAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-08-01T01:00:00.000Z"
  };
}

function finalizeRequest() {
  return {
    knowledgeBaseId: "kb-upload-contract",
    sessionPublicId: "upload-contract",
    completedAt: "2026-08-01T00:01:00.000Z"
  };
}

function putRequest(entry: ManifestEntry, body: string) {
  return {
    knowledgeBaseId: "kb-upload-contract",
    sessionPublicId: "upload-contract",
    entryPublicId: entry.entryPublicId,
    body: chunks(body)
  };
}

function markdownEntry(
  entryPublicId: string,
  sourceFilePublicId: string,
  logicalPath: string,
  body: string
): ManifestEntry {
  const bytes = Buffer.from(body, "utf8");
  return {
    entryPublicId,
    sourceFilePublicId,
    logicalPath,
    byteCount: bytes.byteLength,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
    contentType: "text/markdown; charset=utf-8"
  };
}

async function* chunks(body: string): AsyncGenerator<Uint8Array> {
  yield Buffer.from(body, "utf8");
}

function sessionReference(
  sessionPublicId: string,
  operationPublicId: string
): SessionReference {
  return {
    knowledgeBaseId: "kb-upload-contract",
    operationPublicId,
    sessionPublicId,
    temporaryObjectIds: []
  };
}

function errorWithCode(code: string): Error & { code: string } {
  return Object.assign(new Error(`Storage vNext upload error: ${code}`), { code });
}
