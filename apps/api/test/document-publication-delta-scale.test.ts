import { describe, expect, it, vi } from "vitest";
import { applyDocumentRecordStableShardDelta } from
  "../src/document-indexing/application/document-record-stable-shard-delta.js";

describe("publication delta scale gate", () => {
  it("keeps ten creates bounded against ten thousand base records",
    async () => {
      const descriptors = Array.from({ length: 100 }, (_, shard) => ({
        path: `_index/pages/library/library-documents-part-${String(shard + 1)
          .padStart(4, "0")}.json`,
        firstKey: pathFor(shard * 100),
        lastKey: pathFor(shard * 100 + 99),
        recordCount: 100,
        byteCount: 64_000
      }));
      const changedRecords = Array.from({ length: 10 }, (_, index) => {
        const shard = index * 10;
        return record(`${pathFor(shard * 100 + 50).slice(0, -3)}-new.md`);
      });
      const readRecords = vi.fn(async (path: string) => {
        const shard = descriptors.findIndex((item) => item.path === path);
        return Array.from({ length: 100 }, (_, offset) =>
          record(pathFor(shard * 100 + offset)));
      });
      let checkpointCount = 0;
      const startedAt = performance.now();
      const startedCpu = process.cpuUsage();
      const startedHeapBytes = process.memoryUsage().heapUsed;

      const result = await applyDocumentRecordStableShardDelta({
        scopePath: "pages/library",
        baseResources: descriptors,
        changedRecords,
        removedRecordPaths: [],
        maximumRecords: 100,
        maximumBytes: 1_048_576,
        readRecords,
        checkpoint: async () => {
          checkpointCount += 1;
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      });
      const durationMs = performance.now() - startedAt;
      const cpu = process.cpuUsage(startedCpu);
      const heapDeltaBytes = process.memoryUsage().heapUsed - startedHeapBytes;
      const metrics = {
        activeRecordCount: 10_000,
        deltaDocumentCount: 10,
        shardRowsRead: 1_000,
        changedPageCount: result.pages.length,
        changedByteCount: result.pages.reduce((total, page) =>
          total + page.byteCount, 0),
        durationMs,
        cpuMicroseconds: cpu.user + cpu.system,
        heapDeltaBytes
      };
      if (process.env.FOCOWIKI_TEST_PERFORMANCE_REPORT === "true") {
        process.stdout.write(
          `PUBLICATION_DELTA_METRICS ${JSON.stringify(metrics)}\n`
        );
      }

      expect(readRecords).toHaveBeenCalledTimes(10);
      expect(checkpointCount).toBe(10);
      expect(result.recordCount).toBe(10_010);
      expect(result.pages.length).toBeLessThanOrEqual(20);
      expect(result.descriptors).toHaveLength(110);
      expect(new Set(result.descriptors.map((item) => item.path)).size)
        .toBe(result.descriptors.length);
      expect(metrics.changedByteCount)
        .toBeLessThan(8 * 1_048_576);
      expect(metrics.durationMs).toBeLessThan(10_000);
      expect(metrics.cpuMicroseconds).toBeLessThan(10_000_000);
      expect(metrics.heapDeltaBytes).toBeLessThan(64 * 1_048_576);
    });
});

function pathFor(index: number): string {
  return `pages/library/document-${String(index).padStart(5, "0")}.md`;
}

function record(path: string) {
  return {
    path, title: path, summary: "Summary", type: "document",
    subjects: [], tags: [], metadata: {}, headings: [], keywords: [],
    entities: [], contentType: "text/markdown; charset=utf-8",
    checksumSha256: "a".repeat(64), byteCount: 1, relationshipCount: 0
  };
}
