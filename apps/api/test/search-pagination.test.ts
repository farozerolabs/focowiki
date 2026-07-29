import { describe, expect, it } from "vitest";
import {
  SearchCursorIdentityError,
  createSearchCursorScope,
  createSearchPageCacheScope,
  createSearchRequestIdentity,
  createStoredSearchCursor,
  validateStoredSearchCursor
} from "../src/developer-openapi/search-pagination.js";

const request = {
  knowledgeBaseId: "kb-search-a",
  generationId: "generation-search-a",
  normalizedQuery: "private phrase 中文",
  mode: "hybrid" as const,
  scope: "all" as const,
  fileKind: "page",
  graphDepth: 2 as const,
  graphFanout: 10,
  activeSearchEpoch: 7,
  contentSchemaVersion: "content-segment-v3",
  graphSchemaVersion: "graph-seed-v3",
  contentSettingsChecksum: "a".repeat(64),
  graphSettingsChecksum: "b".repeat(64),
  retrievalVersion: "ranked-search-v1",
  fusionVersion: "weighted-rrf-v1",
  settingsRevision: "graph-7"
};

describe("search pagination identity", () => {
  it("hashes private query text and binds every search dimension", () => {
    const identity = createSearchRequestIdentity(request);
    const scope = createSearchCursorScope(identity);
    const cacheScope = createSearchPageCacheScope(identity);

    expect(identity.queryHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(scope).not.toContain(request.normalizedQuery);
    expect(scope).not.toContain(request.knowledgeBaseId);
    expect(cacheScope).not.toContain(request.normalizedQuery);
    expect(cacheScope).not.toContain(request.knowledgeBaseId);

    const variants = [
      { knowledgeBaseId: "kb-search-b" },
      { generationId: "generation-search-b" },
      { normalizedQuery: "another phrase" },
      { mode: "file" as const },
      { scope: "path" as const },
      { fileKind: null },
      { graphDepth: 1 as const },
      { graphFanout: 5 },
      { activeSearchEpoch: 8 },
      { contentSchemaVersion: "content-segment-v4" },
      { graphSchemaVersion: "graph-seed-v4" },
      { contentSettingsChecksum: "c".repeat(64) },
      { graphSettingsChecksum: "d".repeat(64) },
      { retrievalVersion: "ranked-search-v2" },
      { fusionVersion: "weighted-rrf-v2" },
      { settingsRevision: "graph-8" }
    ];

    for (const variant of variants) {
      const changed = createSearchRequestIdentity({ ...request, ...variant });
      expect(createSearchCursorScope(changed)).not.toBe(scope);
      expect(createSearchPageCacheScope(changed)).not.toBe(cacheScope);
    }
  });

  it("stores fused position, tie-breaker, full identity, and expiry", () => {
    const identity = createSearchRequestIdentity(request);
    const stored = createStoredSearchCursor({
      identity,
      cursor: {
        score: 0.047,
        recordId: "source-file-z",
        exactPriority: 2,
        queryHash: "ranked-query-hash",
        activeSearchEpoch: request.activeSearchEpoch,
        contentSchemaVersion: request.contentSchemaVersion,
        graphSchemaVersion: request.graphSchemaVersion,
        retrievalVersion: request.retrievalVersion,
        fusionVersion: request.fusionVersion,
        settingsRevision: request.settingsRevision
      },
      expiresAt: "2026-07-28T12:00:00.000Z"
    });

    expect(stored).toMatchObject({
      version: 1,
      identity,
      fusedPosition: {
        score: 0.047,
        exactPriority: 2
      },
      tieBreaker: "source-file-z",
      expiresAt: "2026-07-28T12:00:00.000Z"
    });
    expect(validateStoredSearchCursor({
      stored,
      expectedIdentity: identity,
      now: new Date("2026-07-28T11:59:59.000Z")
    })).toEqual(stored.rankedCursor);
  });

  it("rejects expired, malformed, and cross-request cursors", () => {
    const identity = createSearchRequestIdentity(request);
    const stored = createStoredSearchCursor({
      identity,
      cursor: {
        score: 0.02,
        recordId: "source-file-a"
      },
      expiresAt: "2026-07-28T12:00:00.000Z"
    });

    expect(() => validateStoredSearchCursor({
      stored,
      expectedIdentity: identity,
      now: new Date("2026-07-28T12:00:00.001Z")
    })).toThrow(SearchCursorIdentityError);
    expect(() => validateStoredSearchCursor({
      stored: {
        ...stored,
        identity: createSearchRequestIdentity({
          ...request,
          knowledgeBaseId: "kb-search-b"
        })
      },
      expectedIdentity: identity,
      now: new Date("2026-07-28T11:00:00.000Z")
    })).toThrow(SearchCursorIdentityError);
    expect(() => validateStoredSearchCursor({
      stored: { ...stored, version: 2 } as never,
      expectedIdentity: identity,
      now: new Date("2026-07-28T11:00:00.000Z")
    })).toThrow(SearchCursorIdentityError);
  });
});
