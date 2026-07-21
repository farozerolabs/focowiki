import { describe, expect, it } from "vitest";
import { evaluateProjectionCompaction } from "../src/maintenance/projection-compaction-policy.js";

describe("projection compaction policy", () => {
  const limits = {
    maxDepth: 8,
    maxEncodedBytes: 8 * 1024 * 1024,
    maxTombstoneRatio: 0.25,
    maxReadAmplification: 8
  };

  it("selects every measured compaction trigger", () => {
    expect(evaluateProjectionCompaction({
      segmentCount: 9,
      encodedBytes: 1024,
      tombstoneEntries: 0,
      totalEntries: 10,
      readAmplification: 9
    }, limits)).toEqual({
      compact: true,
      reasons: ["depth", "read_amplification"]
    });
    expect(evaluateProjectionCompaction({
      segmentCount: 2,
      encodedBytes: 9 * 1024 * 1024,
      tombstoneEntries: 3,
      totalEntries: 10,
      readAmplification: 2
    }, limits)).toEqual({
      compact: true,
      reasons: ["bytes", "tombstone_ratio"]
    });
  });

  it("keeps bounded lineages unchanged", () => {
    expect(evaluateProjectionCompaction({
      segmentCount: 4,
      encodedBytes: 1024,
      tombstoneEntries: 1,
      totalEntries: 10,
      readAmplification: 4
    }, limits)).toEqual({ compact: false, reasons: [] });
  });
});
