import { describe, expect, it, vi } from "vitest";
import {
  applyDocumentGraphStableShardDelta,
  createDocumentGraphStableShardDeltaStream
} from
  "../src/document-indexing/application/document-graph-stable-shard-delta.js";
import { buildDocumentPerFileGraphScopeResource } from
  "../src/document-indexing/application/document-graph-projection.js";

describe("document graph stable shard delta", () => {
  it("orders per-file relationships by their portable identity", () => {
    const result = buildDocumentPerFileGraphScopeResource({
      source: { path: "pages/source.md", title: "Source" },
      relationships: [{
        targetPath: "pages/target.md", targetTitle: "Target",
        direction: "incoming", relationType: "zeta", weight: 1,
        reason: "Target is related to Source.", evidence: []
      }, {
        targetPath: "pages/target.md", targetTitle: "Target",
        direction: "outgoing", relationType: "alpha", weight: 1,
        reason: "Source is related to Target.", evidence: []
      }],
      previousPaths: []
    });
    const record = JSON.parse(
      new TextDecoder().decode(result.pages[0]!.bytes)
    ) as { relationships: Array<{ relationType: string }> };

    expect(record.relationships.map((item) => item.relationType))
      .toEqual(["alpha", "zeta"]);
  });

  it("rejects invalid streaming limits before scanning", () => {
    expect(() => createDocumentGraphStableShardDeltaStream({
      scopePath: "pages",
      machineDirectory: "_graph/by-directory",
      base: { relationshipCount: 0, childDirectories: [], resources: [] },
      maximumRecords: 0,
      maximumBytes: 4_096,
      readRecords: async () => []
    })).toThrow("graph_delta_stream_limits_invalid");
  });

  it("loads and replaces only the shard owning a changed relationship key",
    async () => {
      const readRecords = vi.fn(async (path: string) => path.endsWith("a.json")
        ? [relationship("pages/a.md", "pages/b.md")]
        : [relationship("pages/x.md", "pages/y.md")]);
      const result = await applyDocumentGraphStableShardDelta({
        scopePath: "pages",
        machineDirectory: "_graph/by-directory",
        base: {
          relationshipCount: 2,
          childDirectories: [],
          resources: [{
            path: "_graph/by-directory/a.json", recordCount: 1,
            firstKey: "pages/a.md\0pages/b.md\0references",
            lastKey: "pages/a.md\0pages/b.md\0references", byteCount: 100
          }, {
            path: "_graph/by-directory/x.json", recordCount: 1,
            firstKey: "pages/x.md\0pages/y.md\0references",
            lastKey: "pages/x.md\0pages/y.md\0references", byteCount: 100
          }]
        },
        changedRecords: [relationship("pages/a.md", "pages/c.md")],
        removedRecordKeys: ["pages/a.md\0pages/b.md\0references"],
        maximumRecords: 100,
        maximumBytes: 1_048_576,
        readRecords
      });
      expect(readRecords).toHaveBeenCalledTimes(1);
      expect(readRecords).toHaveBeenCalledWith("_graph/by-directory/a.json");
      expect(result.descriptors).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "_graph/by-directory/a.json" }),
        expect.objectContaining({ path: "_graph/by-directory/x.json" })
      ]));
      expect(result.relationshipCount).toBe(2);
    });

  it("rebuilds noncontiguous graph shards without spanning untouched owners",
    async () => {
      const base = [graphDescriptor("a", "pages/a.md", "pages/c.md"),
        graphDescriptor("b", "pages/m.md", "pages/n.md"),
        graphDescriptor("c", "pages/x.md", "pages/z.md")];
      const readRecords = vi.fn(async (path: string) => path.endsWith("a.json")
        ? [relationship("pages/a.md", "pages/b.md"),
          relationship("pages/c.md", "pages/d.md")]
        : path.endsWith("c.json")
          ? [relationship("pages/x.md", "pages/y.md"),
            relationship("pages/z.md", "pages/zz.md")]
          : [relationship("pages/m.md", "pages/mm.md"),
            relationship("pages/n.md", "pages/nn.md")]);
      const result = await applyDocumentGraphStableShardDelta({
        scopePath: "pages",
        machineDirectory: "_graph/by-directory",
        base: { relationshipCount: 6, childDirectories: [], resources: base },
        changedRecords: [relationship("pages/b.md", "pages/bb.md"),
          relationship("pages/y.md", "pages/yy.md")],
        removedRecordKeys: [],
        maximumRecords: 2,
        maximumBytes: 4_096,
        readRecords
      });

      expect(readRecords.mock.calls.map(([path]) => path)).toEqual([
        "_graph/by-directory/a.json", "_graph/by-directory/c.json"
      ]);
      expect(result.descriptors).toContainEqual(base[1]);
      expect(new Set(result.descriptors.map((item) => item.path)).size)
        .toBe(result.descriptors.length);
      result.descriptors.slice(1).forEach((item, index) => {
        expect(result.descriptors[index]!.lastKey < item.firstKey).toBe(true);
      });
  });

  it("applies scan pages incrementally without retaining the full change set",
    async () => {
      const stream = createDocumentGraphStableShardDeltaStream({
        scopePath: "pages",
        machineDirectory: "_graph/by-directory",
        base: { relationshipCount: 0, childDirectories: [], resources: [] },
        maximumRecords: 2,
        maximumBytes: 4_096,
        readRecords: vi.fn(async () => [])
      });

      await stream.append([
        relationship("pages/a.md", "pages/b.md"),
        relationship("pages/c.md", "pages/d.md")
      ]);
      await stream.append([
        relationship("pages/e.md", "pages/f.md"),
        relationship("pages/g.md", "pages/h.md")
      ]);
      const result = await stream.finish([]);

      expect(result.relationshipCount).toBe(4);
      expect(result.metrics).toEqual({
        changedRecordCount: 4,
        chunkCount: 2,
        peakBufferedRecordCount: 2,
        touchedShardCount: 2
      });
      expect(result.descriptors.reduce((total, descriptor) =>
        total + descriptor.recordCount, 0)).toBe(4);
    });

  it("keeps a changed key when paged base removals contain the same key",
    async () => {
      const key = "pages/a.md\0pages/b.md\0references";
      const stream = createDocumentGraphStableShardDeltaStream({
        scopePath: "pages",
        machineDirectory: "_graph/by-directory",
        base: {
          relationshipCount: 1,
          childDirectories: [],
          resources: [{
            path: "_graph/by-directory/a.json",
            recordCount: 1,
            firstKey: key,
            lastKey: key,
            byteCount: 100
          }]
        },
        maximumRecords: 100,
        maximumBytes: 4_096,
        readRecords: async () => [relationship("pages/a.md", "pages/b.md")]
      });
      await stream.append([{
        ...relationship("pages/a.md", "pages/b.md"),
        reason: "Updated relationship."
      }]);
      await stream.remove([key]);

      await expect(stream.finish([])).resolves.toMatchObject({
        relationshipCount: 1
      });
    });
});

function graphDescriptor(name: string, first: string, last: string) {
  return {
    path: `_graph/by-directory/${name}.json`, recordCount: 2,
    firstKey: `${first}\0pages/b.md\0references`,
    lastKey: `${last}\0pages/zz.md\0references`, byteCount: 256
  };
}

function relationship(from: string, to: string) {
  return {
    from, to, fromTitle: from, toTitle: to, direction: "outgoing",
    relationType: "references", weight: 1, reason: "Related.", evidence: []
  };
}
