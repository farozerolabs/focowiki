import { describe, expect, it, vi } from "vitest";

import {
  RerankerTransportError,
  createOpenAiCompatibleRerankerTransport
} from "../src/semantic/reranker/openai-compatible-transport.js";

describe("provider-neutral reranker transport", () => {
  it("sends one bounded ordered request and validates complete normalized scores", async () => {
    const onFailure = vi.fn();
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://reranker.example/v1/rerank");
      expect(init?.headers).toMatchObject({
        authorization: "Bearer reranker-secret",
        "content-type": "application/json"
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "rerank-model",
        query: "Which policy is current?",
        documents: ["First source", "Second source"],
        top_n: 2
      });
      return new Response(JSON.stringify({
        results: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.4 }
        ]
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const transport = createOpenAiCompatibleRerankerTransport({
      fetchImpl: fetchImpl as typeof fetch,
      maximumPayloadBytes: 8_192,
      maximumResponseBytes: 8_192,
      onFailure
    });

    await expect(transport.rerank(request())).resolves.toEqual({
      scores: [0.4, 0.9]
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("supports explicitly unauthenticated local endpoints", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).not.toHaveProperty("authorization");
      return new Response(JSON.stringify({
        results: [{ index: 0, relevance_score: 0.5 }]
      }), { status: 200 });
    });
    const transport = createOpenAiCompatibleRerankerTransport({
      fetchImpl: fetchImpl as typeof fetch
    });
    await transport.rerank({
      ...request(),
      baseUrl: "http://127.0.0.1:11434/v1/",
      authenticationMode: "none",
      apiKey: null,
      documents: ["First source"]
    });
  });

  it("appends exactly one rerank segment after trailing base URL separators", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe("https://reranker.example/v1/rerank");
      return new Response(JSON.stringify({
        results: [
          { index: 0, relevance_score: 0.5 },
          { index: 1, relevance_score: 0.4 }
        ]
      }), { status: 200 });
    });
    const transport = createOpenAiCompatibleRerankerTransport({
      fetchImpl: fetchImpl as typeof fetch
    });

    await transport.rerank({ ...request(), baseUrl: "https://reranker.example/v1///" });
  });

  it.each([
    [{ results: [{ index: 0, relevance_score: 0.5 }] }, "missing score"],
    [{ results: [
      { index: 0, relevance_score: 0.5 },
      { index: 0, relevance_score: 0.4 }
    ] }, "duplicate score"],
    [{ results: [
      { index: 0, relevance_score: 0.5 },
      { index: 2, relevance_score: 0.4 }
    ] }, "foreign score"],
    [{ results: [
      { index: 0, relevance_score: -0.1 },
      { index: 1, relevance_score: 0.4 }
    ] }, "negative score"],
    [{ results: [
      { index: 0, relevance_score: 0.5 },
      { index: 1, relevance_score: 1.1 }
    ] }, "oversized score"]
  ])("rejects a %s response atomically", async (payload) => {
    const transport = createOpenAiCompatibleRerankerTransport({
      fetchImpl: vi.fn(async () => new Response(
        JSON.stringify(payload), { status: 200 }
      )) as unknown as typeof fetch
    });
    await expect(transport.rerank(request())).rejects.toBeInstanceOf(
      RerankerTransportError
    );
  });

  it("rejects oversized input before fetch", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true
        });
      });
      return new Response();
    });
    const transport = createOpenAiCompatibleRerankerTransport({
      fetchImpl: fetchImpl as typeof fetch,
      maximumPayloadBytes: 64
    });
    await expect(transport.rerank({
      ...request(), documents: ["x".repeat(1_000)]
    })).rejects.toMatchObject({ code: "payload_too_large" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a reranker transport deadline to timeout", async () => {
    const timeoutTransport = createOpenAiCompatibleRerankerTransport({
      fetchImpl: hangingFetch()
    });
    await expect(timeoutTransport.rerank({
      ...request(), timeoutMs: 100
    })).rejects.toMatchObject({ code: "timeout" });
  });

  it("classifies reranker HTTP 429 as retryable rate limiting", async () => {
    const transport = createOpenAiCompatibleRerankerTransport({
      fetchImpl: vi.fn(async () => new Response(null, { status: 429 }))
    });
    await expect(transport.rerank(request())).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true
    });
  });

  it("classifies reranker HTTP 503 as retryable unavailability", async () => {
    const transport = createOpenAiCompatibleRerankerTransport({
      fetchImpl: vi.fn(async () => new Response(null, { status: 503 }))
    });
    await expect(transport.rerank(request())).rejects.toMatchObject({
      code: "provider_unavailable",
      retryable: true
    });
  });

  it("classifies reranker HTTP 400 as a non-retryable invalid request", async () => {
    const transport = createOpenAiCompatibleRerankerTransport({
      fetchImpl: vi.fn(async () => new Response(null, { status: 400 }))
    });
    await expect(transport.rerank(request())).rejects.toMatchObject({
      code: "invalid_request",
      retryable: false
    });
  });

  it("reports a sanitized reranker provider failure response", async () => {
    const onFailure = vi.fn();
    const transport = createOpenAiCompatibleRerankerTransport({
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        error: {
          type: "validation_error",
          code: "documents_invalid",
          param: "documents",
          message: "Documents are invalid; api_key=reranker-secret"
        }
      }), {
        status: 422,
        headers: {
          "content-type": "application/json",
          "x-request-id": "reranker-request-123"
        }
      })) as unknown as typeof fetch,
      onFailure
    });

    await expect(transport.rerank(request())).rejects.toMatchObject({
      code: "invalid_request"
    });
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
      providerKind: "reranker",
      apiMode: "rerank",
      providerHost: "reranker.example",
      providerRoute: "/v1/rerank",
      modelName: "rerank-model",
      httpStatusCode: 422,
      providerRequestId: "reranker-request-123",
      providerErrorType: "validation_error",
      providerErrorCode: "documents_invalid",
      providerErrorParam: "documents",
      errorMessage: "Documents are invalid; api_key=<redacted>"
    }));
    expect(JSON.stringify(onFailure.mock.calls)).not.toContain("reranker-secret");
  });

  it("reports an invalid successful reranker response without logging documents", async () => {
    const onFailure = vi.fn();
    const fetchImpl = vi.fn(async () => Response.json({
      results: [{ index: 0, relevance_score: 2 }]
    }, { headers: { "x-request-id": "reranker-invalid-123" } })) as unknown as typeof fetch;
    const transport = createOpenAiCompatibleRerankerTransport({
      fetchImpl,
      onFailure
    });

    await expect(transport.rerank({
      ...request(),
      documents: ["private-document-marker"]
    })).rejects.toMatchObject({ code: "invalid_response" });
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
      httpStatusCode: 200,
      providerRequestId: "reranker-invalid-123",
      errorClass: "RerankerTransportError",
      errorMessage: "Reranker transport failed: invalid_response"
    }));
    expect(JSON.stringify(onFailure.mock.calls)).not.toContain(
      "private-document-marker"
    );
  });

  it("maps caller reranker cancellation to aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = createOpenAiCompatibleRerankerTransport({
      fetchImpl: hangingFetch()
    });
    await expect(transport.rerank({
      ...request(), signal: controller.signal
    })).rejects.toMatchObject({ code: "aborted" });
  });
});

function hangingFetch(): typeof fetch {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    await new Promise<void>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
        once: true
      });
    });
    return new Response();
  }) as unknown as typeof fetch;
}

function request() {
  return {
    baseUrl: "https://reranker.example/v1",
    authenticationMode: "api_key" as const,
    apiKey: "reranker-secret",
    modelName: "rerank-model",
    query: "Which policy is current?",
    documents: ["First source", "Second source"],
    timeoutMs: 1_000,
    signal: null
  };
}
