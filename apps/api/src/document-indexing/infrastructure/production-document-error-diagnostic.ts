import { safeDocumentDiagnosticPath } from
  "../application/document-error-diagnostic-path.js";

export function safeErrorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code : null;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,128}$/u.test(code)
    ? code : "DOCUMENT_PROCESSING_FAILED";
}

export function safeWorkerErrorDiagnostic(error: unknown): {
  errorCode: string;
  errorName: string;
  errorFrame: string | null;
  errorResource: string | null;
  errorTarget: string | null;
} {
  const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/u
    .test(error.name)
    ? error.name
    : "UnknownError";
  const stack = error instanceof Error && typeof error.stack === "string"
    ? error.stack.split("\n").slice(1)
    : [];
  const frame = stack.map((line) => line.trim().match(
    /(?:at\s+.*?\s+\(|at\s+)([^()\s]+:\d+:\d+)\)?$/u
  )?.[1] ?? null).find((value): value is string => value !== null) ?? null;
  const resource = safePathProperty(error, "resourcePath");
  const target = safePathProperty(error, "targetPath");
  return {
    errorCode: safeErrorCode(error),
    errorName,
    errorFrame: frame && frame.length <= 512 ? frame : null,
    errorResource: safeDocumentDiagnosticPath(resource),
    errorTarget: safeDocumentDiagnosticPath(target)
  };
}

export function isRetryable(code: string): boolean {
  return ![
    "source_body_empty", "source_frontmatter_invalid", "source_utf8_invalid",
    "source_size_limit", "invalid_source_contract", "metadata_too_large",
    "document_revision_superseded"
  ].includes(code);
}

export function planDocumentFailureRetry(input: {
  error: unknown;
  attemptCount: number;
  nowMilliseconds?: number;
}): { retryable: boolean; nextAttemptAt: string | null } {
  const code = safeErrorCode(input.error);
  const retryable = isRetryable(code);
  const automaticRetry = retryable && ![
    "generated_root",
    "immutable_bundle_conflict"
  ].includes(code);
  return {
    retryable,
    nextAttemptAt: automaticRetry
      ? new Date((input.nowMilliseconds ?? Date.now())
        + 2_000 * input.attemptCount).toISOString()
      : null
  };
}

function safePathProperty(
  error: unknown,
  property: "resourcePath" | "targetPath"
): string | null {
  if (typeof error !== "object" || error === null || !(property in error)) {
    return null;
  }
  const value = (error as Record<string, unknown>)[property];
  return typeof value === "string" ? value : null;
}
