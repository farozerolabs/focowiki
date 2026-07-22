import type { Context, Hono } from "hono";
import type { RuntimeConfig } from "../config.js";
import type { RuntimeLogger } from "../logger.js";
import {
  beginDeveloperOpenApiDiagnosticContext,
  endDeveloperOpenApiDiagnosticContext,
  getDeveloperOpenApiDiagnosticContext
} from "./diagnostic-context.js";
import { DeveloperOpenApiError } from "./errors.js";
import { validationError, writeDeveloperOpenApiError } from "./errors.js";

const SAFE_RESOURCE_PARAMETERS = new Set([
  "knowledgeBaseId",
  "sourceFileId",
  "fileId",
  "directoryId",
  "operationId",
  "webhookId",
  "deliveryId"
]);

export function installDeveloperOpenApiDiagnosticBoundary(
  app: Hono,
  input: {
    logger: RuntimeLogger;
    operationIds: ReadonlyMap<string, string>;
  }
): void {
  app.use("/openapi/v2/*", async (context, next) => {
    beginDeveloperOpenApiDiagnosticContext(context, input);
    try {
      await next();
    } finally {
      endDeveloperOpenApiDiagnosticContext(context);
    }
  });
}

export async function safe(
  context: Context,
  action: () => Promise<unknown> | unknown,
  status = 200
): Promise<Response> {
  try {
    return context.json(await action(), status as never);
  } catch (error) {
    recordUnexpectedDeveloperOpenApiError(context, error);
    return writeDeveloperOpenApiError(context, error);
  }
}

function recordUnexpectedDeveloperOpenApiError(context: Context, error: unknown): void {
  if (error instanceof DeveloperOpenApiError) return;
  const diagnostic = getDeveloperOpenApiDiagnosticContext(context);
  if (!diagnostic) return;
  const routeTemplate = context.req.routePath || "unmatched";
  const operationKey = `${context.req.method.toUpperCase()} ${routeTemplate}`;
  diagnostic.logger.error("Developer OpenAPI request failed", {
    requestId: diagnostic.requestId,
    operationId: diagnostic.operationIds.get(operationKey) ?? "unknown",
    routeTemplate,
    resourceContext: safeResourceContext(context),
    errorClass: error instanceof Error ? error.name : "UnknownError",
    errorMessage: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)),
    stack: error instanceof Error && error.stack
      ? sanitizeDiagnosticText(error.stack)
      : null,
    durationMs: Math.max(0, Math.round(performance.now() - diagnostic.startedAt)),
    status: 500
  });
}

function safeResourceContext(context: Context): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(context.req.param())) {
    if (SAFE_RESOURCE_PARAMETERS.has(key) && /^[A-Za-z0-9._:-]{1,200}$/u.test(value)) {
      output[key] = value;
    }
  }
  return output;
}

export function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(/\b(?:postgres(?:ql)?|redis|https?|s3):\/\/[^\s]+/giu, "<redacted-url>")
    .replace(/\b(?:objectKey|object_key)\s*[:=]\s*[^\s,;]+/giu, "objectKey=<redacted>")
    .replace(/(?:^|\s)(?:\/[A-Za-z0-9._-]+){3,}(?=[:\s)]|$)/gmu, " <redacted-path>")
    .replace(/(?:^|\s)[A-Za-z]:\\(?:[^\s\\]+\\){2,}[^\s]+/gmu, " <redacted-path>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 2_000);
}

export function readLimit(
  value: string | undefined,
  config: RuntimeConfig,
  limits: { defaultPageSize: number; maxPageSize: number } = config.pagination
): number {
  const parsed = value ? Number(value) : limits.defaultPageSize;

  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > limits.maxPageSize) {
    throw validationError("Pagination limit is invalid.", { field: "limit" });
  }

  return parsed;
}
