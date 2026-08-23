import type { StorageVnextImmutableBodyStore } from
  "../../storage-vnext/ownership/s3-immutable-body-store.js";
import type { GeneratedPageBase } from
  "./postgres-generated-page-base-repository.js";
import type { DocumentPageBaseSnapshot } from
  "./production-document-page-base.js";

export function createDocumentPageBaseLoader(input: {
  bodies: StorageVnextImmutableBodyStore;
  maximumBytes: number;
  cacheMaximumEntries?: number;
  cacheMaximumBytes?: number;
}) {
  const cacheMaximumEntries = input.cacheMaximumEntries ?? 256;
  const cacheMaximumBytes = input.cacheMaximumBytes ?? 32 * 1_048_576;
  if (!Number.isSafeInteger(cacheMaximumEntries) || cacheMaximumEntries < 0
    || cacheMaximumEntries > 10_000
    || !Number.isSafeInteger(cacheMaximumBytes) || cacheMaximumBytes < 0
    || cacheMaximumBytes > 256 * 1_048_576) {
    throw loaderError("generated_page_base_cache_capacity_invalid");
  }
  const cache = new Map<string, {
    snapshot: DocumentPageBaseSnapshot;
    byteCount: number;
  }>();
  let cachedBytes = 0;
  const inFlight = new Map<string, {
    controller: AbortController;
    promise: Promise<DocumentPageBaseSnapshot>;
    subscribers: number;
    settled: boolean;
  }>();
  return async (request: {
    base: GeneratedPageBase;
    signal: AbortSignal;
  }): Promise<DocumentPageBaseSnapshot> => {
    request.signal.throwIfAborted();
    const key = request.base.object.objectId;
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return cached.snapshot;
    }
    let pending = inFlight.get(key);
    if (!pending) {
      const controller = new AbortController();
      const entry = {
        controller,
        subscribers: 0,
        settled: false,
        promise: load(request.base, controller.signal)
      };
      pending = entry;
      inFlight.set(key, entry);
      void entry.promise.then((snapshot) => {
        if (cacheMaximumEntries > 0 && cacheMaximumBytes > 0
          && request.base.object.byteCount <= cacheMaximumBytes) {
          const existing = cache.get(key);
          if (existing) cachedBytes -= existing.byteCount;
          cache.set(key, {
            snapshot,
            byteCount: request.base.object.byteCount
          });
          cachedBytes += request.base.object.byteCount;
          while (cache.size > cacheMaximumEntries
            || cachedBytes > cacheMaximumBytes) {
            const oldestKey = cache.keys().next().value;
            if (oldestKey === undefined) break;
            const removed = cache.get(oldestKey);
            cache.delete(oldestKey);
            cachedBytes -= removed?.byteCount ?? 0;
          }
        }
      }).finally(() => {
        entry.settled = true;
        if (inFlight.get(key) === entry) inFlight.delete(key);
      }).catch(() => undefined);
    }
    pending.subscribers += 1;
    try {
      return await awaitWithSignal(pending.promise, request.signal);
    } finally {
      pending.subscribers -= 1;
      if (pending.subscribers === 0 && !pending.settled) {
        pending.controller.abort(loaderError("generated_page_base_read_aborted"));
      }
    }
  };

  async function load(
    base: GeneratedPageBase,
    signal: AbortSignal
  ): Promise<DocumentPageBaseSnapshot> {
    const bytes = await input.bodies.readVerified({
      descriptor: {
        objectId: base.object.objectId,
        storageKey: base.object.storageKey,
        checksum: base.object.checksumSha256,
        byteCount: base.object.byteCount,
        contentType: base.object.contentType,
        objectFormat: base.object.objectFormat
      },
      maximumBytes: input.maximumBytes,
      signal
    });
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw loaderError("generated_page_base_invalid");
    }
    if (!isRecord(value)
      || value.schemaVersion !== "document-page-base-v1"
      || value.sourceFilePublicId !== base.sourceFilePublicId
      || value.sourceRevisionPublicId !== base.sourceRevisionPublicId
      || typeof value.logicalPath !== "string"
      || typeof value.title !== "string"
      || typeof value.body !== "string"
      || !isRecord(value.metadata)
      || !isRecord(value.sourceMetadata)
      || !Array.isArray(value.semanticEntities)) {
      throw loaderError("generated_page_base_invalid");
    }
    return value as unknown as DocumentPageBaseSnapshot;
  }
}

async function awaitWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loaderError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Generated page base loader error: ${code}`), { code });
}
