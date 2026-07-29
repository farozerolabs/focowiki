import { describe, expect, it, vi } from "vitest";
import { expandSearchGraph } from "../src/search/graph-expansion.js";

describe("search graph expansion", () => {
  it("expands only accepted active PostgreSQL edges from ranked seeds", async () => {
    const listAcceptedEdges = vi.fn(async () => [
      {
        seedSourceFileId: "source-seed",
        relatedSourceFileId: "source-related-strong",
        relatedSourceRevisionId: "revision-related-strong",
        weight: 0.9,
        reason: "explicit reference"
      },
      {
        seedSourceFileId: "source-seed",
        relatedSourceFileId: "source-related-weak",
        relatedSourceRevisionId: "revision-related-weak",
        weight: 0.4,
        reason: "connected topic"
      },
      {
        seedSourceFileId: "source-other",
        relatedSourceFileId: "source-leak",
        relatedSourceRevisionId: "revision-leak",
        weight: 1,
        reason: "outside requested seeds"
      }
    ]);

    const result = await expandSearchGraph({
      seeds: [
        {
          sourceFileId: "source-seed",
          sourceRevisionId: "revision-seed",
          familyRank: 1
        }
      ],
      neighborLimitPerSeed: 5,
      listAcceptedEdges
    });

    expect(listAcceptedEdges).toHaveBeenCalledWith(["source-seed"], 5);
    expect(result).toEqual([
      {
        sourceFileId: "source-related-strong",
        family: "graph",
        familyRank: 1 + 1 / 6,
        familyScore: 0.9,
        relationshipReason: "explicit reference"
      },
      {
        sourceFileId: "source-related-weak",
        family: "graph",
        familyRank: 1 + 2 / 6,
        familyScore: 0.4,
        relationshipReason: "connected topic"
      }
    ]);
  });
});
