import { describe, expect, it } from "vitest";
import {
  SearchEngineTransportError
} from "../src/application/ports/search-engine-transport.js";
import { DeveloperOpenApiError } from "../src/developer-openapi/errors.js";
import { mapDeveloperSearchError } from "../src/developer-openapi/search-errors.js";
import { ActiveSearchTimeoutError } from "../src/search/active-search.js";
import { SearchRetrievalInputError } from "../src/search/search-retrieval.js";

describe("Developer OpenAPI search errors", () => {
  it.each([
    [
      new SearchEngineTransportError("SEARCH_ENGINE_UNAVAILABLE", true),
      "SEARCH_UNAVAILABLE",
      503
    ],
    [
      new SearchEngineTransportError("SEARCH_ENGINE_AUTHENTICATION_FAILED", false),
      "SEARCH_UNAVAILABLE",
      503
    ],
    [
      new SearchEngineTransportError("SEARCH_ENGINE_OVERLOADED", true),
      "SEARCH_OVERLOADED",
      503
    ],
    [
      new ActiveSearchTimeoutError(),
      "SEARCH_TIMEOUT",
      504
    ],
    [
      new SearchRetrievalInputError("raw invalid query"),
      "VALIDATION_ERROR",
      422
    ]
  ])("maps an internal failure to a stable public envelope", (error, code, status) => {
    const mapped = mapDeveloperSearchError(error);

    expect(mapped).toBeInstanceOf(DeveloperOpenApiError);
    expect(mapped).toMatchObject({
      code,
      httpStatus: status
    });
    expect(JSON.stringify(mapped)).not.toMatch(
      /meilisearch|indexUid|taskUid|apiKey|raw invalid query/iu
    );
  });

  it("preserves an existing public error", () => {
    const error = new DeveloperOpenApiError({
      code: "VALIDATION_ERROR",
      httpStatus: 422,
      message: "Search cursor is invalid."
    });

    expect(mapDeveloperSearchError(error)).toBe(error);
  });

  it("leaves unexpected errors to the shared diagnostic boundary", () => {
    const error = new Error("unexpected");
    expect(mapDeveloperSearchError(error)).toBe(error);
  });
});
