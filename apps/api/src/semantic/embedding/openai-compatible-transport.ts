import type { EmbeddingAuthenticationMode } from "./configuration.js";
import {
  providerFailureFromError,
  providerFailureFromResponse,
  reportProviderFailureOnce,
  type ProviderRequestFailureReporter
} from "../provider-request-failure.js";

export type EmbeddingTransportRequest = {
  baseUrl: string;
  authenticationMode: EmbeddingAuthenticationMode;
  apiKey: string | null;
  modelName: string;
  requestedDimension: number | null;
  inputs: readonly string[];
  timeoutMs: number;
  maximumResponseBytes: number;
  signal: AbortSignal | null;
};

export type EmbeddingTransportResponse = {
  modelName: string;
  dimension: number;
  vectors: readonly (readonly number[])[];
  inputTokens: number | null;
  totalTokens: number | null;
};

export type EmbeddingTransport = {
  embed(input: EmbeddingTransportRequest): Promise<EmbeddingTransportResponse>;
};

export type EmbeddingTransportErrorCode =
  | "aborted"
  | "authentication_failed"
  | "dimension_mismatch"
  | "empty_response"
  | "invalid_request"
  | "invalid_response"
  | "non_finite_vector"
  | "provider_request_rejected"
  | "provider_unavailable"
  | "rate_limited"
  | "response_mismatch"
  | "response_too_large"
  | "timeout";

export class EmbeddingTransportError extends Error {
  public constructor(
    public readonly code: EmbeddingTransportErrorCode,
    public readonly retryable: boolean
  ) {
    super(`Embedding transport failed: ${code}`);
    this.name = "EmbeddingTransportError";
  }
}

export function createOpenAiCompatibleEmbeddingTransport(input: {
  fetch?: typeof fetch;
  onFailure?: ProviderRequestFailureReporter;
} = {}): EmbeddingTransport {
  const request = input.fetch ?? globalThis.fetch;
  return {
    async embed(transportInput) {
      assertRequest(transportInput);
      const endpoint = new URL("embeddings", withTrailingSlash(transportInput.baseUrl));
      let providerResponse: Response | null = null;
      let failureReported = false;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort("timeout"), transportInput.timeoutMs);
      const signal = transportInput.signal
        ? AbortSignal.any([controller.signal, transportInput.signal])
        : controller.signal;
      try {
        const headers = new Headers({
          "content-type": "application/json",
          accept: "application/json"
        });
        if (transportInput.authenticationMode === "api_key") {
          headers.set("authorization", `Bearer ${transportInput.apiKey}`);
        }
        const body = {
          model: transportInput.modelName,
          input: transportInput.inputs,
          ...(transportInput.requestedDimension === null
            ? {}
            : { dimensions: transportInput.requestedDimension })
        };
        const response = await request(
          endpoint,
          { method: "POST", headers, body: JSON.stringify(body), signal }
        );
        providerResponse = response;
        if (!response.ok) {
          reportProviderFailureOnce(
            input.onFailure,
            await providerFailureFromResponse({
              providerKind: "embedding",
              apiMode: "embeddings",
              baseUrl: endpoint.href,
              modelName: transportInput.modelName
            }, response),
            response
          );
          failureReported = true;
          throw httpError(response.status);
        }
        const declaredBytes = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredBytes) && declaredBytes > transportInput.maximumResponseBytes) {
          throw transportError("response_too_large", false);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > transportInput.maximumResponseBytes) {
          throw transportError("response_too_large", false);
        }
        let payload: unknown;
        try {
          payload = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          throw transportError("invalid_response", false);
        }
        return parseResponse(payload, transportInput);
      } catch (error) {
        if (error instanceof EmbeddingTransportError) {
          if (!failureReported && error.code !== "aborted") {
            reportProviderFailureOnce(input.onFailure, providerFailureFromError({
              providerKind: "embedding",
              apiMode: "embeddings",
              baseUrl: endpoint.href,
              modelName: transportInput.modelName
            }, error, providerResponse), error);
          }
          throw error;
        }
        if (signal.aborted) {
          const normalized = transportError(
            transportInput.signal?.aborted ? "aborted" : "timeout",
            false
          );
          if (normalized.code !== "aborted") {
            reportProviderFailureOnce(input.onFailure, providerFailureFromError({
              providerKind: "embedding",
              apiMode: "embeddings",
              baseUrl: endpoint.href,
              modelName: transportInput.modelName
            }, normalized), error);
          }
          throw normalized;
        }
        const normalized = transportError("provider_unavailable", true);
        reportProviderFailureOnce(input.onFailure, providerFailureFromError({
          providerKind: "embedding",
          apiMode: "embeddings",
          baseUrl: endpoint.href,
          modelName: transportInput.modelName
        }, error), error);
        throw normalized;
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

function parseResponse(
  payload: unknown,
  input: EmbeddingTransportRequest
): EmbeddingTransportResponse {
  if (!payload || typeof payload !== "object" || !("data" in payload)) {
    throw transportError("invalid_response", false);
  }
  const data = (payload as { data: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) {
    throw transportError("empty_response", false);
  }
  if (data.length !== input.inputs.length) {
    throw transportError("response_mismatch", false);
  }
  const sorted = [...data].sort((left, right) => readIndex(left) - readIndex(right));
  const vectors = sorted.map((item, index) => {
    if (readIndex(item) !== index) throw transportError("response_mismatch", false);
    if (!item || typeof item !== "object" || !("embedding" in item)) {
      throw transportError("invalid_response", false);
    }
    const vector = (item as { embedding: unknown }).embedding;
    if (!Array.isArray(vector) || vector.length === 0) {
      throw transportError("empty_response", false);
    }
    if (vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw transportError("non_finite_vector", false);
    }
    return vector as number[];
  });
  const dimension = vectors[0]!.length;
  if (
    vectors.some((vector) => vector.length !== dimension)
    || input.requestedDimension !== null && input.requestedDimension !== dimension
  ) throw transportError("dimension_mismatch", false);
  const record = payload as {
    model?: unknown;
    usage?: { prompt_tokens?: unknown; total_tokens?: unknown };
  };
  return {
    modelName: typeof record.model === "string" ? record.model : input.modelName,
    dimension,
    vectors,
    inputTokens: finiteInteger(record.usage?.prompt_tokens),
    totalTokens: finiteInteger(record.usage?.total_tokens)
  };
}

function assertRequest(input: EmbeddingTransportRequest): void {
  if (
    input.inputs.length < 1
    || input.inputs.length > 2_048
    || input.inputs.some((value) => !value || Buffer.byteLength(value) > 4_194_304)
    || !Number.isSafeInteger(input.timeoutMs)
    || input.timeoutMs < 100
    || !Number.isSafeInteger(input.maximumResponseBytes)
    || input.maximumResponseBytes < 1_024
    || input.authenticationMode === "api_key" && !input.apiKey
    || input.authenticationMode === "none" && input.apiKey !== null
  ) throw transportError("invalid_request", false);
}

function readIndex(value: unknown): number {
  if (!value || typeof value !== "object" || !("index" in value)) return -1;
  const index = (value as { index: unknown }).index;
  return Number.isSafeInteger(index) ? Number(index) : -1;
}

function finiteInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function httpError(status: number): EmbeddingTransportError {
  if (status === 401 || status === 403) return transportError("authentication_failed", false);
  if (status === 429) return transportError("rate_limited", true);
  if (status >= 500) return transportError("provider_unavailable", true);
  return transportError("provider_request_rejected", false);
}

function transportError(
  code: EmbeddingTransportErrorCode,
  retryable: boolean
): EmbeddingTransportError {
  return new EmbeddingTransportError(code, retryable);
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
