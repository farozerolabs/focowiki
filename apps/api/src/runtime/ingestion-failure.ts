import { createRuntimeErrorDiagnostics } from "./error-diagnostics.js";

export type IngestionFailureFields = Readonly<{
  stage: string;
  errorCode: string;
  errorClass: string;
  errorMessage: string;
  httpStatusCode: number | null;
  requestId: string | null;
  retryable: boolean | null;
  attemptCount: number | null;
  knowledgeBaseId: string | null;
  documentJobPublicId: string | null;
  workPublicId: string | null;
  scopePublicId: string | null;
  uploadSessionId: string | null;
}>;

export function createIngestionFailureFields(input: {
  stage: string;
  error: unknown;
  errorCode?: string | null;
  retryable?: boolean | null;
  attemptCount?: number | null;
  knowledgeBaseId?: string | null;
  documentJobPublicId?: string | null;
  workPublicId?: string | null;
  scopePublicId?: string | null;
  uploadSessionId?: string | null;
}): IngestionFailureFields {
  const diagnostic = createRuntimeErrorDiagnostics(input.error);
  return Object.freeze({
    stage: safeIdentifier(input.stage, "unknown"),
    errorCode: safeIdentifier(
      input.errorCode ?? diagnostic.errorCode,
      "INGESTION_FAILED"
    ),
    errorClass: diagnostic.errorClass,
    errorMessage: diagnostic.errorMessage,
    httpStatusCode: diagnostic.httpStatusCode,
    requestId: diagnostic.requestId,
    retryable: input.retryable ?? null,
    attemptCount: safeMetric(input.attemptCount),
    knowledgeBaseId: safeIdentifier(input.knowledgeBaseId, null),
    documentJobPublicId: safeIdentifier(input.documentJobPublicId, null),
    workPublicId: safeIdentifier(input.workPublicId, null),
    scopePublicId: safeIdentifier(input.scopePublicId, null),
    uploadSessionId: safeIdentifier(input.uploadSessionId, null)
  });
}

function safeIdentifier<T extends string | null>(
  value: unknown,
  fallback: T
): string | T {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(value)
    ? value
    : fallback;
}

function safeMetric(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
}
