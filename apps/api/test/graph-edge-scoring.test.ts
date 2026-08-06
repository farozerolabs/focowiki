import type { OkfGraphNode } from "@focowiki/okf";
import { describe, expect, it } from "vitest";
import {
  buildGraphEdges,
  createGraphEdgeScorer
} from "../src/graph/graph-edge-scoring.js";

describe("graph edge scoring", () => {
  it("scores the bounded candidate set without repeating term normalization work", () => {
    const source = graphNode("source", "Unified Storage Validation", 0);
    let candidateProfileReads = 0;
    const candidates = Array.from({ length: 200 }, (_, index) =>
      graphNode(
        `candidate-${index}`,
        `Unified Storage Validation ${index}`,
        index + 1,
        () => { candidateProfileReads += 1; }
      ));
    const input = {
      source,
      body: [
        "# Unified Storage Validation",
        "The atomic publication workflow validates immutable object ownership and release activation."
      ].join("\n"),
      suggestions: null,
      candidates,
      acceptedEdgeLimit: 50,
      genericPhraseThreshold: 4
    } as const;

    const expected = buildGraphEdges(input);
    candidateProfileReads = 0;
    const scorer = createGraphEdgeScorer({ maximumCachedProfiles: 401 });
    let candidateProfileReadsAfterWarmup = 0;
    for (let iteration = 0; iteration < 10; iteration += 1) {
      expect(scorer.build({
        ...input,
        profileKeys: {
          source: `source-revision-${iteration}`,
          candidates: candidates.map((candidate) => `revision-${candidate.fileId}`)
        }
      })).toEqual(expected);
      if (iteration === 0) candidateProfileReadsAfterWarmup = candidateProfileReads;
    }

    expect(expected.length).toBeLessThanOrEqual(50);
    expect(candidateProfileReadsAfterWarmup).toBeGreaterThan(0);
    expect(candidateProfileReads).toBe(candidateProfileReadsAfterWarmup);
  });
});

function graphNode(
  fileId: string,
  title: string,
  ordinal: number,
  onProfileRead?: () => void
): OkfGraphNode {
  const sharedSubjects = Array.from({ length: 24 }, (_, index) =>
    `atomic publication subject ${index}`);
  const sharedEntities = Array.from({ length: 40 }, (_, index) =>
    `immutable storage entity ${index}`);
  const sharedKeywords = Array.from({ length: 80 }, (_, index) =>
    `release validation keyword ${index}`);
  return {
    fileId,
    path: `pages/storage/${fileId}.md`,
    title,
    type: "guide",
    get subjects() {
      onProfileRead?.();
      return sharedSubjects;
    },
    entities: sharedEntities,
    keywords: sharedKeywords,
    explicitReferences: [],
    relationshipHints: [
      "atomic publication workflow",
      "immutable object ownership",
      `release activation ${ordinal}`
    ],
    metadata: {
      contentProfile: {
        definitions: Array.from({ length: 20 }, (_, index) =>
          `immutable storage definition ${index}`),
        processHints: Array.from({ length: 20 }, (_, index) =>
          `atomic publication step ${index}`),
        versionHints: [`revision ${ordinal}`]
      }
    }
  };
}
