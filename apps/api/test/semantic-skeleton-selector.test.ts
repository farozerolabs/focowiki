import { describe, expect, it } from "vitest";
import {
  SEMANTIC_SKELETON_POLICY_VERSION,
  selectSemanticSkeleton
} from "../src/semantic/graphrag/skeleton-selector.js";
import { createSemanticSourceChunks } from
  "../src/semantic/graphrag/source-chunks.js";

describe("semantic skeleton selector", () => {
  it("is deterministic and excludes an ordinary source when sampling is disabled", () => {
    const chunks = createSemanticSourceChunks({
      sourceRevisionPublicId: "revision-ordinary",
      markdown: "# Notes\n\nA short ordinary note without references.",
      maximumChunkCharacters: 2_000,
      maximumChunks: 32
    });
    const input = {
      sourceRevisionPublicId: "revision-ordinary",
      logicalPath: "notes/ordinary.md",
      markdown: "# Notes\n\nA short ordinary note without references.",
      chunks,
      policy: {
        stableSamplingBasisPoints: 0,
        structuralSelectionThreshold: 4,
        maximumSelectedChunks: 2
      }
    } as const;

    const first = selectSemanticSkeleton(input);
    expect(selectSemanticSkeleton(input)).toEqual(first);
    expect(first).toMatchObject({
      policyVersion: SEMANTIC_SKELETON_POLICY_VERSION,
      selected: false,
      selectedChunkIds: [],
      reasons: []
    });
    expect(first.decisionSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("selects only bounded high-value chunks inside the fixed sparse sample", () => {
    const markdown = [
      "# Service Map",
      "",
      "The gateway is defined as the entry point for requests.",
      "",
      "## Dependencies",
      "",
      "See [Runtime](../runtime.md) and https://example.com/spec.",
      "",
      "## Operations",
      "",
      "Workers process bounded units and publish results."
    ].join("\n");
    const chunks = createSemanticSourceChunks({
      sourceRevisionPublicId: "revision-bridge",
      markdown,
      maximumChunkCharacters: 72,
      maximumChunks: 32
    });

    const result = selectSemanticSkeleton({
      sourceRevisionPublicId: "revision-bridge",
      logicalPath: "architecture/service-map.md",
      markdown,
      chunks,
      policy: {
        stableSamplingBasisPoints: 10_000,
        structuralSelectionThreshold: 4,
        maximumSelectedChunks: 2
      }
    });

    expect(result.selected).toBe(true);
    expect(result.reasons).toContain("stable_sample");
    expect(result.reasons).toContain("structural_bridge");
    expect(result.selectedChunkIds.length).toBeGreaterThan(0);
    expect(result.selectedChunkIds.length).toBeLessThanOrEqual(2);
    expect(result.selectedChunkIds.every((id) => chunks.some((chunk) => chunk.id === id)))
      .toBe(true);
  });

  it("does not expand the fixed generation budget for structural signals alone", () => {
    const markdown = [
      "# Hub",
      "See [A](./a.md), [B](./b.md), [C](./c.md), and [D](./d.md)."
    ].join("\n");
    const chunks = createSemanticSourceChunks({
      sourceRevisionPublicId: "revision-structural-budget",
      markdown,
      maximumChunkCharacters: 2_000,
      maximumChunks: 32
    });
    expect(selectSemanticSkeleton({
      sourceRevisionPublicId: "revision-structural-budget",
      logicalPath: "hub.md",
      markdown,
      chunks,
      policy: {
        stableSamplingBasisPoints: 0,
        structuralSelectionThreshold: 4,
        maximumSelectedChunks: 1
      }
    })).toMatchObject({ selected: false, selectedChunkIds: [], reasons: [] });
  });

  it("does not treat common headings or frontmatter source URLs as skeleton importance", () => {
    const markdown = [
      "---",
      "sources:",
      "  - https://example.com/source",
      "---",
      "# Overview",
      "## Scope",
      "## Details",
      "## Examples",
      "## Operations",
      "Ordinary source content remains fully indexed without generation."
    ].join("\n");
    const chunks = createSemanticSourceChunks({
      sourceRevisionPublicId: "revision-common-structure",
      markdown,
      maximumChunkCharacters: 2_000,
      maximumChunks: 32
    });

    expect(selectSemanticSkeleton({
      sourceRevisionPublicId: "revision-common-structure",
      logicalPath: "common-structure.md",
      markdown,
      chunks,
      policy: {
        stableSamplingBasisPoints: 0,
        structuralSelectionThreshold: 4,
        maximumSelectedChunks: 1
      }
    })).toMatchObject({
      selected: false,
      selectedChunkIds: [],
      reasons: []
    });
  });

  it("uses a stable sampling bucket without reading corpus-wide state", () => {
    const markdown = "# Sample\n\nRepresentative source text.";
    const chunks = createSemanticSourceChunks({
      sourceRevisionPublicId: "revision-sample",
      markdown,
      maximumChunkCharacters: 2_000,
      maximumChunks: 32
    });
    const result = selectSemanticSkeleton({
      sourceRevisionPublicId: "revision-sample",
      logicalPath: "sample.md",
      markdown,
      chunks,
      policy: {
        stableSamplingBasisPoints: 10_000,
        structuralSelectionThreshold: 100,
        maximumSelectedChunks: 1
      }
    });

    expect(result).toMatchObject({
      selected: true,
      reasons: ["stable_sample"]
    });
    expect(result.selectedChunkIds).toEqual([chunks[0]!.id]);
  });

  it("uses strong bounded file-graph signals only inside the fixed sparse sample", () => {
    const markdown = "# Leaf\n\nAn ordinary leaf without an outgoing reference.";
    const chunks = createSemanticSourceChunks({
      sourceRevisionPublicId: "revision-inbound-leaf",
      markdown,
      maximumChunkCharacters: 2_000,
      maximumChunks: 32
    });
    const weak = selectSemanticSkeleton({
      sourceRevisionPublicId: "revision-inbound-leaf",
      logicalPath: "leaf.md",
      markdown,
      chunks,
      graphSignals: {
        acceptedEdgeCount: 1,
        inboundEdgeCount: 1,
        outboundEdgeCount: 0,
        distinctNeighborCount: 1,
        relationKindCount: 1
      },
      policy: {
        stableSamplingBasisPoints: 10_000,
        structuralSelectionThreshold: 100,
        maximumSelectedChunks: 1
      }
    });

    expect(weak).toMatchObject({
      selected: true,
      reasons: ["stable_sample"]
    });
    const result = selectSemanticSkeleton({
      sourceRevisionPublicId: "revision-inbound-leaf",
      logicalPath: "leaf.md",
      markdown,
      chunks,
      graphSignals: {
        acceptedEdgeCount: 4,
        inboundEdgeCount: 4,
        outboundEdgeCount: 0,
        distinctNeighborCount: 4,
        relationKindCount: 2
      },
      policy: {
        stableSamplingBasisPoints: 10_000,
        structuralSelectionThreshold: 100,
        maximumSelectedChunks: 1
      }
    });

    expect(result).toMatchObject({
      selected: true,
      reasons: ["stable_sample", "file_graph_bridge", "neighbor_novelty"]
    });
    expect(result.selectedChunkIds).toEqual([chunks[0]!.id]);
  });

  it("uses bounded multilingual content-profile structure inside the fixed sample", () => {
    const markdown = "# 普通标题\n\n普通正文。";
    const chunks = createSemanticSourceChunks({
      sourceRevisionPublicId: "revision-profile",
      markdown,
      maximumChunkCharacters: 2_000,
      maximumChunks: 32
    });

    const result = selectSemanticSkeleton({
      sourceRevisionPublicId: "revision-profile",
      logicalPath: "guides/profile.md",
      markdown,
      chunks,
      graphSignals: {
        acceptedEdgeCount: 0,
        inboundEdgeCount: 0,
        outboundEdgeCount: 0,
        distinctNeighborCount: 0,
        relationKindCount: 0,
        contentProfileHeadingCount: 3,
        contentProfileDefinitionCount: 4,
        contentProfileExplicitReferenceCount: 4
      },
      policy: {
        stableSamplingBasisPoints: 10_000,
        structuralSelectionThreshold: 16,
        maximumSelectedChunks: 1
      }
    });

    expect(result.reasons).toEqual([
      "stable_sample",
      "structural_bridge",
      "definition_density"
    ]);
  });
});
