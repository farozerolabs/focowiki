import { describe, expect, it } from "vitest";
import {
  toCurrentGraphEdgeProjectionInput,
  type PublicationGraphEdgeSnapshot
} from "../src/application/ports/publication-projection-input.js";

describe("publication projection input", () => {
  it("uses an empty projection input when a concurrent graph-edge change is no longer current", () => {
    expect(toCurrentGraphEdgeProjectionInput(null)).toEqual({ kind: "empty" });
  });

  it("captures the current graph edge when it remains accepted", () => {
    const edge: PublicationGraphEdgeSnapshot = {
      id: "edge-1",
      fromFileId: "source-a",
      fromPath: "pages/a.md",
      fromTitle: "A",
      toFileId: "source-b",
      toPath: "pages/b.md",
      toTitle: "B",
      relationType: "related",
      weight: 0.8,
      reason: "Shared subject",
      source: "content",
      evidence: {}
    };

    expect(toCurrentGraphEdgeProjectionInput(edge)).toEqual({
      kind: "graph_edge",
      edge
    });
  });
});
