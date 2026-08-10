import { describe, expect, it, vi } from "vitest";
import {
  EmbeddingTransportError,
  createOpenAiCompatibleEmbeddingTransport
} from "../src/semantic/embedding/openai-compatible-transport.js";

describe("OpenAI-compatible embedding transport", () => {
  it("sends bounded authenticated batches and validates finite dimensions", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization"))
        .toBe("Bearer embedding-secret");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "embedding-model",
        input: ["alpha", "beta"],
        dimensions: 3
      });
      return Response.json({
        data: [
          { index: 0, embedding: [1, 0, 0] },
          { index: 1, embedding: [0, 1, 0] }
        ],
        model: "embedding-model",
        usage: { prompt_tokens: 2, total_tokens: 2 }
      });
    });
    const transport = createOpenAiCompatibleEmbeddingTransport({ fetch });
    await expect(transport.embed({
      baseUrl: "https://embedding.example/v1",
      authenticationMode: "api_key",
      apiKey: "embedding-secret",
      modelName: "embedding-model",
      requestedDimension: 3,
      inputs: ["alpha", "beta"],
      timeoutMs: 1_000,
      maximumResponseBytes: 10_000,
      signal: null
    })).resolves.toMatchObject({
      modelName: "embedding-model",
      dimension: 3,
      vectors: [[1, 0, 0], [0, 1, 0]]
    });
  });

  it("omits credentials and dimensions for an unauthenticated endpoint", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "local-embedding",
        input: ["probe"]
      });
      return Response.json({ data: [{ index: 0, embedding: [1, 2] }] });
    });
    const transport = createOpenAiCompatibleEmbeddingTransport({ fetch });
    await expect(transport.embed({
      baseUrl: "http://127.0.0.1:11434/v1",
      authenticationMode: "none",
      apiKey: null,
      modelName: "local-embedding",
      requestedDimension: null,
      inputs: ["probe"],
      timeoutMs: 1_000,
      maximumResponseBytes: 10_000,
      signal: null
    })).resolves.toMatchObject({ dimension: 2 });
  });

  it.each<{
    body: unknown;
    code: string;
    dimension: number | null;
  }>([
    { body: { data: [] }, code: "empty_response", dimension: null },
    {
      body: { data: [{ index: 0, embedding: [1, Number.NaN] }] },
      code: "non_finite_vector",
      dimension: null
    },
    {
      body: { data: [{ index: 0, embedding: [1, 2] }] },
      code: "dimension_mismatch",
      dimension: 3
    },
    {
      body: { data: [{ index: 2, embedding: [1, 2] }] },
      code: "response_mismatch",
      dimension: null
    }
  ])("rejects malformed vector responses with $code", async ({
    body,
    code,
    dimension
  }) => {
    const transport = createOpenAiCompatibleEmbeddingTransport({
      fetch: vi.fn(async () => Response.json(body))
    });
    await expect(transport.embed({
      baseUrl: "https://embedding.example/v1",
      authenticationMode: "none",
      apiKey: null,
      modelName: "embedding-model",
      requestedDimension: dimension,
      inputs: ["probe"],
      timeoutMs: 1_000,
      maximumResponseBytes: 10_000,
      signal: null
    })).rejects.toMatchObject({
      name: EmbeddingTransportError.name,
      code
    });
  });

  it("bounds response bytes and never exposes provider payloads", async () => {
    const secret = "embedding-secret";
    const transport = createOpenAiCompatibleEmbeddingTransport({
      fetch: vi.fn(async () => new Response(JSON.stringify({
        error: { message: secret.repeat(100) }
      }), { status: 500 }))
    });
    let error: unknown;
    try {
      await transport.embed({
        baseUrl: "https://embedding.example/v1",
        authenticationMode: "api_key",
        apiKey: secret,
        modelName: "embedding-model",
        requestedDimension: null,
        inputs: ["probe"],
        timeoutMs: 1_000,
        maximumResponseBytes: 100,
        signal: null
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EmbeddingTransportError);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("distinguishes caller cancellation from transport timeout", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    });
    const transport = createOpenAiCompatibleEmbeddingTransport({ fetch });
    const controller = new AbortController();
    controller.abort();
    await expect(transport.embed({
      baseUrl: "http://127.0.0.1:11434/v1",
      authenticationMode: "none",
      apiKey: null,
      modelName: "local-embedding",
      requestedDimension: null,
      inputs: ["probe"],
      timeoutMs: 1_000,
      maximumResponseBytes: 10_000,
      signal: controller.signal
    })).rejects.toMatchObject({ code: "aborted" });

    await expect(transport.embed({
      baseUrl: "http://127.0.0.1:11434/v1",
      authenticationMode: "none",
      apiKey: null,
      modelName: "local-embedding",
      requestedDimension: null,
      inputs: ["probe"],
      timeoutMs: 100,
      maximumResponseBytes: 10_000,
      signal: null
    })).rejects.toMatchObject({ code: "timeout" });
  });
});
