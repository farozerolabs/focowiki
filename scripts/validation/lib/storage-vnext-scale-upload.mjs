import { createHash } from "node:crypto";
import {
  validateStorageVnextScaleCorpusManifest
} from "./storage-vnext-scale-corpus.mjs";

const CONTENT_TYPE = "text/markdown; charset=utf-8";

export async function uploadStorageVnextScaleCorpus(input) {
  const manifest = validateStorageVnextScaleCorpusManifest(input.manifest, {
    expectedFileCount: input.expectedFileCount
  });
  if (!input.client || typeof input.client.json !== "function") {
    throw new Error("Scale upload HTTP client is required");
  }
  if (typeof input.readBytes !== "function") {
    throw new Error("Scale upload body reader is required");
  }
  const base = `/openapi/v2/knowledge-bases/${encodeURIComponent(
    input.knowledgeBaseId
  )}/upload-sessions`;
  const startedAtMs = input.startedAtMs ?? Date.now();
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0 || startedAtMs > Date.now()) {
    throw new Error("Scale upload start time is invalid");
  }
  const created = await input.client.json(base, {
    method: "POST",
    headers: { "idempotency-key": input.idempotencyKey },
    json: {
      declaredFileCount: manifest.fileCount,
      declaredByteCount: manifest.totalSizeBytes
    },
    expectedStatus: 201
  });
  const sessionId = created.session?.id;
  const pageSize = created.transport?.manifestPageSize;
  const uploadConcurrency = created.transport?.contentUploadConcurrency;
  if (
    !sessionId
    || !Number.isSafeInteger(pageSize)
    || pageSize < 1
    || !Number.isSafeInteger(uploadConcurrency)
    || uploadConcurrency < 1
  ) throw new Error("Scale upload session returned invalid transport limits");
  const resume = resolveStorageVnextScaleUploadResume({
    session: created.session,
    expectedFileCount: manifest.fileCount
  });
  input.onProgress?.({
    phase: resume.appendManifest ? "upload-session-created" : "upload-session-resumed",
    fileCount: manifest.fileCount,
    state: created.session.state,
    selectedFiles: resume.selectedFiles,
    uploadedFiles: resume.uploadedFiles
  });

  if (resume.appendManifest) {
    for (let offset = 0; offset < manifest.files.length; offset += pageSize) {
      const page = manifest.files.slice(offset, offset + pageSize);
      await input.client.json(`${base}/${encodeURIComponent(sessionId)}/entries`, {
        method: "POST",
        json: {
          entries: page.map((file) => ({
            relativePath: file.relativePath,
            declaredSize: file.sizeBytes,
            checksumSha256: file.checksumSha256
          }))
        }
      });
      input.onProgress?.({
        phase: "upload-manifest",
        acceptedFiles: Math.min(offset + page.length, manifest.fileCount)
      });
    }
  }

  let session = created.session;
  if (resume.sealManifest) {
    const sealed = await sealScaleUploadManifest({
      client: input.client,
      base,
      sessionId
    });
    session = sealed.session;
  }

  const fileByPath = new Map(manifest.files.map((file) => [file.relativePath, file]));
  let uploadedFiles = readSessionCount(session, "uploaded");
  if (session.state === "uploading") {
    let cursor = null;
    do {
      const page = await input.client.json(`${base}/${encodeURIComponent(sessionId)}`, {
        query: {
          transferState: "missing",
          limit: pageSize,
          ...(cursor ? { cursor } : {})
        }
      });
      const entries = page.entries?.items ?? [];
      await mapWithBoundedConcurrency(
        entries,
        Math.min(uploadConcurrency, 16),
        async (entry) => {
          const descriptor = fileByPath.get(entry.relativePath);
          if (!descriptor) throw new Error("Scale upload entry is outside the corpus manifest");
          const bytes = await input.readBytes(descriptor);
          if (!(bytes instanceof Uint8Array)) {
            throw new Error("Scale upload body reader returned invalid bytes");
          }
          if (
            bytes.byteLength !== descriptor.sizeBytes
            || digest(bytes) !== descriptor.checksumSha256
          ) throw new Error(`Scale upload source changed: ${descriptor.relativePath}`);
          await input.client.json(
            `${base}/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entry.id)}/content`,
            {
              method: "PUT",
              headers: { "content-type": CONTENT_TYPE },
              rawBody: bytes
            }
          );
        }
      );
      uploadedFiles += entries.length;
      cursor = page.entries?.nextCursor ?? null;
      input.onProgress?.({ phase: "upload-content", uploadedFiles });
    } while (cursor);
    const uploadRequired = readSessionCount(session, "uploadRequired");
    if (uploadedFiles !== uploadRequired) {
      throw new Error(`Scale upload transferred ${uploadedFiles}/${uploadRequired} files`);
    }
  }

  const finalized = session.state === "uploading"
    ? await input.client.json(
      `${base}/${encodeURIComponent(sessionId)}/finalize`,
      { method: "POST" }
    )
    : { session };
  const completed = await waitForCompletion({
    client: input.client,
    base,
    sessionId,
    initial: finalized.session,
    timeoutMs: input.finalizationTimeoutMs ?? 2 * 60 * 60 * 1_000
  });
  const completedAtMs = Date.now();
  input.onProgress?.({ phase: "upload-completed", uploadedFiles });
  return {
    sessionId,
    uploadedFiles,
    uploadedBytes: manifest.totalSizeBytes,
    durationMs: completedAtMs - startedAtMs,
    filesPerSecond: rate(manifest.fileCount, completedAtMs - startedAtMs),
    terminalState: completed.state
  };
}

export function resolveStorageVnextScaleUploadResume(input) {
  const state = input.session?.state;
  const selectedFiles = readSessionCount(input.session, "selected");
  const uploadedFiles = readSessionCount(input.session, "uploaded");
  if (!Number.isSafeInteger(input.expectedFileCount) || input.expectedFileCount < 1) {
    throw new Error("Scale upload expected file count is invalid");
  }
  if (selectedFiles > input.expectedFileCount || uploadedFiles > selectedFiles) {
    throw new Error("Scale upload session counts are invalid");
  }
  if (state === "draft" && selectedFiles === 0 && uploadedFiles === 0) {
    return { appendManifest: true, sealManifest: true, selectedFiles, uploadedFiles };
  }
  if (state === "manifest_building" && selectedFiles === input.expectedFileCount) {
    return { appendManifest: false, sealManifest: true, selectedFiles, uploadedFiles };
  }
  if (
    (state === "uploading" || state === "finalizing" || state === "completed")
    && selectedFiles === input.expectedFileCount
  ) {
    return { appendManifest: false, sealManifest: false, selectedFiles, uploadedFiles };
  }
  throw new Error(
    `Scale upload session cannot resume from ${state ?? "unknown"} `
    + `with ${selectedFiles}/${input.expectedFileCount} manifest entries`
  );
}

async function sealScaleUploadManifest(input) {
  let sealed = await input.client.json(
    `${input.base}/${encodeURIComponent(input.sessionId)}/seal`,
    { method: "POST" }
  );
  for (let attempt = 0;
    (sealed.session?.counts?.waitingReservation ?? 0) > 0 && attempt < 1_000;
    attempt += 1) {
    await sleep(250);
    sealed = await input.client.json(
      `${input.base}/${encodeURIComponent(input.sessionId)}/reconcile`,
      { method: "POST" }
    );
  }
  if ((sealed.session?.counts?.waitingReservation ?? 0) > 0) {
    throw new Error("Scale upload path reservations did not converge");
  }
  if ((sealed.session?.counts?.rejectedDeleting ?? 0) > 0) {
    throw new Error("Scale upload found paths owned by deletion");
  }
  return sealed;
}

export async function mapWithBoundedConcurrency(values, concurrency, mapper) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) {
    throw new Error("Scale upload concurrency is invalid");
  }
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker())
  );
  return results;
}

async function waitForCompletion(input) {
  const deadline = Date.now() + input.timeoutMs;
  let session = input.initial;
  while (session?.state === "finalizing" && Date.now() < deadline) {
    await sleep(1_000);
    const current = await input.client.json(
      `${input.base}/${encodeURIComponent(input.sessionId)}`,
      { query: { limit: 1 } }
    );
    session = current.session;
  }
  if (session?.state !== "completed") {
    throw new Error(`Scale upload finalization ended in ${session?.state ?? "timeout"}`);
  }
  return session;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function rate(count, milliseconds) {
  return Math.round(count / Math.max(milliseconds / 1_000, 0.001) * 1_000) / 1_000;
}

function readSessionCount(session, name) {
  const value = session?.counts?.[name];
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Scale upload session ${name} count is invalid`);
  }
  return value;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
