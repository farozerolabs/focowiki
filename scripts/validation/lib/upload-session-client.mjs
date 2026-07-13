import { createHash, randomUUID } from "node:crypto";

export async function uploadMarkdownFilesWithSession(input) {
  const files = input.files.map(normalizeInputFile);
  const declaredByteCount = files.reduce((total, file) => total + file.bytes.byteLength, 0);
  const created = await requestData(input.request, input.routeBase, {
    method: "POST",
    status: 201,
    headers: { "Idempotency-Key": input.idempotencyKey ?? randomUUID() },
    body: {
      declaredFileCount: files.length,
      declaredByteCount
    }
  });
  const sessionId = created.session?.id;
  const limits = created.limits;
  if (!sessionId || !limits?.manifestPageSize) {
    throw new Error("Upload session creation did not return session identity and limits.");
  }

  for (const entries of chunk(files.map(toManifestEntry), limits.manifestPageSize)) {
    await requestData(input.request, `${input.routeBase}/${encodeURIComponent(sessionId)}/entries`, {
      method: "POST",
      body: { entries }
    });
  }

  let sealed = await requestData(
    input.request,
    `${input.routeBase}/${encodeURIComponent(sessionId)}/seal`,
    { method: "POST" }
  );
  for (let attempt = 0; sealed.session?.counts?.waitingReservation > 0 && attempt < 5; attempt += 1) {
    sealed = await requestData(
      input.request,
      `${input.routeBase}/${encodeURIComponent(sessionId)}/reconcile`,
      { method: "POST" }
    );
  }
  if (sealed.session?.counts?.waitingReservation > 0) {
    throw new Error("Upload session still has path reservations after reconciliation.");
  }
  if (sealed.session?.counts?.rejectedDeleting > 0) {
    throw new Error("Upload session contains paths owned by an active deletion.");
  }

  const fileByPath = new Map(files.map((file) => [file.relativePath, file]));
  let cursor = null;
  do {
    const page = await requestData(
      input.request,
      `${input.routeBase}/${encodeURIComponent(sessionId)}`,
      {
        query: {
          transferState: "missing",
          limit: limits.manifestPageSize,
          ...(cursor ? { cursor } : {})
        }
      }
    );
    for (const entries of contentBatches(page.entries?.items ?? [], fileByPath, limits)) {
      const formData = new FormData();
      for (const entry of entries) {
        formData.append(
          entry.id,
          new Blob([entry.file.bytes], { type: "text/markdown" }),
          entry.file.relativePath.split("/").at(-1)
        );
      }
      await requestData(
        input.request,
        `${input.routeBase}/${encodeURIComponent(sessionId)}/content`,
        { method: "POST", formData }
      );
    }
    cursor = page.entries?.nextCursor ?? null;
  } while (cursor);

  const finalized = await requestData(
    input.request,
    `${input.routeBase}/${encodeURIComponent(sessionId)}/finalize`,
    { method: "POST", status: 202 }
  );
  const completed = await waitForFinalization({
    request: input.request,
    routeBase: input.routeBase,
    sessionId,
    session: finalized.session,
    pollIntervalMs: input.finalizationPollIntervalMs,
    timeoutMs: input.finalizationTimeoutMs
  });
  const entries = await listAllEntries({
    request: input.request,
    routeBase: input.routeBase,
    sessionId,
    limit: limits.manifestPageSize
  });
  return {
    session: completed,
    limits,
    entries,
    files: entries
      .filter((entry) => entry.sourceFileId)
      .map((entry) => ({
        sourceFileId: entry.sourceFileId,
        name: entry.name,
        relativePath: entry.relativePath,
        generatedPath: entry.generatedPath,
        disposition: entry.disposition
      }))
  };
}

async function waitForFinalization(input) {
  const pollIntervalMs = readNonNegativeInteger(input.pollIntervalMs, 1_000);
  const timeoutMs = readPositiveInteger(input.timeoutMs, 15 * 60 * 1_000);
  const deadline = Date.now() + timeoutMs;
  let session = input.session;

  while (session?.state === "finalizing" && Date.now() < deadline) {
    await sleep(pollIntervalMs);
    const status = await requestData(
      input.request,
      `${input.routeBase}/${encodeURIComponent(input.sessionId)}`,
      { query: { limit: 1 } }
    );
    session = status.session;
  }

  if (session?.state === "failed" || session?.state === "cancelled" || session?.state === "expired") {
    throw new Error(`Upload session finalization ended in ${session.state}.`);
  }
  if (session?.state !== "completed") {
    throw new Error(`Upload session finalization timed out after ${timeoutMs}ms.`);
  }
  return session;
}

async function listAllEntries(input) {
  const entries = [];
  let cursor = null;
  do {
    const page = await requestData(
      input.request,
      `${input.routeBase}/${encodeURIComponent(input.sessionId)}`,
      { query: { limit: input.limit, ...(cursor ? { cursor } : {}) } }
    );
    entries.push(...(page.entries?.items ?? []));
    cursor = page.entries?.nextCursor ?? null;
  } while (cursor);
  return entries;
}

async function requestData(request, pathname, options) {
  const response = await request(pathname, options);
  return response && typeof response === "object" && "data" in response
    ? response.data
    : response;
}

function normalizeInputFile(file) {
  const relativePath = String(file.relativePath ?? file.basename ?? "").normalize("NFC");
  const bytes = file.bytes instanceof Uint8Array
    ? file.bytes
    : new Uint8Array(file.bytes);
  if (!relativePath || !relativePath.toLowerCase().endsWith(".md")) {
    throw new Error("Upload session validation files must use Markdown relative paths.");
  }
  return { relativePath, bytes };
}

function toManifestEntry(file) {
  return {
    relativePath: file.relativePath,
    declaredSize: file.bytes.byteLength,
    checksumSha256: createHash("sha256").update(file.bytes).digest("hex")
  };
}

function contentBatches(entries, fileByPath, limits) {
  const batches = [];
  let current = [];
  let currentBytes = 0;
  for (const entry of entries) {
    const file = fileByPath.get(entry.relativePath);
    if (!file) throw new Error(`Upload entry has no matching local file: ${entry.relativePath}`);
    if (
      current.length > 0
      && (
        current.length >= limits.contentBatchMaxFiles
        || currentBytes + file.bytes.byteLength > limits.contentBatchMaxBytes
      )
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push({ id: entry.id, file });
    currentBytes += file.bytes.byteLength;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function chunk(items, size) {
  const pages = [];
  for (let offset = 0; offset < items.length; offset += size) {
    pages.push(items.slice(offset, offset + size));
  }
  return pages;
}

function readNonNegativeInteger(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function readPositiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
