import { SearchProviderError } from
  "../../application/ports/search-provider-runtime.js";

export function normalizeOpenSearchError(error: unknown): SearchProviderError {
  if (error instanceof SearchProviderError) return error;
  const status = openSearchStatusCode(error);
  if (status === 401) {
    return new SearchProviderError("SEARCH_ENGINE_AUTHENTICATION_FAILED", false);
  }
  if (status === 403) {
    return new SearchProviderError("SEARCH_ENGINE_AUTHORIZATION_FAILED", false);
  }
  if (status === 408) {
    return new SearchProviderError("SEARCH_ENGINE_TIMEOUT", true);
  }
  if (status === 429 || status !== null && status >= 500) {
    return new SearchProviderError("SEARCH_ENGINE_OVERLOADED", true);
  }
  if (status !== null && status >= 400) {
    return new SearchProviderError("SEARCH_ENGINE_REQUEST_FAILED", false);
  }
  const name = error instanceof Error ? error.name : "";
  if (/timeout|abort/iu.test(name)) {
    return new SearchProviderError("SEARCH_ENGINE_TIMEOUT", true);
  }
  return new SearchProviderError("SEARCH_ENGINE_UNAVAILABLE", true);
}

export function openSearchStatusCode(error: unknown): number | null {
  const meta = objectValue(objectValue(error)?.meta);
  const status = meta?.statusCode;
  return Number.isSafeInteger(status) ? Number(status) : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
