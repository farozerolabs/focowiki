import { describe, expect, it, vi } from "vitest";
import {
  hydrateSearchCandidates,
  type SearchHydrationRecord
} from "../src/search/search-hydration.js";

describe("search result hydration", () => {
  it("returns only active matching revisions and refills after stale candidates", async () => {
    const load = vi.fn(async (sourceFileIds: string[]) => {
      const records: SearchHydrationRecord[] = [
        record("source-stale", "revision-new"),
        record("source-deleted", "revision-deleted", false),
        record("source-valid-a", "revision-a"),
        record("source-valid-b", "revision-b")
      ];
      return records.filter((item) => sourceFileIds.includes(item.sourceFileId));
    });

    const result = await hydrateSearchCandidates({
      generationId: "generation-active",
      candidates: [
        candidate("source-stale", "revision-old", 0.9),
        candidate("source-deleted", "revision-deleted", 0.8),
        candidate("source-valid-a", "revision-a", 0.7),
        candidate("source-valid-b", "revision-b", 0.6)
      ],
      limit: 2,
      load
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(result.items.map((item) => item.sourceFileId)).toEqual([
      "source-valid-a",
      "source-valid-b"
    ]);
    expect(result.items.every((item) => item.generationId === "generation-active"))
      .toBe(true);
  });

  it("deduplicates repeated segment candidates before the authoritative read", async () => {
    const load = vi.fn(async () => [record("source-a", "revision-a")]);

    const result = await hydrateSearchCandidates({
      generationId: "generation-active",
      candidates: [
        candidate("source-a", "revision-a", 0.9),
        candidate("source-a", "revision-a", 0.8)
      ],
      limit: 10,
      load
    });

    expect(load).toHaveBeenCalledWith(["source-a"]);
    expect(result.items).toHaveLength(1);
  });
});

function candidate(sourceFileId: string, sourceRevisionId: string, score: number) {
  return {
    sourceFileId,
    sourceRevisionId,
    logicalPath: `pages/${sourceFileId}.md`,
    title: sourceFileId,
    summary: "Matched excerpt",
    sourceUrl: null,
    exactPriority: 0,
    fusedScore: score,
    families: ["body"] as const,
    relationshipReasons: []
  };
}

function record(
  sourceFileId: string,
  sourceRevisionId: string,
  visible = true
): SearchHydrationRecord {
  return {
    sourceFileId,
    sourceRevisionId,
    visible,
    fileId: `bundle-${sourceFileId}`,
    recordId: `search-${sourceFileId}`,
    logicalPath: `pages/${sourceFileId}.md`,
    title: sourceFileId,
    summary: "Authoritative summary",
    payload: { sourceRevisionId }
  };
}
