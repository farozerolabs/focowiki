import { describe, expect, it } from "vitest";
import { createDocumentSemanticPlan } from
  "../src/document-indexing/application/document-semantic-plan.js";

const requiredFamilies = [
  "exact_title_path",
  "lexical_jieba",
  "metadata",
  "structural",
  "file_graph_candidate",
  "content_vector"
] as const;

describe("document semantic plan", () => {
  it("keeps complete baseline coverage when sparse GraphRAG is not selected", () => {
    const plan = createDocumentSemanticPlan({
      skeletonPolicy: {
        stableSamplingBasisPoints: 0,
        structuralSelectionThreshold: 1,
        maximumSelectedChunks: 2
      }
    });

    const result = plan(request());

    expect(result.graphragSelection.selected).toBe(false);
    expect(result.coverageFamilies).toEqual(requiredFamilies);
    expect(result.semanticVectorFamilies).toEqual([]);
    expect(result.contentVectorInputs).toHaveLength(1);
    expect(result.exactIdentity).toEqual({
      title: "General Guide",
      logicalPath: "guides/general.md"
    });
  });

  it("adds entity, relationship, and community vectors only for selected sparse work", () => {
    const plan = createDocumentSemanticPlan({
      skeletonPolicy: {
        stableSamplingBasisPoints: 10_000,
        structuralSelectionThreshold: 1,
        maximumSelectedChunks: 2
      }
    });

    const result = plan(request());

    expect(result.graphragSelection.selected).toBe(true);
    expect(result.coverageFamilies).toEqual(requiredFamilies);
    expect(result.semanticVectorFamilies).toEqual([
      "entity_vector", "relationship_vector", "community_vector"
    ]);
    expect(result.graphragSelection.selectedChunkIds.length).toBeGreaterThan(0);
  });

  it("feeds accepted pre-GraphRAG file relations into skeleton selection", () => {
    const plan = createDocumentSemanticPlan({
      skeletonPolicy: {
        stableSamplingBasisPoints: 10_000,
        structuralSelectionThreshold: 16,
        maximumSelectedChunks: 2
      }
    });

    const result = plan({
      ...request(),
      graphSignals: {
        acceptedEdgeCount: 4,
        inboundEdgeCount: 0,
        outboundEdgeCount: 4,
        distinctNeighborCount: 4,
        relationKindCount: 2
      }
    });

    expect(result.graphragSelection.reasons).toEqual(expect.arrayContaining([
      "file_graph_bridge",
      "neighbor_novelty"
    ]));
  });
});

function request() {
  return {
    sourceRevisionPublicId: "source-revision-a",
    logicalPath: "guides/general.md",
    title: "General Guide",
    markdown: "# General Guide\n\nA workflow is defined as a reusable process.",
    metadata: { title: "General Guide", tags: ["guide"] },
    contentProfile: {
      headingOutline: ["General Guide"],
      definitions: ["workflow is defined as a reusable process"],
      explicitReferences: [],
      keywords: ["workflow", "reusable", "process"]
    }
  };
}
