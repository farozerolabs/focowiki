import { describe, expect, it, vi } from "vitest";

import {
  RerankerTransportError,
  createOpenAiCompatibleRerankerTransport
} from "../src/semantic/reranker/openai-compatible-transport.js";

describe("provider-neutral reranker transport", () => {
  it("sends one bounded ordered request and validates complete normalized scores", async () => {
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
      maximumResponseBytes: 8_192
    });

    await expect(transport.rerank(request())).resolves.toEqual({
      scores: [0.4, 0.9]
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
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

  it("rejects oversized input before fetch and maps timeout safely", async () => {
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

    const timeoutTransport = createOpenAiCompatibleRerankerTransport({
      fetchImpl: fetchImpl as typeof fetch
    });
    await expect(timeoutTransport.rerank({
      ...request(), timeoutMs: 100
    })).rejects.toMatchObject({ code: "timeout" });
  });
});

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
