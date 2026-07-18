import {
  addUploadManifestEntries,
  cancelUploadSession,
  createUploadSession,
  finalizeUploadSession,
  getUploadSession,
  reconcileUploadSession,
  sealUploadManifest,
  uploadSessionContent,
  type ApiFailure,
  type UploadSession,
  type UploadSessionTransport
} from "./admin-api";
import { fileRelativePath, normalizeUploadRelativePath } from "./upload-selection";

export type UploadClientStage =
  | "hashing"
  | "manifest"
  | "classifying"
  | "uploading"
  | "finalizing"
  | "completed";

export type UploadClientProgress = {
  stage: UploadClientStage;
  completed: number;
  total: number;
  session: UploadSession | null;
};

export type UploadClientResult =
  | { ok: true; session: UploadSession }
  | { ok: false; failure: ApiFailure; sessionId: string | null };

export async function runUploadSession(input: {
  knowledgeBaseId: string;
  files: File[];
  onProgress: (progress: UploadClientProgress) => void;
  onSessionReady?: (sessionId: string, transport: UploadSessionTransport) => void;
}): Promise<UploadClientResult> {
  const manifest = [] as Array<{
    relativePath: string;
    declaredSize: number;
    checksumSha256: string | null;
  }>;
  for (let index = 0; index < input.files.length; index += 1) {
    const file = input.files[index];
    if (!file) continue;
    manifest.push({
      relativePath: fileRelativePath(file),
      declaredSize: file.size,
      checksumSha256: null
    });
    input.onProgress({
      stage: "hashing",
      completed: index + 1,
      total: input.files.length,
      session: null
    });
  }
  const created = await createUploadSession({
    knowledgeBaseId: input.knowledgeBaseId,
    idempotencyKey: crypto.randomUUID(),
    declaredFileCount: manifest.length,
    declaredByteCount: manifest.reduce((sum, entry) => sum + entry.declaredSize, 0)
  });
  if (isFailure(created)) {
    return { ok: false, failure: created, sessionId: null };
  }
  const sessionId = created.session.id;
  input.onSessionReady?.(sessionId, created.transport);
  for (let offset = 0; offset < manifest.length; offset += created.transport.manifestPageSize) {
    const response = await addUploadManifestEntries({
      knowledgeBaseId: input.knowledgeBaseId,
      sessionId,
      entries: manifest.slice(offset, offset + created.transport.manifestPageSize)
    });
    if (isFailure(response)) {
      return { ok: false, failure: response, sessionId };
    }
    input.onProgress({
      stage: "manifest",
      completed: Math.min(offset + created.transport.manifestPageSize, manifest.length),
      total: manifest.length,
      session: response.session
    });
  }
  const sealed = await sealUploadManifest({ knowledgeBaseId: input.knowledgeBaseId, sessionId });
  if (isFailure(sealed)) {
    return { ok: false, failure: sealed, sessionId };
  }
  input.onProgress({
    stage: "classifying",
    completed: sealed.session.counts.selected,
    total: sealed.session.counts.selected,
    session: sealed.session
  });
  if (sealed.session.counts.rejectedDeleting > 0) {
    return {
      ok: false,
      failure: { messageKey: "errors.uploadPathDeleting" },
      sessionId
    };
  }
  let session = sealed.session;
  if (session.counts.waitingReservation > 0) {
    const reconciled = await reconcileUploadSession({
      knowledgeBaseId: input.knowledgeBaseId,
      sessionId
    });
    if (isFailure(reconciled)) {
      return { ok: false, failure: reconciled, sessionId };
    }
    session = reconciled.session;
    if (session.counts.waitingReservation > 0) {
      return {
        ok: false,
        failure: { messageKey: "errors.uploadPathReserved" },
        sessionId
      };
    }
  }
  const uploaded = await transferMissingEntries({
    knowledgeBaseId: input.knowledgeBaseId,
    sessionId,
    files: input.files,
    transport: created.transport,
    session,
    onProgress: input.onProgress
  });
  if (!uploaded.ok) {
    return uploaded;
  }
  input.onProgress({
    stage: "finalizing",
    completed: uploaded.session.counts.uploaded,
    total: uploaded.session.counts.uploadRequired,
    session: uploaded.session
  });
  const finalized = await finalizeUploadSession({
    knowledgeBaseId: input.knowledgeBaseId,
    sessionId
  });
  if (isFailure(finalized)) {
    return { ok: false, failure: finalized, sessionId };
  }
  input.onProgress({
    stage: "completed",
    completed: finalized.session.counts.selected,
    total: finalized.session.counts.selected,
    session: finalized.session
  });
  return { ok: true, session: finalized.session };
}

export async function resumeUploadSession(input: {
  knowledgeBaseId: string;
  sessionId: string;
  files: File[];
  transport: UploadSessionTransport;
  onProgress: (progress: UploadClientProgress) => void;
}): Promise<UploadClientResult> {
  const current = await getUploadSession({
    knowledgeBaseId: input.knowledgeBaseId,
    sessionId: input.sessionId,
    limit: 1
  });
  if (isFailure(current)) {
    return { ok: false, failure: current, sessionId: input.sessionId };
  }
  let session = current.session;
  if (session.state === "completed") {
    return { ok: true, session };
  }
  if (session.counts.waitingReservation > 0) {
    const reconciled = await reconcileUploadSession({
      knowledgeBaseId: input.knowledgeBaseId,
      sessionId: input.sessionId
    });
    if (isFailure(reconciled)) {
      return { ok: false, failure: reconciled, sessionId: input.sessionId };
    }
    session = reconciled.session;
  }
  if (session.counts.waitingReservation > 0 || session.counts.rejectedDeleting > 0) {
    return {
      ok: false,
      failure: {
        messageKey:
          session.counts.rejectedDeleting > 0
            ? "errors.uploadPathDeleting"
            : "errors.uploadPathReserved"
      },
      sessionId: input.sessionId
    };
  }
  const uploaded = await transferMissingEntries({
    knowledgeBaseId: input.knowledgeBaseId,
    sessionId: input.sessionId,
    files: input.files,
    transport: input.transport,
    session,
    onProgress: input.onProgress
  });
  if (!uploaded.ok) {
    return uploaded;
  }
  const finalized = await finalizeUploadSession({
    knowledgeBaseId: input.knowledgeBaseId,
    sessionId: input.sessionId
  });
  if (isFailure(finalized)) {
    return { ok: false, failure: finalized, sessionId: input.sessionId };
  }
  return { ok: true, session: finalized.session };
}

export async function cancelFolderUpload(input: {
  knowledgeBaseId: string;
  sessionId: string;
}): Promise<void> {
  await cancelUploadSession(input);
}

async function transferMissingEntries(input: {
  knowledgeBaseId: string;
  sessionId: string;
  files: File[];
  transport: UploadSessionTransport;
  session: UploadSession;
  onProgress: (progress: UploadClientProgress) => void;
}): Promise<UploadClientResult> {
  const fileByPath = new Map(
    input.files.map((file) => [normalizeUploadRelativePath(fileRelativePath(file)), file])
  );
  let cursor: string | null = null;
  let session = input.session;
  do {
    const page = await getUploadSession({
      knowledgeBaseId: input.knowledgeBaseId,
      sessionId: input.sessionId,
      transferState: "missing",
      cursor,
      limit: input.transport.manifestPageSize
    });
    if (isFailure(page)) {
      return { ok: false, failure: page, sessionId: input.sessionId };
    }
    session = page.session;
    for (const entry of page.entries.items) {
      const file = fileByPath.get(normalizeUploadRelativePath(entry.relativePath));
      if (!file) {
        throw new Error("UPLOAD_SELECTION_CHANGED");
      }
      const response = await uploadSessionContent({
        knowledgeBaseId: input.knowledgeBaseId,
        sessionId: input.sessionId,
        entryId: entry.id,
        file
      });
      if (isFailure(response)) {
        return { ok: false, failure: response, sessionId: input.sessionId };
      }
      session = {
        ...session,
        counts: {
          ...session.counts,
          uploaded: session.counts.uploaded + 1
        }
      };
      input.onProgress({
        stage: "uploading",
        completed: session.counts.uploaded,
        total: session.counts.uploadRequired,
        session
      });
    }
    cursor = page.entries.nextCursor;
  } while (cursor);
  return { ok: true, session };
}

function isFailure(value: unknown): value is ApiFailure {
  return Boolean(value && typeof value === "object" && "messageKey" in value);
}
