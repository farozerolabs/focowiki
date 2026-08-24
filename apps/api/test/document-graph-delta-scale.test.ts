import { describe, expect, it } from "vitest";
import { createDocumentGraphStableShardDeltaStream } from
  "../src/document-indexing/application/document-graph-stable-shard-delta.js";

describe("graph publication delta scale gate", () => {
  it("streams thirty thousand evidence-rich relationships in bounded pages",
    async () => {
      const startedAt = performance.now();
      const startedHeapBytes = process.memoryUsage().heapUsed;
      const stream = createDocumentGraphStableShardDeltaStream({
        scopePath: "pages",
        machineDirectory: "_graph/by-directory",
        base: { relationshipCount: 0, childDirectories: [], resources: [] },
        maximumRecords: 1_000,
        maximumBytes: 1_048_576,
        readRecords: async () => []
      });

      for (let page = 0; page < 30; page += 1) {
        await stream.append(Array.from({ length: 1_000 }, (_, offset) =>
          relationship(page * 1_000 + offset)));
      }
      const result = await stream.finish([]);

      expect(result.relationshipCount).toBe(30_000);
      expect(result.metrics).toEqual(expect.objectContaining({
        changedRecordCount: 30_000,
        chunkCount: 30,
        peakBufferedRecordCount: 1_000
      }));
      expect(result.descriptors.reduce((total, descriptor) =>
        total + descriptor.recordCount, 0)).toBe(30_000);
      expect(performance.now() - startedAt).toBeLessThan(10_000);
      expect(process.memoryUsage().heapUsed - startedHeapBytes)
        .toBeLessThan(128 * 1_048_576);
    });
});

function relationship(index: number) {
  const from = `pages/document-${String(index).padStart(5, "0")}.md`;
  return {
    from,
    to: "pages/reference.md",
    fromTitle: from,
    toTitle: "Reference",
    direction: "outgoing",
    relationType: "references",
    weight: 1,
    reason: "The source directly references this file.",
    evidence: [{ path: from, reason: `Evidence ${index}` }]
  };
}
