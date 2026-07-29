import { describe, expect, it } from "vitest";
import { fuseSearchCandidates } from "../src/search/rank-fusion.js";

describe("ranked search fusion", () => {
  it("prioritizes exact identity and accumulates independent family evidence", () => {
    const result = fuseSearchCandidates({
      candidates: [
        { sourceFileId: "source-body", family: "body", familyRank: 1, familyScore: 0.1 },
        { sourceFileId: "source-exact", family: "exact_title", familyRank: 1, familyScore: 1 },
        { sourceFileId: "source-multi", family: "body", familyRank: 2, familyScore: 0.2 },
        { sourceFileId: "source-multi", family: "title", familyRank: 2, familyScore: 0.2 },
        { sourceFileId: "source-exact", family: "body", familyRank: 30, familyScore: 0.01 }
      ],
      limit: 10,
      cursor: null
    });

    expect(result.items.map((item) => item.sourceFileId)).toEqual([
      "source-exact",
      "source-multi",
      "source-body"
    ]);
    expect(result.items[1]?.families).toEqual(["body", "title"]);
  });

  it("deduplicates graph reasons and uses a stable source-file tie break", () => {
    const result = fuseSearchCandidates({
      candidates: [
        {
          sourceFileId: "source-b",
          family: "graph",
          familyRank: 1,
          familyScore: 1,
          relationshipReason: "references"
        },
        {
          sourceFileId: "source-a",
          family: "graph",
          familyRank: 1,
          familyScore: 1,
          relationshipReason: "references"
        },
        {
          sourceFileId: "source-a",
          family: "graph",
          familyRank: 1,
          familyScore: 1,
          relationshipReason: "references"
        }
      ],
      limit: 10,
      cursor: null
    });

    expect(result.items.map((item) => item.sourceFileId)).toEqual([
      "source-a",
      "source-b"
    ]);
    expect(result.items[0]?.relationshipReasons).toEqual(["references"]);
  });

  it("keeps the golden order across every independently ranked family", () => {
    const result = fuseSearchCandidates({
      candidates: [
        {
          sourceFileId: "source-exact-title",
          family: "exact_title",
          familyRank: 1,
          familyScore: 0.0001
        },
        {
          sourceFileId: "source-exact-path",
          family: "exact_path",
          familyRank: 1,
          familyScore: 0.0002
        },
        {
          sourceFileId: "source-combined",
          family: "body",
          familyRank: 1,
          familyScore: 0.0003
        },
        {
          sourceFileId: "source-combined",
          family: "metadata",
          familyRank: 1,
          familyScore: 10_000
        },
        {
          sourceFileId: "source-combined",
          family: "graph",
          familyRank: 1,
          familyScore: -5
        },
        {
          sourceFileId: "source-title",
          family: "title",
          familyRank: 1,
          familyScore: -10
        },
        {
          sourceFileId: "source-body",
          family: "body",
          familyRank: 1,
          familyScore: 50_000
        },
        {
          sourceFileId: "source-path",
          family: "path",
          familyRank: 1,
          familyScore: 100_000
        },
        {
          sourceFileId: "source-graph",
          family: "graph",
          familyRank: 1,
          familyScore: 200_000
        },
        {
          sourceFileId: "source-metadata",
          family: "metadata",
          familyRank: 1,
          familyScore: 300_000
        },
        {
          sourceFileId: "source-typo",
          family: "typo",
          familyRank: 1,
          familyScore: 400_000
        }
      ],
      limit: 20,
      cursor: null
    });

    expect(result.items.map((item) => item.sourceFileId)).toEqual([
      "source-exact-title",
      "source-exact-path",
      "source-combined",
      "source-title",
      "source-body",
      "source-path",
      "source-graph",
      "source-metadata",
      "source-typo"
    ]);
    expect(result.items.find((item) => item.sourceFileId === "source-combined"))
      .toMatchObject({
        families: ["body", "graph", "metadata"]
      });
  });

  it("continues after an opaque fused position", () => {
    const candidates = ["a", "b", "c"].map((sourceFileId, index) => ({
      sourceFileId,
      family: "body" as const,
      familyRank: index + 1,
      familyScore: 1
    }));
    const first = fuseSearchCandidates({ candidates, limit: 2, cursor: null });
    const second = fuseSearchCandidates({
      candidates,
      limit: 2,
      cursor: first.nextCursor
    });

    expect(first.items.map((item) => item.sourceFileId)).toEqual(["a", "b"]);
    expect(second.items.map((item) => item.sourceFileId)).toEqual(["c"]);
  });
});
