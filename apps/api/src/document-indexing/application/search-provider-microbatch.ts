import { createHash } from "node:crypto";
import type {
  SearchProviderDocument,
  SearchProviderOperationReceipt,
  SearchProviderRuntime
} from "../../application/ports/search-provider-runtime.js";

type WriteWaiter = {
  documents: readonly SearchProviderDocument[];
  resolve(value: { acknowledgementPublicId: string; documentIds: readonly string[] }): void;
  reject(error: unknown): void;
};

type RefreshWaiter = { resolve(): void; reject(error: unknown): void };

export function createSearchProviderMicrobatch(input: {
  provider: SearchProviderRuntime;
  windowMs: number;
  maximumDocuments: number;
  maximumBytes: number;
  awaitReceipt(receipt: SearchProviderOperationReceipt, signal: AbortSignal): Promise<void>;
}) {
  validateConfiguration(input);
  const writes = new Map<string, WriteWaiter[]>();
  const refreshes = new Map<string, RefreshWaiter[]>();
  let writeTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleWrite(): void {
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      void flushWrites();
    }, input.windowMs);
    writeTimer.unref?.();
  }

  function scheduleRefresh(): void {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void flushRefreshes();
    }, input.windowMs);
    refreshTimer.unref?.();
  }

  async function flushWrites(): Promise<void> {
    const groups = [...writes.entries()];
    writes.clear();
    await Promise.allSettled(groups.map(async ([indexUid, waiters]) => {
      try {
        const documents = uniqueDocuments(waiters.flatMap(
          (item) => item.documents
        ));
        const outcomes = await writeWithIsolation(indexUid, documents);
        for (const waiter of waiters) {
          const failed = waiter.documents.find((document) =>
            outcomes.errors.has(document.id));
          if (failed) {
            waiter.reject(outcomes.errors.get(failed.id));
            continue;
          }
          waiter.resolve({
            acknowledgementPublicId: `search-ack-${digest([
              indexUid,
              ...waiter.documents.map((document) => document.id).sort()
            ])}`,
            documentIds: waiter.documents.map((document) => document.id)
          });
        }
      } catch (error) {
        waiters.forEach((waiter) => waiter.reject(error));
      }
    }));
  }

  async function writeWithIsolation(
    indexUid: string,
    documents: readonly SearchProviderDocument[]
  ): Promise<{ errors: Map<string, unknown> }> {
    const errors = new Map<string, unknown>();
    const batches = boundedBatches(documents, input.maximumDocuments, input.maximumBytes);
    for (const batch of batches) await writeBatch(indexUid, batch, errors);
    return { errors };
  }

  async function writeBatch(
    indexUid: string,
    documents: readonly SearchProviderDocument[],
    errors: Map<string, unknown>
  ): Promise<void> {
    const correlation = `search-flush-${digest([
      indexUid,
      ...documents.map((document) => document.id).sort()
    ])}`;
    try {
      const receipt = await input.provider.write.writeDocuments({
        indexUid,
        documents,
        correlation
      });
      await input.awaitReceipt(receipt, new AbortController().signal);
    } catch (error) {
      if (documents.length === 1) {
        errors.set(documents[0]!.id, error);
        return;
      }
      const midpoint = Math.ceil(documents.length / 2);
      await writeBatch(indexUid, documents.slice(0, midpoint), errors);
      await writeBatch(indexUid, documents.slice(midpoint), errors);
    }
  }

  async function flushRefreshes(): Promise<void> {
    const groups = [...refreshes.entries()];
    refreshes.clear();
    await Promise.allSettled(groups.map(async ([indexUid, waiters]) => {
      try {
        await input.provider.write.refreshIndex({ indexUid });
        waiters.forEach((waiter) => waiter.resolve());
      } catch (error) {
        waiters.forEach((waiter) => waiter.reject(error));
      }
    }));
  }

  return {
    kind: input.provider.kind,
    writeAcknowledged(request: {
      indexUid: string;
      documents: readonly SearchProviderDocument[];
      signal: AbortSignal;
    }): Promise<{ acknowledgementPublicId: string; documentIds: readonly string[] }> {
      request.signal.throwIfAborted();
      return new Promise((resolve, reject) => {
        const group = writes.get(request.indexUid) ?? [];
        group.push({ documents: request.documents, resolve, reject });
        writes.set(request.indexUid, group);
        scheduleWrite();
      });
    },
    makeVisible(request: { indexUid: string; signal: AbortSignal }): Promise<void> {
      request.signal.throwIfAborted();
      return new Promise((resolve, reject) => {
        const group = refreshes.get(request.indexUid) ?? [];
        group.push({ resolve, reject });
        refreshes.set(request.indexUid, group);
        scheduleRefresh();
      });
    },
    async flush(): Promise<void> {
      if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
      if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
      await flushWrites();
      await flushRefreshes();
    }
  };
}

function boundedBatches(
  documents: readonly SearchProviderDocument[],
  maximumDocuments: number,
  maximumBytes: number
): SearchProviderDocument[][] {
  const batches: SearchProviderDocument[][] = [];
  let current: SearchProviderDocument[] = [];
  let bytes = 0;
  for (const document of documents) {
    const size = Buffer.byteLength(JSON.stringify(document), "utf8");
    if (size > maximumBytes) throw new Error("SEARCH_DOCUMENT_SIZE_LIMIT");
    if (current.length > 0
      && (current.length >= maximumDocuments || bytes + size > maximumBytes)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(document);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function uniqueDocuments(
  documents: readonly SearchProviderDocument[]
): SearchProviderDocument[] {
  const byId = new Map<string, SearchProviderDocument>();
  for (const document of documents) {
    const existing = byId.get(document.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(document)) {
      throw new Error("SEARCH_DOCUMENT_IDENTITY_CONFLICT");
    }
    byId.set(document.id, document);
  }
  return [...byId.values()];
}

function validateConfiguration(input: {
  windowMs: number;
  maximumDocuments: number;
  maximumBytes: number;
}): void {
  if (!Number.isSafeInteger(input.windowMs) || input.windowMs < 25 || input.windowMs > 100
    || !Number.isSafeInteger(input.maximumDocuments)
    || input.maximumDocuments < 1 || input.maximumDocuments > 10_000
    || !Number.isSafeInteger(input.maximumBytes)
    || input.maximumBytes < 1_024 || input.maximumBytes > 100_000_000) {
    throw new Error("SEARCH_MICROBATCH_CONFIGURATION_INVALID");
  }
}

function digest(values: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
