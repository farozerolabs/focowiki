import type { Context } from "hono";
import { getDeveloperOpenApiRequestId } from "./diagnostic-context.js";

export type DeveloperOpenApiErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "VALIDATION_ERROR"
  | "RATE_LIMITED"
  | "UNSUPPORTED_ROUTE"
  | "INTERNAL_ERROR"
  | "DATABASE_REPOSITORY_UNAVAILABLE";

export class DeveloperOpenApiError extends Error {
  public readonly code: DeveloperOpenApiErrorCode;
  public readonly httpStatus: number;
  public readonly details: Record<string, unknown> | null;

  public constructor(input: {
    code: DeveloperOpenApiErrorCode;
    httpStatus: number;
    message: string;
    details?: Record<string, unknown> | null;
  }) {
    super(input.message);
    this.name = "DeveloperOpenApiError";
    this.code = input.code;
    this.httpStatus = input.httpStatus;
    this.details = input.details ?? null;
  }
}

export function createDeveloperOpenApiError(
  code: DeveloperOpenApiErrorCode,
  httpStatus: number,
  message: string,
  details?: Record<string, unknown>
): DeveloperOpenApiError {
  return new DeveloperOpenApiError(
    details === undefined ? { code, httpStatus, message } : { code, httpStatus, message, details }
  );
}

export function unauthorized(): DeveloperOpenApiError {
  return createDeveloperOpenApiError("UNAUTHORIZED", 401, "Valid bearer API key is required.");
}

export function repositoryUnavailable(): DeveloperOpenApiError {
  return createDeveloperOpenApiError(
    "DATABASE_REPOSITORY_UNAVAILABLE",
    503,
    "The database-backed read model is temporarily unavailable. Retry later with the same request ID for support correlation."
  );
}

export function notFound(message = "Resource was not found."): DeveloperOpenApiError {
  return createDeveloperOpenApiError("NOT_FOUND", 404, message);
}

export function validationError(
  message = "Request validation failed.",
  details?: Record<string, unknown>
): DeveloperOpenApiError {
  return createDeveloperOpenApiError("VALIDATION_ERROR", 422, message, details);
}

export function unsupportedRoute(): DeveloperOpenApiError {
  return createDeveloperOpenApiError("UNSUPPORTED_ROUTE", 404, "Route is not supported.");
}

export function conflict(message = "Resource is not ready."): DeveloperOpenApiError {
  return createDeveloperOpenApiError("CONFLICT", 409, message);
}

export function payloadTooLarge(message = "Request payload is too large."): DeveloperOpenApiError {
  return createDeveloperOpenApiError("PAYLOAD_TOO_LARGE", 413, message);
}

export function rateLimited(input: { retryAfterSeconds: number }): DeveloperOpenApiError {
  return createDeveloperOpenApiError(
    "RATE_LIMITED",
    429,
    "Too many requests. Wait briefly and retry.",
    {
      retryHint: "retry_after_short_delay",
      retryAfterSeconds: input.retryAfterSeconds,
      retryGuidance: "Wait briefly before sending the next Developer OpenAPI request."
    }
  );
}

export function writeDeveloperOpenApiError(
  context: Context,
  error: unknown
): Response {
  const requestId = getDeveloperOpenApiRequestId(context);
  const normalized =
    error instanceof DeveloperOpenApiError
      ? error
      : createDeveloperOpenApiError("INTERNAL_ERROR", 500, "Internal server error.");

  context.header("x-request-id", requestId);

  return context.json(
    {
      error: {
        code: normalized.code,
        message: normalized.message,
        httpStatus: normalized.httpStatus,
        ...(normalized.details ? { details: normalized.details } : {})
      },
      requestId
    },
    normalized.httpStatus as never
  );
}
