import { createHash } from "node:crypto";
import { createPageResponseCacheId } from "./page-response-cache.js";

export type ActiveReadAuthorizationScope = "admin" | "developer-openapi";

type CacheDimensionValue = string | number | boolean | null | undefined;

export function createActiveReadCacheScope(input: {
  authorizationScope: ActiveReadAuthorizationScope;
  operation: string;
  knowledgeBaseId: string;
  generationId: string | null;
  filters?: Record<string, CacheDimensionValue>;
}): string {
  return [
    "active-read",
    input.authorizationScope,
    input.operation,
    input.knowledgeBaseId,
    input.generationId ?? "none",
    `filters=${createDimensionSignature(input.filters ?? {})}`
  ].join(":");
}

export function createActiveReadPageCacheId(input: {
  cursorToken: string | null;
  limit: number;
  input?: Record<string, CacheDimensionValue>;
}): string {
  return createPageResponseCacheId({
    cursorToken: input.cursorToken,
    limit: input.limit,
    extra: createDimensionSignature(input.input ?? {})
  });
}

function createDimensionSignature(input: Record<string, CacheDimensionValue>): string {
  const serialized = JSON.stringify(Object.entries(input)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, value ?? null]));
  return createHash("sha256").update(serialized).digest("hex").slice(0, 32);
}
