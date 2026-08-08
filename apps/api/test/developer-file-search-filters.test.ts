import { describe, expect, it } from "vitest";
import { okfDateOnlyToEpochDay } from "@focowiki/okf";
import { readDeveloperFileSearchFilters } from "../src/developer-openapi/file-search-filters.js";

describe("developer file search filters", () => {
  it("accepts bounded language-neutral search input", () => {
    expect(readDeveloperFileSearchFilters({
      query: "缓存 consistency 2026",
      scope: undefined,
      fileKind: undefined,
      mode: "hybrid",
      graphDepth: "2",
      graphFanout: "25"
    })).toEqual({
      ok: true,
      query: "缓存 consistency 2026",
      scope: "all",
      fileKind: "page",
      mode: "hybrid",
      graphDepth: 2,
      graphFanout: 25,
      okfFilters: {
        status: null,
        trustTier: null,
        freshness: null,
        requestEpochDay: null
      }
    });
  });

  it("normalizes all OKF decision filters with one request date", () => {
    expect(readDeveloperFileSearchFilters({
      query: "trust signals",
      scope: undefined,
      fileKind: undefined,
      okfStatus: "stable",
      okfTrustTier: "human-reviewed",
      okfFreshness: "fresh",
      requestDate: "2026-08-07"
    })).toMatchObject({
      ok: true,
      okfFilters: {
        status: "stable",
        trustTier: "human-reviewed",
        freshness: "fresh",
        requestEpochDay: okfDateOnlyToEpochDay("2026-08-07")
      }
    });
  });

  it.each([
    ["okfStatus", "unknown", "INVALID_FILE_SEARCH_OKF_STATUS"],
    ["okfTrustTier", "trusted", "INVALID_FILE_SEARCH_OKF_TRUST_TIER"],
    ["okfFreshness", "current", "INVALID_FILE_SEARCH_OKF_FRESHNESS"]
  ] as const)("rejects an invalid %s value with a stable code", (field, value, code) => {
    expect(readDeveloperFileSearchFilters({
      query: "trust signals",
      scope: undefined,
      fileKind: undefined,
      [field]: value,
      requestDate: "2026-08-07"
    })).toEqual({ ok: false, code });
  });

  it.each([
    ["", "FILE_SEARCH_QUERY_REQUIRED"],
    ["a", "FILE_SEARCH_QUERY_TOO_SHORT"],
    ["x".repeat(161), "FILE_SEARCH_QUERY_TOO_LONG"],
    ["cache\u0000consistency", "INVALID_FILE_SEARCH_QUERY"],
    ["cache\nconsistency", "INVALID_FILE_SEARCH_QUERY"]
  ])("rejects invalid query input without database access", (query, code) => {
    expect(readDeveloperFileSearchFilters({
      query,
      scope: undefined,
      fileKind: undefined
    })).toEqual({ ok: false, code });
  });
});
