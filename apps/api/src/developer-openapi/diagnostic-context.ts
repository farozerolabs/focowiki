import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import type { RuntimeLogger } from "../logger.js";

export type DeveloperOpenApiDiagnosticContext = {
  logger: RuntimeLogger;
  operationIds: ReadonlyMap<string, string>;
  requestId: string;
  startedAt: number;
};

const contexts = new WeakMap<Context, DeveloperOpenApiDiagnosticContext>();

export function beginDeveloperOpenApiDiagnosticContext(
  context: Context,
  input: {
    logger: RuntimeLogger;
    operationIds: ReadonlyMap<string, string>;
  }
): void {
  contexts.set(context, {
    ...input,
    requestId: context.req.header("x-request-id") ?? `req-${randomUUID()}`,
    startedAt: performance.now()
  });
}

export function endDeveloperOpenApiDiagnosticContext(context: Context): void {
  contexts.delete(context);
}

export function getDeveloperOpenApiDiagnosticContext(
  context: Context
): DeveloperOpenApiDiagnosticContext | null {
  return contexts.get(context) ?? null;
}

export function getDeveloperOpenApiRequestId(context: Context): string {
  return contexts.get(context)?.requestId
    ?? context.req.header("x-request-id")
    ?? `req-${randomUUID()}`;
}
