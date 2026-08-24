import { describe, expect, it, vi } from "vitest";
import { buildDocumentPageDirectoryScopeResources } from
  "../src/document-indexing/application/document-page-term-projection.js";
import { applyDocumentRecordStableShardDelta } from
  "../src/document-indexing/application/document-record-stable-shard-delta.js";

describe("document record stable shard delta", () => {
  it("rewrites only the page-record shard touched by a pure create", async () => {
    const records = Array.from({ length: 12 }, (_, index) => record(
      `pages/library/${String(index).padStart(2, "0")}.md`,
      `Document ${index}`
    ));
    const built = buildDocumentPageDirectoryScopeResources({
      scopePath: "pages/library",
      records,
      childDirectories: [],
      previousPaths: [],
      maximumRecordsPerShard: 3,
      maximumShardBytes: 4_096
    });
    const bodies = new Map(built.pages.flatMap((page) => {
      if (page.logicalPath.endsWith("/index.json")) return [];
      const value = JSON.parse(new TextDecoder().decode(page.bytes)) as {
        documents: Record<string, unknown>[];
      };
      return [[page.logicalPath, value.documents] as const];
    }));
    const readRecords = vi.fn(async (path: string) => bodies.get(path) ?? []);
    const result = await applyDocumentRecordStableShardDelta({
      scopePath: "pages/library",
      baseResources: built.descriptors,
      changedRecords: [record(
        "pages/library/04a.md", "Inserted document")],
      removedRecordPaths: [],
      maximumRecords: 3,
      maximumBytes: 4_096,
      readRecords
    });

    expect(readRecords).toHaveBeenCalledTimes(1);
    expect(result.pages.length).toBeLessThan(built.descriptors.length);
    expect(result.recordCount).toBe(13);
    const untouched = built.descriptors.filter((descriptor) =>
      !result.pages.some((page) => page.logicalPath === descriptor.path));
    expect(result.descriptors).toEqual(expect.arrayContaining(untouched));
  });

  it("removes a deleted record without loading unrelated shards", async () => {
    const baseResources = [{ path: "_index/pages/a.json",
      firstKey: "pages/a.md", lastKey: "pages/c.md",
      recordCount: 3, byteCount: 128 },
    { path: "_index/pages/z.json", firstKey: "pages/x.md",
      lastKey: "pages/z.md",
      recordCount: 3, byteCount: 128 }];
    const readRecords = vi.fn(async (path: string) => path.endsWith("a.json")
      ? [record("pages/a.md"), record("pages/b.md"), record("pages/c.md")]
      : [record("pages/x.md"), record("pages/y.md"), record("pages/z.md")]);
    const result = await applyDocumentRecordStableShardDelta({
      scopePath: "pages",
      baseResources,
      changedRecords: [],
      removedRecordPaths: ["pages/b.md"],
      maximumRecords: 3,
      maximumBytes: 4_096,
      readRecords
    });

    expect(readRecords).toHaveBeenCalledTimes(1);
    expect(result.recordCount).toBe(5);
    expect(result.descriptors).toContainEqual(baseResources[1]);
  });

  it("rebuilds noncontiguous touched shards as independent stable runs",
    async () => {
      const baseResources = [descriptor("a", "pages/00.md", "pages/09.md"),
        descriptor("b", "pages/10.md", "pages/19.md"),
        descriptor("c", "pages/20.md", "pages/29.md")];
      const readRecords = vi.fn(async (path: string) => path.endsWith("a.json")
        ? [record("pages/00.md"), record("pages/09.md")]
        : path.endsWith("c.json")
          ? [record("pages/20.md"), record("pages/29.md")]
          : [record("pages/10.md"), record("pages/19.md")]);

      const result = await applyDocumentRecordStableShardDelta({
        scopePath: "pages",
        baseResources,
        changedRecords: [record("pages/05.md"), record("pages/25.md")],
        removedRecordPaths: [],
        maximumRecords: 2,
        maximumBytes: 4_096,
        readRecords
      });

      expect(readRecords.mock.calls.map(([path]) => path)).toEqual([
        "_index/pages/a.json", "_index/pages/c.json"
      ]);
      expect(new Set(result.descriptors.map((item) => item.path)).size)
        .toBe(result.descriptors.length);
      expect(result.descriptors).toContainEqual(baseResources[1]);
      result.descriptors.slice(1).forEach((item, index) => {
        expect(result.descriptors[index]!.lastKey < item.firstKey).toBe(true);
      });
    });
});

function descriptor(name: string, firstKey: string, lastKey: string) {
  return {
    path: `_index/pages/${name}.json`, firstKey, lastKey,
    recordCount: 2, byteCount: 128
  };
}

function record(path: string, title = path) {
  return {
    path,
    title,
    summary: "Summary",
    type: "document",
    subjects: [],
    tags: [],
    metadata: {},
    headings: [],
    keywords: [],
    entities: [],
    contentType: "text/markdown; charset=utf-8",
    checksumSha256: "a".repeat(64),
    byteCount: 1,
    relationshipCount: 0
  };
}
