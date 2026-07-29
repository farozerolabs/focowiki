import { describe, expect, it, vi } from "vitest";
import type { RedisCoordinator } from "../src/redis/coordination.js";
import {
  createSearchPageCacheId,
  loadSearchPage
} from "../src/redis/search-page-cache.js";
import {
  createSearchRequestIdentity
} from "../src/developer-openapi/search-pagination.js";

const identity = createSearchRequestIdentity({
  knowledgeBaseId: "kb-cache",
  generationId: "generation-cache",
  normalizedQuery: "cache query",
  mode: "hybrid",
  scope: "all",
  fileKind: null,
  graphDepth: 1,
  graphFanout: 10,
  activeSearchEpoch: 3,
  contentSchemaVersion: "content-v1",
  graphSchemaVersion: "graph-v1",
  contentSettingsChecksum: "a".repeat(64),
  graphSettingsChecksum: "b".repeat(64),
  retrievalVersion: "retrieval-v1",
  fusionVersion: "fusion-v1",
  settingsRevision: "settings-v1"
});

describe("search page cache", () => {
  it("hashes cursor material and keeps private values out of the page id", () => {
    const pageId = createSearchPageCacheId({
      cursor: {
        score: 0.25,
        exactPriority: 1,
        recordId: "source-file-private"
      },
      limit: 20
    });

    expect(pageId).toMatch(/^page:[a-f0-9]{64}$/u);
    expect(pageId).not.toContain("source-file-private");
  });

  it("caches only successful bounded pages", async () => {
    const values = new Map<string, unknown>();
    const redis = {
      getPageCache: vi.fn(async (_scope: string, pageId: string) =>
        values.get(pageId) ?? null),
      setPageCache: vi.fn(async (_scope: string, pageId: string, value: unknown) => {
        values.set(pageId, value);
      })
    } as unknown as RedisCoordinator;
    const load = vi.fn(async () => ({
      items: [{ sourceFileId: "source-file-a" }],
      nextCursor: null
    }));

    const first = await loadSearchPage({
      redis,
      identity,
      cursor: null,
      limit: 20,
      ttlSeconds: 15,
      load,
      isSuccessful: (page) => page.items.length > 0,
      revalidate: async () => true
    });
    const second = await loadSearchPage({
      redis,
      identity,
      cursor: null,
      limit: 20,
      ttlSeconds: 15,
      load,
      isSuccessful: (page) => page.items.length > 0,
      revalidate: async () => true
    });

    expect(first).toEqual(second);
    expect(load).toHaveBeenCalledTimes(1);
    expect(redis.setPageCache).toHaveBeenCalledTimes(1);
  });

  it("discards a cached page when active visibility no longer validates", async () => {
    const cached = {
      items: [{ sourceFileId: "source-file-stale" }],
      nextCursor: null
    };
    const fresh = {
      items: [{ sourceFileId: "source-file-fresh" }],
      nextCursor: null
    };
    const redis = {
      getPageCache: vi.fn(async () => cached),
      setPageCache: vi.fn(async () => undefined)
    } as unknown as RedisCoordinator;
    const load = vi.fn(async () => fresh);

    const result = await loadSearchPage({
      redis,
      identity,
      cursor: null,
      limit: 20,
      ttlSeconds: 15,
      load,
      isSuccessful: (page) => page.items.length > 0,
      revalidate: async (page) => page.items[0]?.sourceFileId !== "source-file-stale"
    });

    expect(result).toEqual(fresh);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not cache empty or oversized pages", async () => {
    const redis = {
      getPageCache: vi.fn(async () => null),
      setPageCache: vi.fn(async () => undefined)
    } as unknown as RedisCoordinator;

    await loadSearchPage({
      redis,
      identity,
      cursor: null,
      limit: 1,
      ttlSeconds: 15,
      load: async () => ({ items: [], nextCursor: null }),
      isSuccessful: (page) => page.items.length > 0,
      revalidate: async () => true
    });
    await loadSearchPage({
      redis,
      identity,
      cursor: null,
      limit: 1,
      ttlSeconds: 15,
      load: async () => ({
        items: [{ sourceFileId: "a" }, { sourceFileId: "b" }],
        nextCursor: null
      }),
      isSuccessful: (page) => page.items.length > 0,
      revalidate: async () => true
    });

    expect(redis.setPageCache).not.toHaveBeenCalled();
  });
});
