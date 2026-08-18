import type { RerankerAuthenticationMode } from "./configuration.js";

const DEFAULT_MAXIMUM_PAYLOAD_BYTES = 262_144;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 262_144;

export type RerankerTransportRequest = {
  baseUrl: string;
  authenticationMode: RerankerAuthenticationMode;
  apiKey: string | null;
  modelName: string;
  query: string;
  documents: readonly string[];
  timeoutMs: number;
  signal: AbortSignal | null;
};

export type RerankerTransport = {
  rerank(input: RerankerTransportRequest): Promise<{ scores: readonly number[] }>;
};

export type RerankerTransportErrorCode =
  | "aborted" | "authentication_failed" | "invalid_request"
  | "invalid_response" | "payload_too_large" | "provider_unavailable"
  | "rate_limited" | "response_too_large" | "timeout";

export class RerankerTransportError extends Error {
  public constructor(
    public readonly code: RerankerTransportErrorCode,
    public readonly retryable: boolean
  ) {
    super(`Reranker transport failed: ${code}`);
    this.name = "RerankerTransportError";
  }
}

export function createOpenAiCompatibleRerankerTransport(input: {
  fetchImpl?: typeof fetch;
  maximumPayloadBytes?: number;
  maximumResponseBytes?: number;
} = {}): RerankerTransport {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const maximumPayloadBytes = input.maximumPayloadBytes
    ?? DEFAULT_MAXIMUM_PAYLOAD_BYTES;
  const maximumResponseBytes = input.maximumResponseBytes
    ?? DEFAULT_MAXIMUM_RESPONSE_BYTES;
  assertByteBound(maximumPayloadBytes);
  assertByteBound(maximumResponseBytes);
  return {
    async rerank(request) {
      assertRequest(request);
      const body = JSON.stringify({
        model: request.modelName,
        query: request.query,
        documents: request.documents,
        top_n: request.documents.length
      });
      if (Buffer.byteLength(body) > maximumPayloadBytes) {
        throw transportError("payload_too_large", false);
      }
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort("timeout"),
        request.timeoutMs
      );
      timer.unref?.();
      const signal = request.signal
        ? AbortSignal.any([controller.signal, request.signal])
        : controller.signal;
      try {
        const headers: Record<string, string> = {
          "content-type": "application/json",
          accept: "application/json"
        };
        if (request.authenticationMode === "api_key") {
          headers.authorization = `Bearer ${request.apiKey}`;
        }
        const response = await fetchImpl(
          rerankUrl(request.baseUrl),
          {
            method: "POST",
            headers,
            body,
            signal
          }
        );
        if (!response.ok) throw httpError(response.status);
        const declaredBytes = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredBytes) && declaredBytes > maximumResponseBytes) {
          throw transportError("response_too_large", false);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > maximumResponseBytes) {
          throw transportError("response_too_large", false);
        }
        let payload: unknown;
        try {
          payload = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          throw transportError("invalid_response", false);
        }
        return { scores: parseScores(payload, request.documents.length) };
      } catch (error) {
        if (error instanceof RerankerTransportError) throw error;
        if (signal.aborted) {
          throw transportError(request.signal?.aborted ? "aborted" : "timeout", false);
        }
        throw transportError("provider_unavailable", true);
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

function parseScores(payload: unknown, count: number): number[] {
  if (!payload || typeof payload !== "object" || !("results" in payload)) {
    throw transportError("invalid_response", false);
  }
  const results = (payload as { results: unknown }).results;
  if (!Array.isArray(results) || results.length !== count) {
    throw transportError("invalid_response", false);
  }
  const scores = new Array<number>(count);
  for (const item of results) {
    if (!item || typeof item !== "object") {
      throw transportError("invalid_response", false);
    }
    const index = (item as { index?: unknown }).index;
    const score = (item as { relevance_score?: unknown }).relevance_score;
    if (!Number.isSafeInteger(index) || Number(index) < 0 || Number(index) >= count
      || scores[Number(index)] !== undefined
      || typeof score !== "number" || !Number.isFinite(score)
      || score < 0 || score > 1) {
      throw transportError("invalid_response", false);
    }
    scores[Number(index)] = score;
  }
  if (scores.some((score) => score === undefined)) {
    throw transportError("invalid_response", false);
  }
  return scores;
}

function assertRequest(input: RerankerTransportRequest): void {
  if (!input.baseUrl || !input.modelName || !input.query
    || input.documents.length < 1 || input.documents.length > 50
    || input.documents.some((document) => !document)
    || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100
    || input.authenticationMode === "api_key" && !input.apiKey
    || input.authenticationMode === "none" && input.apiKey !== null) {
    throw transportError("invalid_request", false);
  }
}

function rerankUrl(value: string): URL {
  const url = new URL(value);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/rerank`;
  return url;
}

function assertByteBound(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 67_108_864) {
    throw new Error("Reranker transport byte bound is invalid");
  }
}

function httpError(status: number): RerankerTransportError {
  if (status === 401 || status === 403) {
    return transportError("authentication_failed", false);
  }
  if (status === 429) return transportError("rate_limited", true);
  if (status >= 500) return transportError("provider_unavailable", true);
  return transportError("invalid_request", false);
}

function transportError(
  code: RerankerTransportErrorCode,
  retryable: boolean
): RerankerTransportError {
  return new RerankerTransportError(code, retryable);
}
