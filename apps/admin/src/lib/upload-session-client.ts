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

const CONTENT_UPLOAD_MAX_ATTEMPTS = 3;
const CONTENT_UPLOAD_RETRY_DELAY_MILLISECONDS = 25;

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
  signal?: AbortSignal | undefined;
}): Promise<UploadClientResult> {
  if (input.signal?.aborted) return canceledUploadResult();
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
    declaredByteCount: manifest.reduce((sum, entry) => sum + entry.declaredSize, 0),
    signal: input.signal
  });
  if (input.signal?.aborted) return canceledUploadResult();
  if (isFailure(created)) {
    return { ok: false, failure: created, sessionId: null };
  }
  const sessionId = created.session.id;
  input.onSessionReady?.(sessionId, created.transport);
  try {
    const result = await continueUploadSession({
      knowledgeBaseId: input.knowledgeBaseId,
      files: input.files,
      manifest,
      sessionId,
      transport: created.transport,
      onProgress: input.onProgress,
      signal: input.signal
    });
    if (input.signal?.aborted) return canceledUploadResult();
    if (result.ok) return result;
    return cancelFailedUploadSession({
      knowledgeBaseId: input.knowledgeBaseId,
      sessionId,
      failure: result.failure
    });
  } catch {
    if (input.signal?.aborted) return canceledUploadResult();
    return cancelFailedUploadSession({
      knowledgeBaseId: input.knowledgeBaseId,
      sessionId,
      failure: { messageKey: "errors.uploadFailed" }
    });
  }
}

async function continueUploadSession(input: {
  knowledgeBaseId: string;
  files: File[];
  manifest: Array<{
    relativePath: string;
    declaredSize: number;
    checksumSha256: string | null;
  }>;
  sessionId: string;
  transport: UploadSessionTransport;
  onProgress: (progress: UploadClientProgress) => void;
  signal?: AbortSignal | undefined;
}): Promise<UploadClientResult> {
  for (let offset = 0; offset < input.manifest.length; offset += input.transport.manifestPageSize) {
    const response = await addUploadManifestEntries({
      knowledgeBaseId: input.knowledgeBaseId,
      sessionId: input.sessionId,
      entries: input.manifest.slice(offset, offset + input.transport.manifestPageSize),
      signal: input.signal
    });
    if (isFailure(response)) {
      return { ok: false, failure: response, sessionId: input.sessionId };
    }
    input.onProgress({
      stage: "manifest",
      completed: Math.min(offset + input.transport.manifestPageSize, input.manifest.length),
      total: input.manifest.length,
      session: response.session
    });
  }
  const sealed = await sealUploadManifest({
    knowledgeBaseId: input.knowledgeBaseId,
    sessionId: input.sessionId,
    signal: input.signal
  });
  if (isFailure(sealed)) {
    return { ok: false, failure: sealed, sessionId: input.sessionId };
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
      sessionId: input.sessionId
    };
  }
  let session = sealed.session;
  if (session.counts.waitingReservation > 0) {
    const reconciled = await reconcileUploadSession({
      knowledgeBaseId: input.knowledgeBaseId,
      sessionId: input.sessionId,
      signal: input.signal
    });
    if (isFailure(reconciled)) {
      return { ok: false, failure: reconciled, sessionId: input.sessionId };
    }
    session = reconciled.session;
    if (session.counts.waitingReservation > 0) {
      return {
        ok: false,
        failure: { messageKey: "errors.uploadPathReserved" },
        sessionId: input.sessionId
      };
    }
  }
  const uploaded = await transferMissingEntries({
    knowledgeBaseId: input.knowledgeBaseId,
    sessionId: input.sessionId,
    files: input.files,
    transport: input.transport,
    session,
    onProgress: input.onProgress,
    signal: input.signal
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
    sessionId: input.sessionId,
    signal: input.signal
  });
  if (isFailure(finalized)) {
    return { ok: false, failure: finalized, sessionId: input.sessionId };
  }
  input.onProgress({
    stage: "completed",
    completed: finalized.session.counts.selected,
    total: finalized.session.counts.selected,
    session: finalized.session
  });
  return { ok: true, session: finalized.session };
}

async function cancelFailedUploadSession(input: {
  knowledgeBaseId: string;
  sessionId: string;
  failure: ApiFailure;
}): Promise<UploadClientResult> {
  await cancelUploadSession({
    knowledgeBaseId: input.knowledgeBaseId,
    sessionId: input.sessionId
  }).catch(() => undefined);
  return {
    ok: false,
    failure: input.failure,
    sessionId: null
  };
}

function canceledUploadResult(): UploadClientResult {
  return {
    ok: false,
    failure: { messageKey: "errors.uploadFailed" },
    sessionId: null
  };
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
  signal?: AbortSignal | undefined;
}): Promise<UploadClientResult> {
  const fileByPath = new Map(
    input.files.map((file) => [normalizeUploadRelativePath(fileRelativePath(file)), file])
  );
  let cursor: string | null = null;
  let session = input.session;
  let completedUploads = session.counts.uploaded;
  do {
    const page = await getUploadSession({
      knowledgeBaseId: input.knowledgeBaseId,
      sessionId: input.sessionId,
      transferState: "missing",
      cursor,
      limit: input.transport.manifestPageSize,
      signal: input.signal
    });
    if (isFailure(page)) {
      return { ok: false, failure: page, sessionId: input.sessionId };
    }
    session = page.session;
    const results = await mapWithConcurrency(
      page.entries.items,
      input.transport.contentUploadConcurrency,
      async (entry) => {
        const file = fileByPath.get(normalizeUploadRelativePath(entry.relativePath));
        if (!file) {
          throw new Error("UPLOAD_SELECTION_CHANGED");
        }
        const response = await uploadEntryContentWithRetry({
          knowledgeBaseId: input.knowledgeBaseId,
          sessionId: input.sessionId,
          entryId: entry.id,
          file,
          signal: input.signal
        });
        if (isFailure(response)) {
          return response;
        }
        completedUploads += 1;
        input.onProgress({
          stage: "uploading",
          completed: completedUploads,
          total: session.counts.uploadRequired,
          session: {
            ...session,
            counts: { ...session.counts, uploaded: completedUploads }
          }
        });
        return null;
      }
    );
    const failure = results.find(isFailure);
    if (failure) {
      return { ok: false, failure, sessionId: input.sessionId };
    }
    session = {
      ...session,
      counts: { ...session.counts, uploaded: completedUploads }
    };
    cursor = page.entries.nextCursor;
  } while (cursor);
  return { ok: true, session };
}

async function uploadEntryContentWithRetry(input: {
  knowledgeBaseId: string;
  sessionId: string;
  entryId: string;
  file: File;
  signal?: AbortSignal | undefined;
}): Promise<Awaited<ReturnType<typeof uploadSessionContent>>> {
  let lastFailure: ApiFailure = { messageKey: "errors.uploadFailed" };
  for (let attempt = 1; attempt <= CONTENT_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
    if (input.signal?.aborted) return lastFailure;
    try {
      const response = await uploadSessionContent(input);
      if (!isFailure(response)) return response;
      lastFailure = response;
    } catch {
      lastFailure = { messageKey: "errors.uploadFailed" };
    }
    if (input.signal?.aborted) return lastFailure;
    if (attempt < CONTENT_UPLOAD_MAX_ATTEMPTS) {
      await sleep(CONTENT_UPLOAD_RETRY_DELAY_MILLISECONDS * attempt);
    }
  }
  return lastFailure;
}

function isFailure(value: unknown): value is ApiFailure {
  return Boolean(value && typeof value === "object" && "messageKey" in value);
}

async function mapWithConcurrency<T, R>(
  values: T[],
  requestedConcurrency: number | undefined,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const concurrency = Number.isSafeInteger(requestedConcurrency) && Number(requestedConcurrency) > 0
    ? Math.min(Number(requestedConcurrency), 16)
    : 1;
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]!);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker())
  );
  return results;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
