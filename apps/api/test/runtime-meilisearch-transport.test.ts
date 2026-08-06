import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createDynamicRuntimeMeilisearchSearchTransport,
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

  it("recreates the live search transport only when saved settings change", async () => {
    let options = { timeoutMs: 3_000, maxAttempts: 5, retryDelayMs: 2_000 };
    const search = vi.fn(async () => ({
      hits: [],
      estimatedTotalHits: 0,
      processingTimeMs: 1
    }));
    const createTransport = vi.fn(() => ({ search }) as never);
    const transport = createDynamicRuntimeMeilisearchSearchTransport(
      {
        endpoint: "http://search.internal:7700",
        apiKey: "scoped-runtime-key",
        metricsApiKey: "global-diagnostics-key",
        indexPrefix: "focowiki"
      },
      async () => options,
      { createTransport }
    );

    await transport.search({} as never);
    await transport.search({} as never);
    options = { timeoutMs: 4_000, maxAttempts: 6, retryDelayMs: 3_000 };
    await transport.search({} as never);

    expect(createTransport).toHaveBeenCalledTimes(2);
    expect(createTransport).toHaveBeenLastCalledWith(
      expect.anything(),
      options
    );
    expect(search).toHaveBeenCalledTimes(3);
  });

  it("keeps every runtime entrypoint behind the diagnostics-aware factory", () => {
    const main = readFileSync(resolve(rootDir, "apps/api/src/main.ts"), "utf8");
    expect(main).toContain("createDynamicRuntimeMeilisearchSearchTransport");
    for (const field of ["requestTimeoutMs", "maxAttempts", "retryDelayMs"]) {
      expect(main).toContain(`snapshot.search.${field}`);
    }
    const sourceWorker = readFileSync(resolve(
      rootDir,
      "apps/api/src/storage-vnext/source-processing/production-runtime.ts"
    ), "utf8");
    expect(sourceWorker).toContain("createDynamicRuntimeMeilisearchSearchTransport");
    for (const path of [
      "apps/api/src/storage-vnext/publication/production-pipeline.ts"
    ]) {
      const source = readFileSync(resolve(rootDir, path), "utf8");
      expect(source).toContain("createRuntimeMeilisearchTransport");
      expect(source).not.toContain("createMeilisearchTransport({");
    }
    expect(readFileSync(resolve(
      rootDir,
      "apps/api/src/storage-vnext/maintenance/production-runtime.ts"
    ), "utf8")).toContain("createStorageVnextProductionPublicationPipeline");
  });
});
