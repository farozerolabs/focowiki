import { describe, expect, it } from "vitest";
import {
  planGeneratedPageWrites,
  selectAffectedGeneratedPaths
} from "../src/document-indexing/application/document-generated-page-plan.js";

describe("document generated page plan", () => {
  it.each([
    ["add", ["guide.md"], []],
    ["replace", ["guide.md"], ["guide.md"]],
    ["rename", ["renamed.md"], ["guide.md"]],
    ["move", ["archive/guide.md"], ["guide.md"]],
    ["delete", [], ["guide.md"]],
    ["retry", ["guide.md"], []],
    ["maintenance", ["guide.md"], ["guide.md"]]
  ])("never schedules an obsolete root schema page during %s", (
    _scenario,
    changedSourceLogicalPaths,
    oldSourceLogicalPaths
  ) => {
    expect(selectAffectedGeneratedPaths({
      changedSourceLogicalPaths,
      oldSourceLogicalPaths,
      affectedGraphPaths: [],
      affectedLeafPaths: [],
      includeManifest: true,
      includeLog: true
    })).not.toContain("schema.md");
  });

  it("selects only changed source ancestors and explicitly affected leaves/shards", () => {
    expect(selectAffectedGeneratedPaths({
      changedSourceLogicalPaths: ["guides/deep/a.md"],
      oldSourceLogicalPaths: ["old/a.md"],
      affectedGraphPaths: ["_graph/by-file/a.json"],
      affectedLeafPaths: ["pages/guides/deep/index-stable-a.md"],
      includeManifest: true,
      includeLog: true
    })).toEqual(expect.arrayContaining([
      "pages/guides/deep/a.md",
      "pages/guides/index.md",
      "pages/guides/deep/index.md",
      "pages/old/index.md",
      "pages/guides/deep/index-stable-a.md",
      "_graph/by-file/a.json",
      "_index/catalog.json",
      "log.md"
    ]));
    expect(selectAffectedGeneratedPaths({
      changedSourceLogicalPaths: ["guides/deep/a.md"],
      oldSourceLogicalPaths: [], affectedGraphPaths: [], affectedLeafPaths: [],
      includeManifest: false, includeLog: false
    })).not.toContain("pages/unrelated/index.md");
    expect(selectAffectedGeneratedPaths({
      changedSourceLogicalPaths: ["guides/deep/a.md"],
      oldSourceLogicalPaths: [], affectedGraphPaths: [], affectedLeafPaths: [],
      includeManifest: false, includeLog: false
    })).not.toContain("schema.md");
  });

  it("reuses byte-identical heads and writes only changed pages", () => {
    expect(planGeneratedPageWrites({
      desired: [{
        logicalPath: "pages/a.md", normalizedPath: "pages/a.md",
        checksumSha256: "a".repeat(64), byteCount: 10
      }, {
        logicalPath: "pages/b.md", normalizedPath: "pages/b.md",
        checksumSha256: "b".repeat(64), byteCount: 11
      }],
      current: [{
        logicalPath: "pages/a.md", normalizedPath: "pages/a.md",
        checksumSha256: "a".repeat(64), objectId: "object-a"
      }, {
        logicalPath: "pages/removed.md", normalizedPath: "pages/removed.md",
        checksumSha256: "c".repeat(64), objectId: "object-c"
      }],
      affectedNormalizedPaths: ["pages/a.md", "pages/b.md", "pages/removed.md"]
    })).toEqual({
      write: [expect.objectContaining({ logicalPath: "pages/b.md" })],
      reuse: [expect.objectContaining({ logicalPath: "pages/a.md", objectId: "object-a" })],
      remove: ["pages/removed.md"]
    });
  });

  it("bounds a ten-thousand-path update and rewrites only the changed byte identity", () => {
    const desired = Array.from({ length: 10_000 }, (_, index) => {
      const normalizedPath = `pages/large/${String(index).padStart(5, "0")}.md`;
      const checksumSha256 = index === 9_999 ? "b".repeat(64) : "a".repeat(64);
      return {
        logicalPath: normalizedPath,
        normalizedPath,
        checksumSha256,
        byteCount: 10
      };
    });
    const current = desired.map((page) => ({
      ...page,
      checksumSha256: "a".repeat(64),
      objectId: `object-${page.normalizedPath}`
    }));

    const plan = planGeneratedPageWrites({
      desired,
      current,
      affectedNormalizedPaths: desired.map((page) => page.normalizedPath)
    });

    expect(plan.write).toEqual([
      expect.objectContaining({ normalizedPath: "pages/large/09999.md" })
    ]);
    expect(plan.reuse).toHaveLength(9_999);
    expect(plan.remove).toEqual([]);
  });
});
