import type { SearchProviderRuntime } from
  "../../application/ports/search-provider-runtime.js";
import type { RuntimeSearchSettings } from "../../runtime-settings/types.js";
import type { SearchProviderIndexDefinition } from
  "../../application/ports/search-provider-runtime.js";
import { createDocumentSearchIndexer } from
  "../application/document-search-indexer.js";
import { ensureDocumentSearchIndex } from
  "../application/document-search-index-ensure.js";
import { createSearchProviderMicrobatch } from
  "../application/search-provider-microbatch.js";
import type { createPostgresDocumentSearchOwnerRepository } from
  "./postgres-document-search-owner-repository.js";

export function createWorkerDocumentSearchRuntime(input: {
  provider: SearchProviderRuntime;
  settings: RuntimeSearchSettings;
  definition: SearchProviderIndexDefinition;
  owners: ReturnType<typeof createPostgresDocumentSearchOwnerRepository>;
  awaitReceipt(
    receipt: Awaited<ReturnType<SearchProviderRuntime["operations"]["findOperationByCorrelation"]>> extends infer _T
      ? Parameters<typeof ensureDocumentSearchIndex>[0]["awaitReceipt"] extends
        (receipt: infer TReceipt) => Promise<void> ? TReceipt : never
      : never,
    signal: AbortSignal
  ): Promise<void>;
  microbatchWindowMs?: number;
}) {
  const ensured = new Map<string, Promise<void>>();
  const transport = createSearchProviderMicrobatch({
    provider: input.provider,
    windowMs: input.microbatchWindowMs ?? 50,
    maximumDocuments: input.settings.indexBatchDocumentCount,
    maximumBytes: input.settings.indexBatchCompressedBytes,
    awaitReceipt: input.awaitReceipt
  });
  const index = createDocumentSearchIndexer({
    batchSize: input.settings.indexBatchDocumentCount,
    provider: {
      kind: input.provider.kind,
      writeAcknowledged: (request) => transport.writeAcknowledged({
        indexUid: request.indexUid,
        documents: request.documents,
        signal: request.signal
      }),
      makeVisible: transport.makeVisible
    },
    owners: input.owners
  });
  return {
    provider: input.provider,
    async ensure(indexUid: string, signal: AbortSignal): Promise<void> {
      let promise = ensured.get(indexUid);
      if (!promise) {
        promise = ensureDocumentSearchIndex({
          provider: input.provider,
          indexUid,
          definition: input.definition,
          settings: input.settings,
          signal,
          awaitReceipt: (receipt) => input.awaitReceipt(receipt, signal)
        });
        ensured.set(indexUid, promise);
        void promise.catch(() => ensured.delete(indexUid));
      }
      await promise;
    },
    index,
    async close(): Promise<void> {
      await transport.flush();
      await input.provider.close();
    }
  };
}
