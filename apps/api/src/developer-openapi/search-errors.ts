import {
  SearchEngineTransportError
} from "../application/ports/search-engine-transport.js";
import { ActiveSearchTimeoutError } from "../search/active-search.js";
import { SearchRetrievalInputError } from "../search/search-retrieval.js";
import {
  DeveloperOpenApiError,
  createDeveloperOpenApiError,
  validationError
} from "./errors.js";

export function mapDeveloperSearchError(error: unknown): unknown {
  if (error instanceof DeveloperOpenApiError) return error;
  if (error instanceof SearchRetrievalInputError) {
    return validationError("Search query is invalid.", { field: "query" });
  }
  if (error instanceof ActiveSearchTimeoutError) {
    return createDeveloperOpenApiError(
      "SEARCH_TIMEOUT",
      504,
      "Search took too long. Narrow the query or retry shortly."
    );
  }
  if (
    error
    && typeof error === "object"
    && "code" in error
    && error.code === "SEARCH_INDEX_CUTOVER_IN_PROGRESS"
  ) {
    return createDeveloperOpenApiError(
      "SEARCH_UNAVAILABLE",
      503,
      "Search is being refreshed. Retry shortly or continue with file-tree reads."
    );
  }
  if (error instanceof SearchEngineTransportError) {
    if (error.code === "SEARCH_ENGINE_OVERLOADED") {
      return createDeveloperOpenApiError(
        "SEARCH_OVERLOADED",
        503,
        "Search is busy. Wait briefly and retry."
      );
    }
    return createDeveloperOpenApiError(
      "SEARCH_UNAVAILABLE",
      503,
      "Search is temporarily unavailable. Retry shortly or continue with file-tree reads."
    );
  }
  return error;
}

export async function executeDeveloperSearch<T>(
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw mapDeveloperSearchError(error);
  }
}
