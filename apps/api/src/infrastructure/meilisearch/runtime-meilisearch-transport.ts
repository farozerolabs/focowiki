import type { RuntimeConfig } from "../../config.js";
import type { SearchEngineTransport } from "../../application/ports/search-engine-transport.js";
import {
  createMeilisearchTransport
} from "./meilisearch-transport.js";

type RuntimeSearchConfig = NonNullable<RuntimeConfig["search"]>;

type RuntimeMeilisearchTransportOptions = {
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
};

export function createRuntimeMeilisearchTransportConfig(
  config: RuntimeSearchConfig,
  options: RuntimeMeilisearchTransportOptions
) {
  return {
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    metricsApiKey: config.metricsApiKey,
    ...options
  };
}

export function createRuntimeMeilisearchTransport(
  config: RuntimeSearchConfig,
  options: RuntimeMeilisearchTransportOptions
) {
  return createMeilisearchTransport(
    createRuntimeMeilisearchTransportConfig(config, options)
  );
}

export function createDynamicRuntimeMeilisearchSearchTransport(
  config: RuntimeSearchConfig,
  resolveOptions: () => Promise<RuntimeMeilisearchTransportOptions>,
  dependencies: {
    createTransport?: typeof createRuntimeMeilisearchTransport;
  } = {}
): Pick<SearchEngineTransport, "search"> {
  const createTransport = dependencies.createTransport
    ?? createRuntimeMeilisearchTransport;
  let currentKey = "";
  let currentTransport: SearchEngineTransport | null = null;
  return {
    async search(input) {
      const options = await resolveOptions();
      const nextKey = JSON.stringify(options);
      if (!currentTransport || currentKey !== nextKey) {
        currentTransport = createTransport(config, options);
        currentKey = nextKey;
      }
      return currentTransport.search(input);
    }
  };
}
