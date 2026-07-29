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

  it("keeps every runtime entrypoint behind the diagnostics-aware factory", () => {
    for (const path of [
      "apps/api/src/main.ts",
      "apps/api/src/maintenance-worker-main.ts",
      "apps/api/src/lexical-rebuild-worker-main.ts"
    ]) {
      const source = readFileSync(resolve(rootDir, path), "utf8");
      expect(source).toContain("createRuntimeMeilisearchTransport");
      expect(source).not.toContain("createMeilisearchTransport({");
    }
  });
});
