import { sanitizeDiagnosticText } from "../runtime/error-diagnostics.js";
import type { ModelProviderObservation, OpenAIModelClient } from "@focowiki/okf";

const MAXIMUM_PROVIDER_ERROR_BYTES = 65_536;
const reportedFailures = new WeakSet<object>();

export type ProviderRequestKind = "generation" | "embedding" | "reranker";

export type ProviderRequestFailureDiagnostic = Readonly<{
  providerKind: ProviderRequestKind;
  apiMode: "responses" | "chat_completions" | "embeddings" | "rerank";
  providerHost: string | null;
  providerRoute: string | null;
  modelName: string;
  httpStatusCode: number | null;
  providerRequestId: string | null;
  providerRetryAfter: string | null;
  providerErrorType: string | null;
  providerErrorCode: string | null;
  providerErrorParam: string | null;
  providerFinishState: string | null;
  errorClass: string;
  errorMessage: string;
}>;

export type ProviderRequestFailureReporter = (
  diagnostic: ProviderRequestFailureDiagnostic
) => void;

type ProviderContext = Pick<
  ProviderRequestFailureDiagnostic,
  "providerKind" | "apiMode" | "modelName"
> & { baseUrl?: string | null };

export async function providerFailureFromResponse(
  context: ProviderContext,
  response: Response
): Promise<ProviderRequestFailureDiagnostic> {
  const payload = await readBoundedErrorPayload(response);
  return buildProviderFailureDiagnostic(context, {
    error: payload,
    httpStatusCode: response.status,
    providerRequestId: readRequestId(response.headers),
    providerRetryAfter: response.headers.get("retry-after")
  });
}

export function providerFailureFromError(
  context: ProviderContext,
  error: unknown,
  response?: Response | null
): ProviderRequestFailureDiagnostic {
  return buildProviderFailureDiagnostic(context, {
    error,
    ...(response
      ? {
          httpStatusCode: response.status,
          providerRequestId: readRequestId(response.headers),
          providerRetryAfter: response.headers.get("retry-after")
        }
      : {})
  });
}

export function reportProviderFailureOnce(
  reporter: ProviderRequestFailureReporter | undefined,
  diagnostic: ProviderRequestFailureDiagnostic,
  identity?: unknown
): void {
  if (!reporter) return;
  const objectIdentity = identity !== null && typeof identity === "object"
    ? identity
    : null;
  if (objectIdentity && reportedFailures.has(objectIdentity)) return;
  if (objectIdentity) reportedFailures.add(objectIdentity);
  try {
    reporter(diagnostic);
  } catch {
    // Diagnostic logging must never change provider request behavior.
  }
}

export function providerFailureFromModelObservation(
  context: { baseUrl?: string | null; modelName: string },
  observation: ModelProviderObservation
): ProviderRequestFailureDiagnostic {
  return buildProviderFailureDiagnostic({
    providerKind: "generation",
    apiMode: observation.apiMode,
    modelName: context.modelName,
    ...(context.baseUrl === undefined ? {} : { baseUrl: context.baseUrl })
  }, {
    error: {
      type: observation.errorClass,
      code: observation.finishState ?? observation.errorClass,
      message: observation.finishState
        ? `Provider response was classified as ${observation.errorClass}: ${observation.finishState}`
        : `Provider response was classified as ${observation.errorClass}`
    },
    providerRequestId: observation.requestId
  });
}

export function reportModelObservationFailure(
  reporter: ProviderRequestFailureReporter | undefined,
  modelName: string,
  observation: ModelProviderObservation
): void {
  if (observation.errorClass === "none"
    || observation.errorClass === "provider"
    || observation.errorClass === "transient") return;
  reportProviderFailureOnce(
    reporter,
    providerFailureFromModelObservation({ modelName }, observation),
    observation
  );
}

export function createModelObservationCollector(
  observations: ModelProviderObservation[],
  reporter: ProviderRequestFailureReporter | undefined,
  modelName: string
): (observation: ModelProviderObservation) => void {
  return (observation) => {
    observations.push(observation);
    reportModelObservationFailure(reporter, modelName, observation);
  };
}

export function withProviderFailureReporting(
  client: OpenAIModelClient,
  context: {
    apiMode: "responses" | "chat_completions";
    baseUrl: string;
    modelName: string;
  },
  reporter: ProviderRequestFailureReporter | undefined
): OpenAIModelClient {
  if (!reporter) return client;
  if (client.apiMode === "chat_completions") {
    return {
      apiMode: "chat_completions",
      get structuredOutputCapability() {
        return client.structuredOutputCapability ?? "native_json_schema";
      },
      chat: {
        completions: {
          async create(request, options) {
            try {
              return await client.chat.completions.create(request, options);
            } catch (error) {
              reportProviderFailureOnce(reporter, providerFailureFromError({
                providerKind: "generation",
                apiMode: context.apiMode,
                baseUrl: context.baseUrl,
                modelName: context.modelName
              }, error), error);
              throw error;
            }
          }
        }
      }
    };
  }
  return {
    apiMode: "responses",
    responses: {
      async create(request, options) {
        try {
          return await client.responses.create(request, options);
        } catch (error) {
          reportProviderFailureOnce(reporter, providerFailureFromError({
            providerKind: "generation",
            apiMode: context.apiMode,
            baseUrl: context.baseUrl,
            modelName: context.modelName
          }, error), error);
          throw error;
        }
      }
    }
  };
}

function buildProviderFailureDiagnostic(
  context: ProviderContext,
  input: {
    error: unknown;
    httpStatusCode?: number | null;
    providerRequestId?: string | null;
    providerRetryAfter?: string | null;
  }
): ProviderRequestFailureDiagnostic {
  const record = object(input.error);
  const nested = object(record?.error) ?? record;
  const endpoint = safeEndpoint(context.baseUrl);
  const status = safeStatus(input.httpStatusCode)
    ?? safeStatus(record?.status)
    ?? safeStatus(record?.statusCode);
  const headers = readHeaders(record?.headers);
  const requestId = safeText(
    input.providerRequestId
      ?? record?.request_id
      ?? record?.requestId
      ?? nested?.request_id
      ?? nested?.requestId
      ?? readRequestId(headers),
    256
  );
  const message = readErrorMessage(input.error, nested);
  return Object.freeze({
    providerKind: context.providerKind,
    apiMode: context.apiMode,
    providerHost: endpoint.host,
    providerRoute: endpoint.route,
    modelName: safeText(context.modelName, 256) ?? "unknown",
    httpStatusCode: status,
    providerRequestId: requestId,
    providerRetryAfter: safeText(
      input.providerRetryAfter ?? headers?.get("retry-after"),
      128
    ),
    providerErrorType: safeIdentifier(nested?.type ?? record?.type),
    providerErrorCode: safeIdentifier(nested?.code ?? record?.code),
    providerErrorParam: safeIdentifier(nested?.param ?? record?.param),
    providerFinishState: safeIdentifier(
      nested?.finish_reason ?? nested?.finishState ?? record?.status
    ),
    errorClass: safeIdentifier(
      input.error instanceof Error ? input.error.name : record?.name
    ) ?? "ProviderError",
    errorMessage: sanitizeProviderMessage(message)
  });
}

async function readBoundedErrorPayload(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAXIMUM_PROVIDER_ERROR_BYTES) {
    return { message: "Provider error response exceeded the diagnostic byte limit" };
  }
  try {
    const body = response.clone().body;
    if (!body) return null;
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let byteCount = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      byteCount += result.value.byteLength;
      if (byteCount > MAXIMUM_PROVIDER_ERROR_BYTES) {
        await reader.cancel();
        return { message: "Provider error response exceeded the diagnostic byte limit" };
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(byteCount);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { message: text };
    }
  } catch {
    return { message: "Provider error response could not be read" };
  }
}

function readErrorMessage(error: unknown, nested: Record<string, unknown> | null): string {
  const value = nested?.message
    ?? nested?.detail
    ?? nested?.error_description
    ?? (error instanceof Error ? error.message : null);
  if (typeof value === "string" && value.trim()) return value;
  return "Provider request failed";
}

function sanitizeProviderMessage(value: string): string {
  return sanitizeDiagnosticText(value)
    .replace(
      /\b(api[_ -]?key|access[_ -]?token|authorization)\s*[:=]\s*(?:bearer\s+)?[^\s,;\]}]+/giu,
      "$1=<redacted>"
    )
    .slice(0, 2_000);
}

function safeEndpoint(value: string | null | undefined): {
  host: string | null;
  route: string | null;
} {
  if (!value) return { host: null, route: null };
  try {
    const url = new URL(value);
    return {
      host: safeText(url.host, 256),
      route: safeText(url.pathname || "/", 512)
    };
  } catch {
    return { host: null, route: null };
  }
}

function readRequestId(headers: Headers | null): string | null {
  if (!headers) return null;
  for (const name of [
    "x-request-id",
    "request-id",
    "x-amzn-requestid",
    "x-amz-request-id",
    "cf-ray"
  ]) {
    const value = headers.get(name);
    if (value) return value;
  }
  return null;
}

function readHeaders(value: unknown): Headers | null {
  if (value instanceof Headers) return value;
  if (!value || typeof value !== "object") return null;
  try {
    return new Headers(value as HeadersInit);
  } catch {
    return null;
  }
}

function safeIdentifier(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._:/-]{1,256}$/u.test(value)
    ? value
    : null;
}

function safeText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return sanitizeDiagnosticText(value).slice(0, maximum);
}

function safeStatus(value: unknown): number | null {
  const status = Number(value);
  return Number.isSafeInteger(status) && status >= 100 && status <= 599
    ? status
    : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
