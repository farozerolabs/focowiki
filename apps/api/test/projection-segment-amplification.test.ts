import { describe, expect, it } from "vitest";
import { planProjectionSegments } from "../src/publication/projection-segment-planner.js";

describe("projection segment amplification", () => {
  it("bounds generated projection objects for a 100-file generation", () => {
    const changes = Array.from({ length: 100 }, (_, fileIndex) =>
      ["search", "manifest", "tree", "graph_node", "links", "graph_edge"]
        .map((projectionKind) => ({
          projectionKind,
          logicalPartition: `${projectionKind}/v1/0001`,
          recordIdentity: `source-file-${fileIndex}`,
          action: "upsert" as const,
          encodedBytes: 512
        })))
      .flat();

    const plan = planProjectionSegments({
      changes,
      maxEntries: 250,
      maxEncodedBytes: 256 * 1024
    });

    expect(plan.segments.length).toBeLessThanOrEqual(12);
    expect(plan.segments.every((segment) => segment.changes.length <= 250)).toBe(true);
    expect(plan.segments.every((segment) => segment.encodedBytes <= 256 * 1024)).toBe(true);
    expect(plan.descriptorCount).toBe(plan.segments.length + 1);
    expect(plan.segments.length / 100).toBeLessThan(2.5);
  });
});
