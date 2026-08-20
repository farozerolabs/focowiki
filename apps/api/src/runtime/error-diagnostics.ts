import { redactSecrets } from "../errors.js";

export type RuntimeErrorDiagnostics = {
  errorClass: string;
  errorCode: string | null;
  errorMessage: string;
  stack: string | null;
  httpStatusCode: number | null;
  requestId: string | null;
  extendedRequestId: string | null;
  sdkAttempts: number | null;
  sdkRetryDelayMs: number | null;
  causeClass: string | null;
  causeCode: string | null;
  causeMessage: string | null;
};

type ErrorMetadata = {
  httpStatusCode?: unknown;
  requestId?: unknown;
  extendedRequestId?: unknown;
  cfId?: unknown;
  attempts?: unknown;
  totalRetryDelay?: unknown;
};

export function createRuntimeErrorDiagnostics(error: unknown): RuntimeErrorDiagnostics {
  const record = isRecord(error) ? error : {};
  const providerError = isRecord(record.error) ? record.error : {};
  const metadata = isRecord(record.$metadata) ? record.$metadata as ErrorMetadata : {};
  const cause = isRecord(record.cause) ? record.cause : null;
  const errorClass = safeIdentifier(
    error instanceof Error ? error.name : record.name,
    "UnknownError"
  );
  const errorCode = safeIdentifier(
    providerError.code ?? record.code ?? record.reason,
    null
  );
  const errorMessage = sanitizeDiagnosticText(
    typeof providerError.message === "string"
      ? providerError.message
      : error instanceof Error ? error.message : String(error)
  );
  const headers = readHeaders(record.headers);

  return {
    errorClass,
    errorCode,
    errorMessage,
    stack: error instanceof Error && error.stack
      ? sanitizeDiagnosticText(error.stack)
      : null,
    httpStatusCode: safeInteger(
      metadata.httpStatusCode ?? record.status ?? record.statusCode,
      100,
      599
    ),
    requestId: safeIdentifier(
      metadata.requestId
        ?? record.request_id
        ?? record.requestId
        ?? headers?.get("x-request-id")
        ?? headers?.get("request-id"),
      null
    ),
    extendedRequestId: safeIdentifier(metadata.extendedRequestId ?? metadata.cfId, null),
    sdkAttempts: safeInteger(metadata.attempts, 0, 1_000),
    sdkRetryDelayMs: safeInteger(metadata.totalRetryDelay, 0, 86_400_000),
    causeClass: cause ? safeIdentifier(cause.name, "UnknownError") : null,
    causeCode: cause ? safeIdentifier(cause.code ?? cause.reason, null) : null,
    causeMessage: cause
      ? sanitizeDiagnosticText(
        cause instanceof Error ? cause.message : String(cause.message ?? cause)
      )
      : null
  };
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

export function sanitizeDiagnosticText(value: string): string {
  return redactSecrets(value)
    .replace(/\b(?:postgres(?:ql)?|redis|https?|s3):\/\/[^\s]+/giu, "<redacted-url>")
    .replace(/\bfile:\/\/\/[^\s)]+/giu, "<redacted-path>")
    .replace(
      /\b((?:s3)?object[\s_-]*(?:id|key|checksum)|storage[\s_-]*(?:key|prefix)|bucket(?:[\s_-]*name)?|(?:content|manifest)?checksum(?:[\s_-]*sha256)?|(?:meili(?:search)?[\s_-]*)?index[\s_-]*(?:uid|name)|(?:meili(?:search)?[\s_-]*)?task[\s_-]*(?:uid|name|id)|table[\s_-]*(?:name|id|identifier)|owner[\s_-]*row(?:[\s_-]*id)?|lease(?:[\s_-]*(?:id|token|owner|row))?|(?:legacy[\s_-]*)?generation[\s_-]*(?:details|history|kind|payload|row|state)|predecessor[\s_-]*generation[\s_-]*id|cleanup[\s_-]*(?:action[\s_-]*id|details|object[\s_-]*keys?)|deletion[\s_-]*intent[\s_-]*id)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1=<redacted>"
    )
    .replace(/(['"])\/(?:Users|home|tmp|private|var|opt|usr|dev|etc|Volumes)\/[^'"]+\1/giu, "$1<redacted-path>$1")
    .replace(/(^|[\s'"(:])\/(?:Users|home|tmp|private|var|opt|usr|dev|etc|Volumes)(?:\/[^\s)'":\]]+)+/gimu, "$1<redacted-path>")
    .replace(/(['"])[A-Za-z]:\\[^'"]+\1/gu, "$1<redacted-path>$1")
    .replace(/(^|[\s'"(:])[A-Za-z]:\\(?:[^\s\\]+\\)*[^\s)'":\]]+/gmu, "$1<redacted-path>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 2_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeIdentifier<T extends string | null>(
  value: unknown,
  fallback: T
): string | T {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/u.test(value)) {
    return fallback;
  }
  return value;
}

function safeInteger(
  value: unknown,
  minimum: number,
  maximum: number
): number | null {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    return null;
  }
  return Number(value);
}
