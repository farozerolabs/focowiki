import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mapStorageVnextMarkdownGraph,
  StorageVnextGraphFactMappingError
} from "../src/storage-vnext/graph/markdown-facts.js";

describe("storage vNext Markdown-first graph facts", () => {
  it("uses generic Markdown body evidence before supplementary metadata across directories", () => {
    const body = [
      "# Platform overview",
      "",
      "The overview links to the [runtime system](../Engineering/System.md#runtime)."
    ].join("\n");
    const checksum = createHash("sha256").update(body).digest("hex");
    const result = mapStorageVnextMarkdownGraph({
      knowledgeBaseId: "kb-generic",
      sourceFilePublicId: "file-overview",
      sourceRevisionPublicId: "revision-overview",
      sourceLogicalPath: "Research/Overview.md",
      body,
      checksum,
      fallbackTitle: "Metadata title",
      metadata: { title: "Metadata title", type: "guide", language: "en" },
      targets: [{
        nodePublicId: "graph-node-system",
        sourceFilePublicId: "file-system",
        sourceRevisionPublicId: "revision-system",
        logicalPath: "pages/Engineering/System.md",
        label: "Runtime system"
      }],
      revision: 1
    });

    expect(result.node).toMatchObject({
      sourceFilePublicId: "file-overview",
      sourceRevisionPublicId: "revision-overview",
      logicalPath: "pages/Research/Overview.md",
      label: "Platform overview",
      kind: "guide",
      metadata: { title: "Metadata title", type: "guide", language: "en" }
    });
    expect(result.node.evidence).toHaveLength(1);
    expect(body.slice(
      result.node.evidence[0]!.startOffset,
      result.node.evidence[0]!.endOffset
    )).toBe("# Platform overview");
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({
      fromNodePublicId: result.node.publicId,
      toNodePublicId: "graph-node-system",
      relation: "direct_reference",
      reason: "Platform overview links to Runtime system.",
      weight: 1
    });
    expect(body.slice(
      result.edges[0]!.evidence[0]!.startOffset,
      result.edges[0]!.evidence[0]!.endOffset
    )).toContain("[runtime system](../Engineering/System.md#runtime)");
  });

  it("uses metadata only as a bounded supplement when body evidence is absent", () => {
    const body = "Plain notes without a heading or a local Markdown relationship.";
    const checksum = createHash("sha256").update(body).digest("hex");
    const result = mapStorageVnextMarkdownGraph({
      knowledgeBaseId: "kb-supplement",
      sourceFilePublicId: "file-notes",
      sourceRevisionPublicId: "revision-notes",
      sourceLogicalPath: "Notes.md",
      body,
      checksum,
      fallbackTitle: "Notes",
      metadata: { type: "note", audience: "everyone" },
      targets: [],
      revision: 1
    });

    expect(result.node.label).toBe("Notes");
    expect(result.node.kind).toBe("note");
    expect(result.node.metadata).toEqual({ type: "note", audience: "everyone" });
    expect(result.node.evidence).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it("deduplicates Unicode cross-directory links and ignores code, fences, and external URLs", () => {
    const body = [
      "# 系统概览",
      "",
      "Read [系统](../工程/系统.md) and [again](../工程/系统.md#details).",
      "`[code](../工程/系统.md)` [external](https://example.com/system.md)",
      "```md",
      "[fenced](../工程/系统.md)",
      "```"
    ].join("\n");
    const checksum = createHash("sha256").update(body).digest("hex");
    const result = mapStorageVnextMarkdownGraph({
      knowledgeBaseId: "kb-unicode",
      sourceFilePublicId: "file-unicode-source",
      sourceRevisionPublicId: "revision-unicode-source",
      sourceLogicalPath: "研究/概览.md",
      body,
      checksum,
      fallbackTitle: "Overview",
      metadata: {},
      targets: [{
        nodePublicId: "graph-node-unicode-target",
        sourceFilePublicId: "file-unicode-target",
        sourceRevisionPublicId: "revision-unicode-target",
        logicalPath: "pages/工程/系统.md",
        label: "系统"
      }],
      revision: 1
    });

    expect(result.node.label).toBe("系统概览");
    expect(result.node.logicalPath).toBe("pages/研究/概览.md");
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]!.evidence).toHaveLength(2);
    expect(result.edges[0]!.evidence.map((evidence) =>
      body.slice(evidence.startOffset, evidence.endOffset)
    )).toEqual([
      "[系统](../工程/系统.md)",
      "[again](../工程/系统.md#details)"
    ]);
  });

  it("rejects evidence mapping when the body checksum is not exact", () => {
    expect(() => mapStorageVnextMarkdownGraph({
      knowledgeBaseId: "kb-checksum",
      sourceFilePublicId: "file-checksum",
      sourceRevisionPublicId: "revision-checksum",
      sourceLogicalPath: "Checksum.md",
      body: "# Checksum",
      checksum: "0".repeat(64),
      fallbackTitle: "Checksum",
      metadata: {},
      targets: [],
      revision: 1
    })).toThrowError(
      expect.objectContaining<Partial<StorageVnextGraphFactMappingError>>({
        code: "checksum_mismatch"
      })
    );
  });

  it("contains no domain-specific production vocabulary or branches", () => {
    const source = readFileSync(resolve(
      import.meta.dirname,
      "../src/storage-vnext/graph/markdown-facts.ts"
    ), "utf8");
    expect(source).not.toMatch(
      /legal|statute|regulation|contract|lawsuit|court|case[_ -]?law|律师|法律|法规|法院/iu
    );
  });
});
