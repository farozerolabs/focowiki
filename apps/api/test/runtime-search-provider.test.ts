import { describe, expect, it, vi } from "vitest";
import type { LexicalTokenizer } from
  "../src/application/ports/lexical-tokenizer.js";
import type {
  SearchProviderIndexDefinition,
  SearchProviderRuntime,
  SearchProviderVectorPort
} from "../src/application/ports/search-provider-runtime.js";
import type { SearchStartupConfig } from "../src/runtime/search-config.js";
import {
  createDynamicRuntimeSearchQueryProvider,
  createRuntimeSearchProvider
} from "../src/runtime/search-provider.js";
import type { RuntimeSearchSettings } from "../src/runtime-settings/types.js";

describe("runtime search provider selection", () => {
  it("constructs only the selected Meilisearch adapter", () => {
    const meilisearch = vi.fn(() => runtime("meilisearch"));
    const opensearch = vi.fn(() => runtime("opensearch"));

    const selected = createRuntimeSearchProvider({
      config: meilisearchConfig(),
      settings: searchSettings(),
      indexDefinition: definition(),
      tokenizer: tokenizer()
    }, { meilisearch, opensearch });

    expect(selected.kind).toBe("meilisearch");
    expect(meilisearch).toHaveBeenCalledOnce();
    expect(opensearch).not.toHaveBeenCalled();
  });

  it("requires the shared tokenizer for every selected search provider", () => {
    const meilisearch = vi.fn(() => runtime("meilisearch"));
    const opensearch = vi.fn(() => runtime("opensearch"));
    expect(() => createRuntimeSearchProvider({
      config: meilisearchConfig(),
      settings: searchSettings(),
      indexDefinition: definition()
    }, { meilisearch, opensearch })).toThrow();
    expect(() => createRuntimeSearchProvider({
      config: openSearchConfig(),
      settings: searchSettings(),
      indexDefinition: definition()
    }, { meilisearch, opensearch })).toThrow();

    const selected = createRuntimeSearchProvider({
      config: openSearchConfig(),
      settings: searchSettings(),
      indexDefinition: definition(),
      tokenizer: tokenizer()
    }, { meilisearch, opensearch });
    expect(selected.kind).toBe("opensearch");
    expect(opensearch).toHaveBeenCalledOnce();
    expect(meilisearch).not.toHaveBeenCalled();
  });

  it("refreshes dynamic runtime settings without constructing the inactive adapter", async () => {
    const meilisearch = vi.fn(() => runtime("meilisearch"));
    const opensearch = vi.fn(() => runtime("opensearch"));
    let settings = searchSettings();
    const selected = createDynamicRuntimeSearchQueryProvider({
      config: openSearchConfig(),
      tokenizer: tokenizer(),
      indexDefinition: definition(),
      resolveSettings: async () => settings
    }, { meilisearch, opensearch });

    await selected.query.query(queryRequest());
    await selected.query.query(queryRequest());
    expect(opensearch).toHaveBeenCalledOnce();
    settings = { ...settings, requestTimeoutMs: settings.requestTimeoutMs + 1 };
    await selected.query.query(queryRequest());
    expect(opensearch).toHaveBeenCalledTimes(2);
    expect(meilisearch).not.toHaveBeenCalled();
  });

  it("closes retired dynamic providers after in-flight queries finish", async () => {
    let resolveFirst: (() => void) | undefined;
    const firstQuery = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const providers = [
      runtime("opensearch", async () => {
        await firstQuery;
        return queryResult();
      }),
      runtime("opensearch")
    ];
    const opensearch = vi.fn(() => providers.shift()!);
    let settings = searchSettings();
    const selected = createDynamicRuntimeSearchQueryProvider({
      config: openSearchConfig(),
      tokenizer: tokenizer(),
      indexDefinition: definition(),
      resolveSettings: async () => settings
    }, { meilisearch: vi.fn(), opensearch });

    const inFlight = selected.query.query(queryRequest());
    await vi.waitFor(() => expect(opensearch).toHaveBeenCalledOnce());
    settings = { ...settings, requestTimeoutMs: settings.requestTimeoutMs + 1 };
    await selected.query.query(queryRequest());

    expect(providers).toHaveLength(0);
    expect(opensearch.mock.results[0]!.value.close).not.toHaveBeenCalled();
    resolveFirst!();
    await inFlight;
    expect(opensearch.mock.results[0]!.value.close).toHaveBeenCalledOnce();
    expect(opensearch.mock.results[1]!.value.close).not.toHaveBeenCalled();
    await selected.close();
    expect(opensearch.mock.results[1]!.value.close).toHaveBeenCalledOnce();
  });

  it("waits for an active dynamic query before closing its provider", async () => {
    let resolveQuery: (() => void) | undefined;
    const queryPending = new Promise<void>((resolve) => { resolveQuery = resolve; });
    const providerQuery = vi.fn(async () => {
      await queryPending;
      return queryResult();
    });
    const provider = runtime("opensearch", providerQuery);
    const selected = createDynamicRuntimeSearchQueryProvider({
      config: openSearchConfig(),
      tokenizer: tokenizer(),
      indexDefinition: definition(),
      resolveSettings: async () => searchSettings()
    }, { meilisearch: vi.fn(), opensearch: vi.fn(() => provider) });

    const query = selected.query.query(queryRequest());
    await vi.waitFor(() => expect(providerQuery).toHaveBeenCalledOnce());
    const close = selected.close();
    await Promise.resolve();
    expect(provider.close).not.toHaveBeenCalled();
    resolveQuery!();

    await query;
    await close;
    expect(provider.close).toHaveBeenCalledOnce();
  });

  it("exposes the selected provider vector port through the dynamic runtime", async () => {
    const getIndexDefinition = vi.fn(async () => null);
    const provider = runtime("opensearch", undefined, {
      ...vectorPort(),
      getIndexDefinition
    });
    const selected = createDynamicRuntimeSearchQueryProvider({
      config: openSearchConfig(),
      tokenizer: tokenizer(),
      indexDefinition: definition(),
      resolveSettings: async () => searchSettings()
    }, { meilisearch: vi.fn(), opensearch: vi.fn(() => provider) });

    await expect(selected.vector.getIndexDefinition({ indexUid: "semantic-a" }))
      .resolves.toBeNull();
    expect(getIndexDefinition).toHaveBeenCalledOnce();
    await selected.close();
    expect(provider.close).toHaveBeenCalledOnce();
  });

  it.each(searchSettingCases())(
    "refreshes $provider after changing only $field",
    async ({ provider, field }) => {
      const meilisearch = vi.fn(() => runtime("meilisearch"));
      const opensearch = vi.fn(() => runtime("opensearch"));
      let settings = searchSettings();
      const initialValue = settings[field];
      const selected = createDynamicRuntimeSearchQueryProvider({
        config: provider === "meilisearch"
          ? meilisearchConfig()
          : openSearchConfig(),
        tokenizer: tokenizer(),
        indexDefinition: definition(),
        resolveSettings: async () => settings
      }, { meilisearch, opensearch });

      await selected.query.query(queryRequest());
      settings = { ...settings, [field]: initialValue + 1 };
      await selected.query.query(queryRequest());

      const activeFactory = provider === "meilisearch" ? meilisearch : opensearch;
      const inactiveFactory = provider === "meilisearch" ? opensearch : meilisearch;
      expect(activeFactory).toHaveBeenCalledTimes(2);
      const calls = activeFactory.mock.calls as unknown as readonly [
        { settings: RuntimeSearchSettings }
      ][];
      expect(calls[1]?.[0].settings[field]).toBe(initialValue + 1);
      expect(inactiveFactory).not.toHaveBeenCalled();
    }
  );
});

function searchSettingCases(): readonly {
  provider: "meilisearch" | "opensearch";
  field: keyof RuntimeSearchSettings;
}[] {
  const fields: readonly (keyof RuntimeSearchSettings)[] = [
    "requestTimeoutMs",
    "engineSearchCutoffMs",
    "overfetchFactor",
    "indexBatchDocumentCount",
    "indexBatchCompressedBytes",
    "maxInFlightTasks",
    "taskPollIntervalMs",
    "taskTimeoutMs",
    "maxAttempts",
    "retryDelayMs",
    "cleanupBatchSize",
    "cropLength"
  ];
  return (["meilisearch", "opensearch"] as const).flatMap((provider) =>
    fields.map((field) => ({ provider, field }))
  );
}

function runtime(
  kind: "meilisearch" | "opensearch",
  query: SearchProviderRuntime["query"]["query"] = vi.fn(async () => queryResult()),
  vector: SearchProviderVectorPort | undefined = undefined
): SearchProviderRuntime {
  return {
    kind,
    admin: {} as SearchProviderRuntime["admin"],
    write: {} as SearchProviderRuntime["write"],
    query: { query },
    validation: {} as SearchProviderRuntime["validation"],
    operations: {} as SearchProviderRuntime["operations"],
    ...(vector ? { vector } : {}),
    close: vi.fn(async () => undefined)
  };
}

function vectorPort(): SearchProviderVectorPort {
  return {
    createIndex: vi.fn(async () => ({ state: "completed" as const })),
    deleteIndex: vi.fn(async () => ({ state: "completed" as const })),
    getIndexDefinition: vi.fn(async () => null),
    writeDocuments: vi.fn(async () => ({ state: "completed" as const })),
    deleteDocuments: vi.fn(async () => ({ state: "completed" as const })),
    query: vi.fn(async () => ({ hits: [], processingTimeMs: 1 })),
    count: vi.fn(async () => 0),
    scan: vi.fn(async () => ({ documents: [], continuation: null })),
    validate: vi.fn(async () => ({ valid: true, documentCount: 0 })),
    activateCandidate: vi.fn(async () => ({ state: "completed" as const })),
    getOperation: vi.fn(async () => ({ state: "completed" as const })),
    findOperationByCorrelation: vi.fn(async () => null)
  };
}

function queryResult() {
  return { hits: [], continuation: null, processingTimeMs: 1 };
}

function tokenizer(): LexicalTokenizer {
  return {
    contractVersion: "lexical-tokenizer-v1-test",
    tokenizeDocument: vi.fn(() => []),
    tokenizeQuery: vi.fn(() => [])
  };
}

function meilisearchConfig(): SearchStartupConfig {
  return {
    provider: "meilisearch",
    endpoint: "http://127.0.0.1:7700",
    apiKey: "development-key",
    metricsApiKey: "development-key",
    indexPrefix: "focowiki"
  };
}

function openSearchConfig(): SearchStartupConfig {
  return {
    provider: "opensearch",
    endpoint: "http://127.0.0.1:9200",
    indexPrefix: "focowiki",
    auth: { mode: "none" },
    tls: {}
  };
}

function searchSettings(): RuntimeSearchSettings {
  return {
    requestTimeoutMs: 3_000,
    engineSearchCutoffMs: 1_000,
    overfetchFactor: 3,
    indexBatchDocumentCount: 100,
    indexBatchCompressedBytes: 1_000_000,
    maxInFlightTasks: 2,
    taskPollIntervalMs: 500,
    taskTimeoutMs: 60_000,
    maxAttempts: 3,
    retryDelayMs: 100,
    cleanupBatchSize: 100,
    cropLength: 1_200
  };
}

function definition(): SearchProviderIndexDefinition {
  return {
    primaryKey: "id",
    searchableAttributes: ["title", "searchText"],
    filterableAttributes: ["knowledgeBaseId"],
    displayedAttributes: ["id", "title"],
    rankingRules: ["words"],
    distinctAttribute: "sourceFilePublicId",
    maximumTotalHits: 2_000,
    searchCutoffMs: 1_000,
    typoDisabledAttributes: ["logicalPath"]
  };
}

function queryRequest() {
  return {
    indexUid: "focowiki_candidate",
    query: "evidence",
    evidenceFamilies: ["text" as const],
    filters: {
      kind: "equals" as const,
      field: "knowledgeBaseId" as const,
      value: "kb-a"
    },
    searchFields: ["searchText"],
    returnFields: ["id"],
    limit: 10,
    continuation: null,
    cropLength: 100,
    deadlineMs: 1_000,
    matchingStrategy: "all" as const,
    distinctBy: "sourceFilePublicId" as const
  };
}
