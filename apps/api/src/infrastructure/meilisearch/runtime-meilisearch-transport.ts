import type { RuntimeConfig } from "../../config.js";
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
