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
  const metadata = isRecord(record.$metadata) ? record.$metadata as ErrorMetadata : {};
  const cause = isRecord(record.cause) ? record.cause : null;
  const errorClass = safeIdentifier(
    error instanceof Error ? error.name : record.name,
    "UnknownError"
  );
  const errorCode = safeIdentifier(record.code ?? record.reason, null);
  const errorMessage = sanitizeDiagnosticText(
    error instanceof Error ? error.message : String(error)
  );

  return {
    errorClass,
    errorCode,
    errorMessage,
    stack: error instanceof Error && error.stack
      ? sanitizeDiagnosticText(error.stack)
      : null,
    httpStatusCode: safeInteger(metadata.httpStatusCode, 100, 599),
    requestId: safeIdentifier(metadata.requestId, null),
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

export function sanitizeDiagnosticText(value: string): string {
  return redactSecrets(value)
    .replace(/\b(?:postgres(?:ql)?|redis|https?|s3):\/\/[^\s]+/giu, "<redacted-url>")
    .replace(/\b(?:objectKey|object_key)\s*[:=]\s*[^\s,;]+/giu, "objectKey=<redacted>")
    .replace(/(?:^|\s)(?:\/[A-Za-z0-9._-]+){3,}(?=[:\s)]|$)/gmu, " <redacted-path>")
    .replace(/(?:^|\s)[A-Za-z]:\\(?:[^\s\\]+\\){2,}[^\s]+/gmu, " <redacted-path>")
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
