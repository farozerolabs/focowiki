import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  SearchEngineTransportError
} from "../src/application/ports/search-engine-transport.js";
import {
  createMeilisearchTransport
} from "../src/infrastructure/meilisearch/meilisearch-transport.js";

describe("Meilisearch transport", () => {
  it("accepts only the supported Meilisearch release line", async () => {
    const supported = createMeilisearchTransport(
      {
        endpoint: "http://search.internal:7700",
        apiKey: "server-secret",
        timeoutMs: 100,
        maxAttempts: 1,
        retryDelayMs: 1
      },
      {
        client: {
          async health() {
            return { status: "available" };
          },
          async getVersion() {
            return {
              commitSha: "test",
              commitDate: "2026-07-29",
              pkgVersion: "1.51.9"
            };
          }
        } as never
      }
    );
    const incompatible = createMeilisearchTransport(
      {
        endpoint: "http://search.internal:7700",
        apiKey: "server-secret",
        timeoutMs: 100,
        maxAttempts: 1,
        retryDelayMs: 1
      },
      {
        client: {
          async health() {
            return { status: "available" };
          },
          async getVersion() {
            return {
              commitSha: "test",
              commitDate: "2026-07-29",
              pkgVersion: "1.50.0"
            };
          }
        } as never
      }
    );

    await expect(supported.health()).resolves.toEqual({ available: true });
    await expect(incompatible.health()).rejects.toMatchObject({
      code: "SEARCH_ENGINE_VERSION_INCOMPATIBLE",
      retryable: false,
      message: "Search service version is incompatible"
    });
  });

  it("uses the diagnostics key for the global version endpoint", async () => {
    const runtimeClient = {
      health: vi.fn(async () => ({ status: "available" }))
    };
    const diagnosticsClient = {
      getVersion: vi.fn(async () => ({
        commitSha: "test",
        commitDate: "2026-07-29",
        pkgVersion: "1.51.0"
      }))
    };
    const transport = createMeilisearchTransport(
      {
        endpoint: "http://search.internal:7700",
        apiKey: "prefix-scoped-runtime-key",
        metricsApiKey: "global-diagnostics-key",
        timeoutMs: 100,
        maxAttempts: 1,
        retryDelayMs: 1
      },
      {
        client: runtimeClient as never,
        diagnosticsClient: diagnosticsClient as never
      }
    );

    await expect(transport.health()).resolves.toEqual({ available: true });
    expect(runtimeClient.health).toHaveBeenCalledOnce();
    expect(diagnosticsClient.getVersion).toHaveBeenCalledOnce();
  });

  it("sends bounded document batches with gzip and safe correlation metadata", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const transport = createMeilisearchTransport(
      {
        endpoint: "http://search.internal:7700",
        apiKey: "server-secret",
        timeoutMs: 1_000,
        maxAttempts: 1,
        retryDelayMs: 1
      },
      {
        fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
          requests.push({ url: String(url), init: init ?? {} });
          return new Response(
            JSON.stringify({
              taskUid: 41,
              indexUid: "content",
              status: "enqueued",
              type: "documentAdditionOrUpdate",
              enqueuedAt: "2026-07-29T00:00:00.000Z"
            }),
            { status: 202, headers: { "content-type": "application/json" } }
          );
        }) as typeof fetch
      }
    );

    const result = await transport.addDocuments({
      indexUid: "content",
      primaryKey: "id",
      documents: [{ id: "segment-1", body: "Markdown body" }],
      correlation: "search-work-41"
    });

    expect(result).toEqual({ taskUid: 41 });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("/indexes/content/documents?");
    expect(requests[0]?.url).toContain("customMetadata=search-work-41");
    const headers = new Headers(requests[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer server-secret");
    expect(headers.get("content-encoding")).toBe("gzip");
    expect(JSON.parse(gunzipSync(requests[0]?.init.body as Uint8Array).toString("utf8")))
      .toEqual([{ id: "segment-1", body: "Markdown body" }]);
  });

  it("retries retryable failures and exposes only stable error details", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED server-secret"))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    const transport = createMeilisearchTransport(
      {
        endpoint: "http://search.internal:7700",
        apiKey: "server-secret",
        timeoutMs: 100,
        maxAttempts: 2,
        retryDelayMs: 1
      },
      {
        fetch,
        sleep: async () => undefined
      }
    );

    await expect(transport.addDocuments({
      indexUid: "content",
      primaryKey: "id",
      documents: [{ id: "segment-1" }],
      correlation: "search-work-42"
    })).rejects.toMatchObject({
      name: "SearchEngineTransportError",
      code: "SEARCH_ENGINE_UNAVAILABLE",
      retryable: true,
      message: "Search service is temporarily unavailable"
    });
    await expect(transport.addDocuments({
      indexUid: "content",
      primaryKey: "id",
      documents: [{ id: "segment-1" }],
      correlation: "search-work-43"
    })).rejects.not.toThrow(/server-secret|search\.internal/u);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("maps task terminal states without treating enqueue as completion", async () => {
    const diagnosticsClient = {
      tasks: {
        async getTask() {
          return {
            uid: 17,
            status: "failed",
            error: { code: "invalid_document", message: "raw engine detail" }
          };
        }
      }
    };
    const transport = createMeilisearchTransport(
      {
        endpoint: "http://search.internal:7700",
        apiKey: "server-secret",
        metricsApiKey: "diagnostics-secret",
        timeoutMs: 100,
        maxAttempts: 1,
        retryDelayMs: 1
      },
      {
        client: {} as never,
        diagnosticsClient: diagnosticsClient as never
      }
    );

    await expect(transport.getTask(17)).resolves.toEqual({
      taskUid: 17,
      status: "failed",
      errorCode: "SEARCH_INDEX_TASK_FAILED"
    });
    expect(SearchEngineTransportError).toBeDefined();
  });

  it("reads global index-swap tasks through the diagnostics client", async () => {
    const runtimeClient = {
      tasks: {
        getTasks: vi.fn()
      }
    };
    const diagnosticsClient = {
      tasks: {
        getTasks: vi.fn(async () => ({
          results: [{
            uid: 29,
            status: "succeeded",
            details: {
              swaps: [{
                indexes: ["focowiki_content_active", "focowiki_content_staging"]
              }]
            }
          }]
        }))
      }
    };
    const transport = createMeilisearchTransport(
      {
        endpoint: "http://search.internal:7700",
        apiKey: "prefix-scoped-runtime-key",
        metricsApiKey: "global-diagnostics-key",
        timeoutMs: 100,
        maxAttempts: 1,
        retryDelayMs: 1
      },
      {
        client: runtimeClient as never,
        diagnosticsClient: diagnosticsClient as never
      }
    );

    await expect(transport.findIndexSwapTask?.({
      pairs: [{
        left: "focowiki_content_active",
        right: "focowiki_content_staging"
      }]
    })).resolves.toEqual({
      taskUid: 29,
      status: "succeeded",
      errorCode: null
    });
    expect(runtimeClient.tasks.getTasks).not.toHaveBeenCalled();
    expect(diagnosticsClient.tasks.getTasks).toHaveBeenCalledOnce();
  });

  it("keeps missing indexes and documents available to idempotent lifecycle logic", async () => {
    const notFound = Object.assign(new Error("not found"), {
      cause: { code: "index_not_found" }
    });
    const documentNotFound = Object.assign(new Error("not found"), {
      cause: { code: "document_not_found" }
    });
    const client = {
      async getRawIndex() {
        throw notFound;
      },
      index() {
        return {
          async getDocument() {
            throw documentNotFound;
          }
        };
      }
    };
    const transport = createMeilisearchTransport(
      {
        endpoint: "http://search.internal:7700",
        apiKey: "server-secret",
        timeoutMs: 100,
        maxAttempts: 1,
        retryDelayMs: 1
      },
      { client: client as never }
    );

    await expect(transport.getIndex({ indexUid: "missing" })).resolves.toBeNull();
    await expect(transport.getDocument({
      indexUid: "content",
      documentId: "missing"
    })).resolves.toBeNull();
  });

  it("maps a missing active search index to retryable unavailability", async () => {
    const notFound = Object.assign(new Error("not found"), {
      cause: { code: "index_not_found" }
    });
    const client = {
      index() {
        return {
          async search() {
            throw notFound;
          }
        };
      }
    };
    const transport = createMeilisearchTransport(
      {
        endpoint: "http://search.internal:7700",
        apiKey: "server-secret",
        timeoutMs: 100,
        maxAttempts: 1,
        retryDelayMs: 1
      },
      { client: client as never }
    );

    await expect(transport.search({
      indexUid: "missing-active-index",
      query: "query",
      filter: 'knowledgeBaseId = "kb-one"',
      limit: 10,
      attributesToRetrieve: ["sourceFileId"],
      attributesToCrop: [],
      cropLength: 1,
      matchingStrategy: "all"
    })).rejects.toMatchObject({
      code: "SEARCH_ENGINE_UNAVAILABLE",
      retryable: true
    });
  });

  it("classifies HTTP 429 as bounded search overload", async () => {
    const client = {
      index() {
        return {
          async search() {
            throw { status: 429 };
          }
        };
      }
    };
    const transport = createMeilisearchTransport(
      {
        endpoint: "http://search.internal:7700",
        apiKey: "server-secret",
        timeoutMs: 100,
        maxAttempts: 1,
        retryDelayMs: 1
      },
      { client: client as never }
    );

    await expect(transport.search({
      indexUid: "content",
      query: "query",
      filter: "visibleFromEpoch <= 1",
      limit: 10,
      attributesToRetrieve: ["sourceFileId"],
      attributesToCrop: [],
      cropLength: 1,
      matchingStrategy: "all"
    })).rejects.toMatchObject({
      code: "SEARCH_ENGINE_OVERLOADED",
      retryable: true
    });
  });

  it("reads bounded indexing pressure from authenticated metrics", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization"))
        .toBe("Bearer metrics-secret");
      return new Response([
        "# HELP meilisearch_db_size_bytes Database size.",
        "meilisearch_db_size_bytes 1048576",
        "meilisearch_task_queue_latency_seconds 2.5",
        "meilisearch_task_queue_used_size 8192",
        "process_resident_memory_bytes 67108864"
      ].join("\n"), {
        status: 200,
        headers: { "content-type": "text/plain; version=0.0.4" }
      });
    });
    const transport = createMeilisearchTransport(
      {
        endpoint: "http://search.internal:7700",
        apiKey: "server-secret",
        metricsApiKey: "metrics-secret",
        timeoutMs: 100,
        maxAttempts: 1,
        retryDelayMs: 1
      },
      { fetch: fetch as typeof globalThis.fetch }
    );

    await expect(transport.getPressure()).resolves.toEqual({
      queueLatencyMs: 2_500,
      residentMemoryBytes: 67_108_864,
      databaseSizeBytes: 1_048_576,
      taskQueueSizeBytes: 8_192
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL("http://search.internal:7700/metrics"),
      expect.objectContaining({ method: "GET" })
    );
  });

  it("fails safely when required pressure metrics are unavailable", async () => {
    const transport = createMeilisearchTransport(
      {
        endpoint: "http://search.internal:7700",
        apiKey: "server-secret",
        timeoutMs: 100,
        maxAttempts: 1,
        retryDelayMs: 1
      },
      {
        fetch: vi.fn(async () => new Response(
          "meilisearch_db_size_bytes 1\n",
          { status: 200 }
        )) as typeof globalThis.fetch
      }
    );

    await expect(transport.getPressure()).rejects.toMatchObject({
      code: "SEARCH_ENGINE_REQUEST_FAILED",
      retryable: false
    });
  });
});
