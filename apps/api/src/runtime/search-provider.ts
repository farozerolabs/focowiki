import type { LexicalTokenizer } from
  "../application/ports/lexical-tokenizer.js";
import type {
  SearchProviderIndexDefinition,
  SearchProviderRuntime
} from "../application/ports/search-provider-runtime.js";
import { createMeilisearchProviderRuntime } from
  "../infrastructure/meilisearch/meilisearch-provider-runtime.js";
import { createRuntimeMeilisearchTransport } from
  "../infrastructure/meilisearch/runtime-meilisearch-transport.js";
import { createOpenSearchClient } from
  "../infrastructure/opensearch/opensearch-client.js";
import type { OpenSearchClientPort } from
  "../infrastructure/opensearch/opensearch-client-port.js";
import { createOpenSearchProviderRuntime } from
  "../infrastructure/opensearch/opensearch-provider-runtime.js";
import { createOpenSearchQueryPort } from
  "../infrastructure/opensearch/opensearch-query-runtime.js";
import type { RuntimeSearchSettings } from
  "../runtime-settings/types.js";
import type { SearchStartupConfig } from "./search-config.js";

type ProviderInput = {
  config: SearchStartupConfig;
  settings: RuntimeSearchSettings;
  indexDefinition: SearchProviderIndexDefinition;
  tokenizer?: LexicalTokenizer;
};

type SelectedProviderFactories = {
  meilisearch(input: ProviderInput & {
    config: Extract<SearchStartupConfig, { provider: "meilisearch" }>;
  }): SearchProviderRuntime;
  opensearch(input: ProviderInput & {
    config: Extract<SearchStartupConfig, { provider: "opensearch" }>;
    tokenizer: LexicalTokenizer;
  }): SearchProviderRuntime;
};

const DEFAULT_FACTORIES: SelectedProviderFactories = {
  meilisearch(input) {
    return createMeilisearchProviderRuntime(createRuntimeMeilisearchTransport(
      input.config,
      {
        timeoutMs: input.settings.requestTimeoutMs,
        maxAttempts: input.settings.maxAttempts,
        retryDelayMs: input.settings.retryDelayMs
      }
    ));
  },
  opensearch(input) {
    const client = createOpenSearchClient({
      config: input.config,
      requestTimeoutMs: input.settings.requestTimeoutMs,
      maxAttempts: input.settings.maxAttempts
    }) as unknown as OpenSearchClientPort;
    const query = createOpenSearchQueryPort({
      client,
      tokenizer: input.tokenizer,
      maximumResultWindow: input.indexDefinition.maximumTotalHits,
      engineSearchCutoffMs: input.settings.engineSearchCutoffMs
    });
    return createOpenSearchProviderRuntime({
      client,
      tokenizer: input.tokenizer,
      query,
      bulkLimits: {
        maximumDocuments: input.settings.indexBatchDocumentCount,
        maximumBytes: input.settings.indexBatchCompressedBytes,
        maximumInFlight: input.settings.maxInFlightTasks,
        maximumAttempts: input.settings.maxAttempts,
        retryDelayMs: input.settings.retryDelayMs,
        deadlineMs: input.settings.taskTimeoutMs
      },
      visibility: {
        pollIntervalMs: input.settings.taskPollIntervalMs,
        deadlineMs: input.settings.taskTimeoutMs
      }
    });
  }
};

export function createRuntimeSearchProvider(
  input: ProviderInput,
  factories: SelectedProviderFactories = DEFAULT_FACTORIES
): SearchProviderRuntime {
  if (input.config.provider === "meilisearch") {
    return factories.meilisearch({ ...input, config: input.config });
  }
  if (!input.tokenizer?.contractVersion) {
    throw new Error("OpenSearch requires the shared lexical tokenizer");
  }
  return factories.opensearch({
    ...input,
    config: input.config,
    tokenizer: input.tokenizer
  });
}

export function createDynamicRuntimeSearchQueryProvider(
  input: {
    config: SearchStartupConfig;
    indexDefinition: SearchProviderIndexDefinition;
    tokenizer?: LexicalTokenizer;
    resolveSettings: () => Promise<RuntimeSearchSettings>;
  },
  factories: SelectedProviderFactories = DEFAULT_FACTORIES
): Pick<SearchProviderRuntime, "kind" | "query" | "close"> {
  if (input.config.provider === "opensearch" && !input.tokenizer?.contractVersion) {
    throw new Error("OpenSearch requires the shared lexical tokenizer");
  }
  type ProviderSlot = {
    key: string;
    provider: SearchProviderRuntime;
    activeQueries: number;
    retired: boolean;
    closePromise: Promise<void> | null;
    closeWaiters: Array<{
      resolve(): void;
      reject(error: unknown): void;
    }>;
  };
  let current: ProviderSlot | null = null;
  return Object.freeze({
    kind: input.config.provider,
    query: {
      async query(request) {
        const settings = await input.resolveSettings();
        const nextKey = JSON.stringify(settings);
        let retiredWithoutQueries: ProviderSlot | null = null;
        if (!current || current.key !== nextKey) {
          const previous = current;
          current = {
            key: nextKey,
            provider: createRuntimeSearchProvider({
              config: input.config,
              settings,
              indexDefinition: input.indexDefinition,
              ...(input.tokenizer ? { tokenizer: input.tokenizer } : {})
            }, factories),
            activeQueries: 0,
            retired: false,
            closePromise: null,
            closeWaiters: []
          };
          if (previous) {
            previous.retired = true;
            if (previous.activeQueries === 0) retiredWithoutQueries = previous;
          }
        }
        const selected = current;
        selected.activeQueries += 1;
        try {
          if (retiredWithoutQueries) await closeSlot(retiredWithoutQueries);
          return await selected.provider.query.query(request);
        } finally {
          selected.activeQueries -= 1;
          if (selected.retired && selected.activeQueries === 0) {
            await closeSlot(selected);
          }
        }
      }
    },
    async close() {
      const selected = current;
      current = null;
      if (!selected) return;
      selected.retired = true;
      if (selected.activeQueries === 0) {
        await closeSlot(selected);
        return;
      }
      await new Promise<void>((resolve, reject) => {
        selected.closeWaiters.push({ resolve, reject });
      });
    }
  });

  function closeSlot(slot: ProviderSlot): Promise<void> {
    if (!slot.closePromise) {
      slot.closePromise = slot.provider.close();
      void slot.closePromise.then(
        () => settleCloseWaiters(slot),
        (error: unknown) => settleCloseWaiters(slot, error)
      );
    }
    return slot.closePromise;
  }

  function settleCloseWaiters(slot: ProviderSlot, error?: unknown): void {
    const waiters = slot.closeWaiters.splice(0);
    for (const waiter of waiters) {
      if (error === undefined) waiter.resolve();
      else waiter.reject(error);
    }
  }
}
