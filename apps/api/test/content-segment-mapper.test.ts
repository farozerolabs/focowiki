import { describe, expect, it } from "vitest";
import {
  mapMarkdownContentSegments
} from "../src/search/content-segment-mapper.js";

const baseInput = {
  knowledgeBaseId: "kb-generic",
  sourceFileId: "source-file-1",
  sourceRevisionId: "source-revision-1",
  pathRevision: 3,
  logicalPath: "pages/guides/cache.md",
  fileKind: "page",
  title: "Cache recovery",
  metadata: {},
  sourceUrl: "https://example.com/cache",
  checksumSha256: "a".repeat(64),
  visibleFromEpoch: 2,
  visibleUntilEpoch: null
};

describe("Markdown content segment mapper", () => {
  it("retains heading ancestry and late body content within UTF-8 budgets", () => {
    const content = [
      "# Cache recovery",
      "",
      "Introductory text.",
      "",
      "## Failure handling",
      "",
      "缓存恢复需要保留完整上下文。".repeat(20),
      "",
      "### Verification",
      "",
      "The late unique marker is searchable."
    ].join("\n");

    const documents = [...mapMarkdownContentSegments({
      ...baseInput,
      content,
      maxSegmentBytes: 220
    })];

    expect(documents.length).toBeGreaterThan(2);
    expect(documents.every((document) =>
      Buffer.byteLength(document.body, "utf8") <= 220
    )).toBe(true);
    expect(documents.find((document) => document.body.includes("late unique marker")))
      .toMatchObject({
        headingPath: ["Cache recovery", "Failure handling", "Verification"],
        logicalPath: "pages/guides/cache.md",
        sourceFileId: "source-file-1"
      });
    expect(documents.map((document) => document.segmentOrdinal))
      .toEqual(documents.map((_, index) => index));
    expect(new Set(documents.map((document) => document.id)).size)
      .toBe(documents.length);
  });

  it("is byte-for-byte stable for the same revision and path evidence", () => {
    const input = {
      ...baseInput,
      content: "# Runbook\n\nEnglish 中文 2026 punctuation: A/B, C-D.",
      metadata: {
        owner: "platform",
        nested: { safe: true }
      },
      maxSegmentBytes: 128
    };

    expect([...mapMarkdownContentSegments(input)])
      .toEqual([...mapMarkdownContentSegments(input)]);
  });

  it("creates a new document identity when the logical path revision changes", () => {
    const original = [...mapMarkdownContentSegments({
      ...baseInput,
      content: "Stable source body.",
      maxSegmentBytes: 128
    })][0]!;
    const moved = [...mapMarkdownContentSegments({
      ...baseInput,
      pathRevision: baseInput.pathRevision + 1,
      logicalPath: "pages/archive/cache.md",
      content: "Stable source body.",
      maxSegmentBytes: 128
    })][0]!;

    expect(moved.id).not.toBe(original.id);
    expect(moved.logicalPath).not.toBe(original.logicalPath);
  });

  it("keeps full body searchable when metadata is empty", () => {
    const documents = [...mapMarkdownContentSegments({
      ...baseInput,
      content: "Body-only unique evidence.",
      title: null,
      sourceUrl: null,
      maxSegmentBytes: 128
    })];

    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      body: "Body-only unique evidence.",
      metadataText: "",
      sourceUrl: null
    });
  });
});
