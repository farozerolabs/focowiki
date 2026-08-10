import type { LexicalTokenizer } from
  "../application/ports/lexical-tokenizer.js";
import type {
  SearchProviderIndexDefinition,
  SearchProviderRuntime,
  SearchProviderVectorPort
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
    tokenizer: LexicalTokenizer;
  }): SearchProviderRuntime;
  opensearch(input: ProviderInput & {
    config: Extract<SearchStartupConfig, { provider: "opensearch" }>;
    tokenizer: LexicalTokenizer;
  }): SearchProviderRuntime;
};

const DEFAULT_FACTORIES: SelectedProviderFactories = {
  meilisearch(input) {
    return createMeilisearchProviderRuntime(
      createRuntimeMeilisearchTransport(input.config, {
        timeoutMs: input.settings.requestTimeoutMs,
        maxAttempts: input.settings.maxAttempts,
        retryDelayMs: input.settings.retryDelayMs
      }),
      input.tokenizer
    );
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
  if (!input.tokenizer?.contractVersion) {
    throw new Error("Search providers require the shared lexical tokenizer");
  }
  if (input.config.provider === "meilisearch") {
    return factories.meilisearch({
      ...input,
      config: input.config,
      tokenizer: input.tokenizer
    });
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
): Pick<SearchProviderRuntime, "kind" | "query" | "close"> & {
  vector: SearchProviderVectorPort;
} {
  if (!input.tokenizer?.contractVersion) {
    throw new Error("Search providers require the shared lexical tokenizer");
  }
  const tokenizer = input.tokenizer;
  type ProviderSlot = {
    key: string;
    provider: SearchProviderRuntime;
    activeOperations: number;
    retired: boolean;
    closePromise: Promise<void> | null;
    closeWaiters: Array<{
      resolve(): void;
      reject(error: unknown): void;
    }>;
  };
  let current: ProviderSlot | null = null;
  const vector: SearchProviderVectorPort = {
    createIndex: (request) => withProvider((provider) =>
      requireVector(provider).createIndex(request)),
    deleteIndex: (request) => withProvider((provider) =>
      requireVector(provider).deleteIndex(request)),
    getIndexDefinition: (request) => withProvider((provider) =>
      requireVector(provider).getIndexDefinition(request)),
    writeDocuments: (request) => withProvider((provider) =>
      requireVector(provider).writeDocuments(request)),
    deleteDocuments: (request) => withProvider((provider) =>
      requireVector(provider).deleteDocuments(request)),
    query: (request) => withProvider((provider) =>
      requireVector(provider).query(request)),
    count: (request) => withProvider((provider) =>
      requireVector(provider).count(request)),
    scan: (request) => withProvider((provider) =>
      requireVector(provider).scan(request)),
    validate: (request) => withProvider((provider) =>
      requireVector(provider).validate(request)),
    activateCandidate: (request) => withProvider((provider) =>
      requireVector(provider).activateCandidate(request)),
    getOperation: (request) => withProvider((provider) =>
      requireVector(provider).getOperation(request)),
    findOperationByCorrelation: (request) => withProvider((provider) =>
      requireVector(provider).findOperationByCorrelation(request))
  };
  return Object.freeze({
    kind: input.config.provider,
    query: {
      query: (request) => withProvider((provider) => provider.query.query(request))
    },
    vector,
    async close() {
      const selected = current;
      current = null;
      if (!selected) return;
      selected.retired = true;
      if (selected.activeOperations === 0) {
        await closeSlot(selected);
        return;
      }
      await new Promise<void>((resolve, reject) => {
        selected.closeWaiters.push({ resolve, reject });
      });
    }
  });

  async function withProvider<TResult>(
    operation: (provider: SearchProviderRuntime) => Promise<TResult>
  ): Promise<TResult> {
    const settings = await input.resolveSettings();
    const nextKey = JSON.stringify(settings);
    let retiredWithoutOperations: ProviderSlot | null = null;
    if (!current || current.key !== nextKey) {
      const previous = current;
      current = {
        key: nextKey,
        provider: createRuntimeSearchProvider({
          config: input.config,
          settings,
          indexDefinition: input.indexDefinition,
          tokenizer
        }, factories),
        activeOperations: 0,
        retired: false,
        closePromise: null,
        closeWaiters: []
      };
      if (previous) {
        previous.retired = true;
        if (previous.activeOperations === 0) retiredWithoutOperations = previous;
      }
    }
    const selected = current;
    selected.activeOperations += 1;
    try {
      if (retiredWithoutOperations) await closeSlot(retiredWithoutOperations);
      return await operation(selected.provider);
    } finally {
      selected.activeOperations -= 1;
      if (selected.retired && selected.activeOperations === 0) {
        await closeSlot(selected);
      }
    }
  }

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

function requireVector(provider: SearchProviderRuntime): SearchProviderVectorPort {
  if (!provider.vector) throw new Error("Search provider vector capability is unavailable");
  return provider.vector;
}
