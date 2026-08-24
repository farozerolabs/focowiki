import { describe, expect, it, vi } from "vitest";
import { buildDocumentNavigationTermBucketResources } from
  "../src/document-indexing/application/document-page-term-projection.js";
import { applyDocumentTermStableShardDelta } from
  "../src/document-indexing/application/document-term-stable-shard-delta.js";

describe("document term stable shard delta", () => {
  it("loads and rewrites only the shard owning an affected term", async () => {
    const records = Array.from({ length: 12 }, (_, index) => ({
      term: `term-${String(index).padStart(2, "0")}`,
      postings: [{ path: `pages/${index}.md`, fields: ["title"] }]
    }));
    const built = buildDocumentNavigationTermBucketResources({
      bucket: "latin",
      records,
      previousPaths: [],
      maximumRecordsPerShard: 3,
      maximumShardBytes: 4_096
    });
    const bodies = new Map(built.pages.flatMap((page) => {
      if (page.logicalPath.endsWith("/index.json")) return [];
      const value = JSON.parse(new TextDecoder().decode(page.bytes)) as {
        terms: Record<string, unknown>[];
      };
      return [[page.logicalPath, value.terms] as const];
    }));
    const readRecords = vi.fn(async (path: string) => bodies.get(path) ?? []);
    const changed = {
      term: "term-04",
      postings: [{ path: "pages/replaced.md", fields: ["title"] }]
    };
    const result = await applyDocumentTermStableShardDelta({
      bucket: "latin",
      base: { resources: built.descriptors },
      changedRecords: [changed],
      removedTerms: [],
      maximumRecords: 3,
      maximumBytes: 4_096,
      readRecords
    });

    expect(readRecords).toHaveBeenCalledTimes(1);
    expect(result.pages).toHaveLength(1);
    expect(result.descriptors).toHaveLength(built.descriptors.length);
    expect(result.descriptors.filter((descriptor) =>
      descriptor.path === result.pages[0]!.logicalPath)).toHaveLength(1);
    expect(result.descriptors.filter((descriptor) =>
      descriptor.path !== result.pages[0]!.logicalPath)).toEqual(
      built.descriptors.filter((descriptor) =>
        descriptor.path !== result.pages[0]!.logicalPath)
    );
  });

  it("removes all split records for one deleted oversized term", async () => {
    const base = [{
      path: "_index/terms/han/han-terms-part-0001.json",
      firstKey: "共同词",
      lastKey: "共同词",
      recordCount: 1,
      byteCount: 256
    }, {
      path: "_index/terms/han/han-terms-part-0002.json",
      firstKey: "共同词",
      lastKey: "共同词",
      recordCount: 1,
      byteCount: 256
    }];
    const readRecords = vi.fn(async () => [{
      term: "共同词",
      postings: [{ path: "pages/old.md", fields: ["body"] }]
    }]);
    const result = await applyDocumentTermStableShardDelta({
      bucket: "han",
      base: { resources: base },
      changedRecords: [],
      removedTerms: ["共同词"],
      maximumRecords: 2,
      maximumBytes: 4_096,
      readRecords
    });

    expect(readRecords).toHaveBeenCalledTimes(2);
    expect(result.pages).toEqual([]);
    expect(result.descriptors).toEqual([]);
    expect(result.removedPaths).toEqual(base.map((item) => item.path));
  });

  it("rebuilds noncontiguous term shards as independent stable runs",
    async () => {
      const base = [termDescriptor("a", "alpha", "charlie"),
        termDescriptor("b", "middle", "november"),
        termDescriptor("c", "xray", "zulu")];
      const readRecords = vi.fn(async (path: string) => path.endsWith("a.json")
        ? [term("alpha"), term("charlie")]
        : path.endsWith("c.json")
          ? [term("xray"), term("zulu")]
          : [term("middle"), term("november")]);
      const result = await applyDocumentTermStableShardDelta({
        bucket: "latin",
        base: { resources: base },
        changedRecords: [term("bravo"), term("yankee")],
        removedTerms: [],
        maximumRecords: 2,
        maximumBytes: 4_096,
        readRecords
      });

      expect(readRecords.mock.calls.map(([path]) => path)).toEqual([
        "_index/terms/latin/a.json", "_index/terms/latin/c.json"
      ]);
      expect(result.descriptors).toContainEqual(base[1]);
      expect(new Set(result.descriptors.map((item) => item.path)).size)
        .toBe(result.descriptors.length);
      result.descriptors.slice(1).forEach((item, index) => {
        expect(result.descriptors[index]!.lastKey < item.firstKey).toBe(true);
      });
    });
});

function termDescriptor(name: string, firstKey: string, lastKey: string) {
  return {
    path: `_index/terms/latin/${name}.json`, firstKey, lastKey,
    recordCount: 2, byteCount: 256
  };
}

function term(value: string) {
  return {
    term: value,
    postings: [{ path: `pages/${value}.md`, fields: ["title"] }]
  };
}
