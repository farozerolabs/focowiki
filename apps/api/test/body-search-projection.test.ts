import { describe, expect, it } from "vitest";
import type { LexicalTokenizer } from "../src/application/ports/lexical-tokenizer.js";
import {
  buildBodySearchDocument,
  BODY_SEARCH_SCHEMA_VERSION
} from "../src/search/body-search-document.js";
import { extractSubstantiveMarkdownBody } from "../src/search/body-normalization.js";
import {
  BODY_HEADING_MAX_CHARS,
  BODY_SEGMENT_MAX_CHARS,
  BODY_SEGMENT_OVERLAP_CHARS,
  segmentMarkdownBody
} from "../src/search/body-segmentation.js";

const tokenizer: LexicalTokenizer = {
  contractVersion: "test-tokenizer-v1",
  tokenizeDocument(value, limit) {
    return [...new Set(value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
      .slice(0, limit);
  },
  tokenizeQuery(value, limit) {
    return this.tokenizeDocument(value, limit);
  }
};

describe("body search projection", () => {
  it("preserves user-authored sections whose headings resemble navigation labels", () => {
    const body = [
      "# Operations handbook",
      "",
      "The opening evidence remains searchable.",
      "",
      "## Recovery",
      "",
      "Late-body-needle appears after the normal profile keyword boundary.",
      "",
      "## Related",
      "",
      "Related recovery procedures remain substantive source evidence.",
      "",
      "## References",
      "",
      "Reference retention requirements remain substantive source evidence.",
      "",
      "## Appendix",
      "",
      "Appendix evidence remains substantive."
    ].join("\n");

    const extracted = extractSubstantiveMarkdownBody(body);

    expect(extracted).toContain("The opening evidence remains searchable.");
    expect(extracted).toContain("Late-body-needle");
    expect(extracted).toContain("Related recovery procedures");
    expect(extracted).toContain("Reference retention requirements");
    expect(extracted).toContain("Appendix evidence");
  });

  it("segments headings and oversized paragraphs with stable bounded ordinals", () => {
    const body = [
      "# Root",
      "",
      "A".repeat(3_000),
      "",
      "## Final section",
      "",
      "The final evidence is retained."
    ].join("\n");

    const first = segmentMarkdownBody(body);
    const second = segmentMarkdownBody(body);

    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(2);
    expect(first.map((segment) => segment.ordinal)).toEqual(
      first.map((_, index) => index)
    );
    expect(first.every((segment) => segment.text.length <= 2_200)).toBe(true);
    expect(first.some((segment) => segment.text.includes("The final evidence is retained."))).toBe(true);
    expect(first.some((segment) => segment.heading === "Final section")).toBe(true);
  });

  it("builds a deterministic immutable document covering late-body evidence", () => {
    const body = [
      "# 数据迁移指南",
      "",
      "迁移前需要保存现有配置。",
      "",
      "x".repeat(40_000),
      "",
      "## 完成检查",
      "",
      "服务恢复后需要执行缓存一致性校验。"
    ].join("\n");
    const input = {
      knowledgeBaseId: "kb-1",
      sourceFileId: "source-1",
      sourceRevisionId: "revision-1",
      sourceBodyChecksumSha256: "a".repeat(64),
      title: "数据迁移指南",
      logicalPath: "pages/guides/migration.md",
      summary: "Migration guidance",
      body,
      tokenizer
    };

    const first = buildBodySearchDocument(input);
    const second = buildBodySearchDocument(input);

    expect(second).toEqual(first);
    expect(first.searchSchemaVersion).toBe(BODY_SEARCH_SCHEMA_VERSION);
    expect(first.tokenizerContractVersion).toBe(tokenizer.contractVersion);
    expect(first.documentId).toMatch(/^search-document-[a-f0-9]{64}$/u);
    expect(first.segments.some((segment) =>
      segment.normalizedText.includes("缓存一致性校验")
    )).toBe(true);
    expect(first.segments.some((segment) =>
      segment.tokens.some((term) => term.includes("缓存一致性校验"))
    )).toBe(true);
  });

  it("changes immutable identity when body, schema, or tokenizer identity changes", () => {
    const base = {
      knowledgeBaseId: "kb-identity",
      sourceFileId: "source-identity",
      sourceRevisionId: "revision-identity",
      sourceBodyChecksumSha256: "b".repeat(64),
      title: "Identity",
      logicalPath: "pages/identity.md",
      summary: null,
      body: "Identity body",
      tokenizer
    };
    const first = buildBodySearchDocument(base);
    const changedTokenizer = buildBodySearchDocument({
      ...base,
      tokenizer: { ...tokenizer, contractVersion: "test-tokenizer-v2" }
    });
    const changedBody = buildBodySearchDocument({
      ...base,
      sourceBodyChecksumSha256: "c".repeat(64)
    });

    expect(changedTokenizer.documentId).not.toBe(first.documentId);
    expect(changedBody.documentId).not.toBe(first.documentId);
  });

  it("supports empty bodies and keeps Markdown links and code as source evidence", () => {
    const empty = buildBodySearchDocument({
      knowledgeBaseId: "kb-empty",
      sourceFileId: "source-empty",
      sourceRevisionId: "revision-empty",
      sourceBodyChecksumSha256: "d".repeat(64),
      title: "Empty reference",
      logicalPath: "pages/empty.md",
      summary: null,
      body: "",
      tokenizer
    });
    const markdown = buildBodySearchDocument({
      knowledgeBaseId: "kb-markdown",
      sourceFileId: "source-markdown",
      sourceRevisionId: "revision-markdown",
      sourceBodyChecksumSha256: "e".repeat(64),
      title: "Markdown evidence",
      logicalPath: "pages/markdown.md",
      summary: null,
      body: [
        "# Markdown evidence",
        "",
        "Read [lease recovery](recovery.md) before continuing.",
        "",
        "```text",
        "version token validation",
        "```"
      ].join("\n"),
      tokenizer
    });

    expect(empty.segments).toEqual([]);
    expect(markdown.segments.some((segment) =>
      segment.normalizedText.includes("[lease recovery](recovery.md)")
    )).toBe(true);
    expect(markdown.segments.some((segment) =>
      segment.normalizedText.includes("version token validation")
    )).toBe(true);
  });

  it("keeps every oversized Unicode span with only the versioned overlap duplicated", () => {
    const body = `开${"中".repeat(5_000)}终`;
    const segments = segmentMarkdownBody(body);
    const rebuilt = segments.reduce((value, segment, index) => (
      index === 0
        ? segment.text
        : value + [...segment.text].slice(BODY_SEGMENT_OVERLAP_CHARS).join("")
    ), "");

    expect(rebuilt).toBe(body);
    expect(segments.every((segment) =>
      [...segment.text].length <= BODY_SEGMENT_MAX_CHARS
    )).toBe(true);
  });

  it("keeps oversized heading evidence while bounding heading context", () => {
    const heading = `开${"中".repeat(2_200)}终`;
    const segments = segmentMarkdownBody(`# ${heading}\n\n正文`);

    expect(segments.some((segment) => segment.text.includes("终"))).toBe(true);
    expect(segments.every((segment) =>
      segment.heading === null || [...segment.heading].length <= BODY_HEADING_MAX_CHARS
    )).toBe(true);
    expect(segments.every((segment) =>
      Buffer.byteLength(segment.heading ?? "", "utf8") <= 2_048
    )).toBe(true);
  });
});
