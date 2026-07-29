import { describe, expect, it, vi } from "vitest";
import {
  activeSearchProjectionNeedsRebuild
} from "../src/search/active-search-projection-health.js";
import { SearchIndexManagerError } from "../src/search/search-index-manager.js";

describe("active search projection health", () => {
  it("requires a rebuild when an active index is missing or incompatible", async () => {
    const manager = {
      assertActiveIndex: vi.fn()
        .mockRejectedValueOnce(new SearchIndexManagerError(
          "SEARCH_INDEX_INCOMPATIBLE",
          "Active search index is unavailable"
        ))
    };

    await expect(activeSearchProjectionNeedsRebuild({
      transport: {} as never,
      indexPrefix: "focowiki",
      knowledgeBaseId: "kb-one",
      activeEpoch: 3,
      searchCutoffMs: 1_000,
      pollIntervalMs: 100,
      taskTimeoutMs: 10_000,
      manager
    })).resolves.toBe(true);
  });

  it("preserves operational failures for maintenance retry", async () => {
    const failure = new Error("service unavailable");
    const manager = {
      assertActiveIndex: vi.fn().mockRejectedValue(failure)
    };

    await expect(activeSearchProjectionNeedsRebuild({
      transport: {} as never,
      indexPrefix: "focowiki",
      knowledgeBaseId: "kb-one",
      activeEpoch: 3,
      searchCutoffMs: 1_000,
      pollIntervalMs: 100,
      taskTimeoutMs: 10_000,
      manager
    })).rejects.toBe(failure);
  });

  it("accepts compatible content and graph indexes", async () => {
    const manager = {
      assertActiveIndex: vi.fn().mockResolvedValue(undefined)
    };

    await expect(activeSearchProjectionNeedsRebuild({
      transport: {} as never,
      indexPrefix: "focowiki",
      knowledgeBaseId: "kb-one",
      activeEpoch: 3,
      searchCutoffMs: 1_000,
      pollIntervalMs: 100,
      taskTimeoutMs: 10_000,
      manager
    })).resolves.toBe(false);
    expect(manager.assertActiveIndex).toHaveBeenCalledTimes(2);
  });
});
