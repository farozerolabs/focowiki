import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRuntimeMeilisearchTransportConfig
} from "../src/infrastructure/meilisearch/runtime-meilisearch-transport.js";

const rootDir = resolve(import.meta.dirname, "../../..");

describe("runtime Meilisearch transport", () => {
  it("always includes the diagnostics key in transport configuration", () => {
    expect(createRuntimeMeilisearchTransportConfig(
      {
        provider: "meilisearch",
        endpoint: "http://search.internal:7700",
        apiKey: "scoped-runtime-key",
        metricsApiKey: "global-diagnostics-key",
        indexPrefix: "focowiki"
      },
      {
        timeoutMs: 5_000,
        maxAttempts: 2,
        retryDelayMs: 250
      }
    )).toEqual({
      endpoint: "http://search.internal:7700",
      apiKey: "scoped-runtime-key",
      metricsApiKey: "global-diagnostics-key",
      timeoutMs: 5_000,
      maxAttempts: 2,
      retryDelayMs: 250
    });
  });

  it("keeps every runtime entrypoint behind the selected-provider factory", () => {
    const main = readFileSync(resolve(rootDir, "apps/api/src/main.ts"), "utf8");
    expect(main).toContain("createDynamicRuntimeSearchQueryProvider");
    expect(main).toContain("const searchTokenizer = config.search");
    expect(main).not.toContain('config.search?.provider === "opensearch"');
    const selectedProvider = readFileSync(resolve(
      rootDir,
      "apps/api/src/runtime/search-provider.ts"
    ), "utf8");
    for (const field of ["requestTimeoutMs", "maxAttempts", "retryDelayMs"]) {
      expect(selectedProvider).toContain(`input.settings.${field}`);
    }
    const productionRuntime = readFileSync(resolve(
      rootDir,
      "apps/api/src/document-indexing/infrastructure/production-runtime.ts"
    ), "utf8");
    expect(productionRuntime.match(/createRuntimeSearchProvider\(/gu)).toHaveLength(1);
    const documentProcessor = readFileSync(resolve(
      rootDir,
      "apps/api/src/document-indexing/infrastructure/production-document-fixed-processor.ts"
    ), "utf8");
    const backgroundRuntime = readFileSync(resolve(
      rootDir,
      "apps/api/src/document-indexing/infrastructure/production-background-runtime.ts"
    ), "utf8");
    expect(documentProcessor).toContain("searchProvider:");
    expect(backgroundRuntime).toContain("searchProvider:");
    expect(`${documentProcessor}\n${backgroundRuntime}`).not.toContain(
      "createRuntimeSearchProvider("
    );
    expect(`${documentProcessor}\n${backgroundRuntime}`)
      .not.toMatch(/infrastructure\/(?:meilisearch|opensearch)/u);
    expect(selectedProvider).toContain("createRuntimeMeilisearchTransport");
    expect(selectedProvider).toContain("createOpenSearchClient");
  });
});
