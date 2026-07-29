import { describe, expect, it, vi } from "vitest";
import {
  expandGraphRetrievalPage
} from "../src/search/search-graph-retrieval.js";

describe("search graph retrieval", () => {
  it("combines ranked graph seeds with bounded accepted neighbors", async () => {
    const listAcceptedEdges = vi.fn(async () => [
      {
        seedSourceFileId: "source-seed",
        relatedSourceFileId: "source-related",
        relatedSourceRevisionId: "revision-related",
        weight: 0.9,
        reason: "explicit reference"
      }
    ]);

    const result = await expandGraphRetrievalPage({
      seeds: {
        items: [
          {
            sourceFileId: "source-seed",
            sourceRevisionId: "revision-seed",
            logicalPath: "pages/seed.md",
            title: "Seed",
            summary: null,
            sourceUrl: "https://example.test/seed",
            exactPriority: 0,
            fusedScore: 1,
            families: ["graph"],
            relationshipReasons: []
          }
        ],
        nextCursor: null
      },
      neighborLimitPerSeed: 5,
      depth: 1,
      limit: 10,
      cursor: null,
      listAcceptedEdges
    });

    expect(listAcceptedEdges).toHaveBeenCalledWith(["source-seed"], 5);
    expect(result.items.map((item) => ({
      sourceFileId: item.sourceFileId,
      sourceRevisionId: item.sourceRevisionId,
      relationshipReasons: item.relationshipReasons
    }))).toEqual(expect.arrayContaining([
      {
        sourceFileId: "source-seed",
        sourceRevisionId: "revision-seed",
        relationshipReasons: []
      },
      {
        sourceFileId: "source-related",
        sourceRevisionId: "revision-related",
        relationshipReasons: ["explicit reference"]
      }
    ]));
  });

  it("expands distinct graph frontiers up to the requested depth", async () => {
    const listAcceptedEdges = vi.fn(async (sourceFileIds: string[]) => {
      if (sourceFileIds.includes("source-seed")) {
        return [{
          seedSourceFileId: "source-seed",
          relatedSourceFileId: "source-level-one",
          relatedSourceRevisionId: "revision-level-one",
          weight: 0.9,
          reason: "first hop"
        }];
      }
      return [{
        seedSourceFileId: "source-level-one",
        relatedSourceFileId: "source-level-two",
        relatedSourceRevisionId: "revision-level-two",
        weight: 0.8,
        reason: "second hop"
      }];
    });

    const result = await expandGraphRetrievalPage({
      seeds: {
        items: [{
          sourceFileId: "source-seed",
          sourceRevisionId: "revision-seed",
          logicalPath: "pages/seed.md",
          title: "Seed",
          summary: null,
          sourceUrl: null,
          exactPriority: 0,
          fusedScore: 1,
          families: ["graph"],
          relationshipReasons: []
        }],
        nextCursor: null
      },
      neighborLimitPerSeed: 5,
      depth: 2,
      limit: 10,
      cursor: null,
      listAcceptedEdges
    });

    expect(listAcceptedEdges).toHaveBeenNthCalledWith(1, ["source-seed"], 5);
    expect(listAcceptedEdges).toHaveBeenNthCalledWith(2, ["source-level-one"], 5);
    expect(result.items.map((item) => item.sourceFileId)).toEqual(
      expect.arrayContaining([
        "source-seed",
        "source-level-one",
        "source-level-two"
      ])
    );
    expect(
      result.items.find((item) => item.sourceFileId === "source-level-two")
        ?.relationshipReasons
    ).toEqual(["second hop"]);
  });
});
