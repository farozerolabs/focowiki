import { describe, expect, it } from "vitest";
import {
  segmentStorageVnextMarkdown,
  type StorageVnextMarkdownSegment
} from "../src/storage-vnext/search/markdown-segmentation.js";

const encoder = new TextEncoder();

async function collect(
  markdown: string,
  boundaries: number[],
  maxSegmentBytes: number
) {
  const bytes = encoder.encode(markdown);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const boundary of boundaries) {
    chunks.push(bytes.slice(offset, Math.min(bytes.length, boundary)));
    offset = Math.min(bytes.length, boundary);
  }
  chunks.push(bytes.slice(offset));
  const result: StorageVnextMarkdownSegment[] = [];
  for await (const segment of segmentStorageVnextMarkdown({
    chunks: (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
    maxSegmentBytes,
    sourceRevisionPublicId: "revision-a"
  })) {
    result.push(segment);
  }
  return result;
}

describe("storage vNext streamed Markdown segmentation", () => {
  it("covers every decoded character once with bounded UTF-8 segments", async () => {
    const markdown = "# 总览\n\n恢复 café 缓存。\n## 验证\n" + "证据".repeat(80);
    const segments = await collect(markdown, [1, 4, 9, 17, 33], 64);

    expect(segments.map((segment) => segment.searchText).join("")).toBe(markdown);
    expect(segments.every(
      (segment) => Buffer.byteLength(segment.searchText, "utf8") <= 64
    )).toBe(true);
    expect(segments.map((segment) => segment.ordinal)).toEqual(
      segments.map((_, index) => index)
    );
    expect(segments.every((segment) =>
      /^segment-[a-f0-9]{64}$/u.test(segment.id)
    )).toBe(true);
  });

  it("preserves Markdown heading ancestry for nested sections", async () => {
    const markdown = "# Guide\nIntro\n## Restore\nSteps\n### Verify\nChecks\n## Rollback\nUndo";
    const segments = await collect(markdown, [8, 23, 41], 64);

    expect(segments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        headingAncestors: ["Guide"],
        searchText: expect.stringContaining("Intro")
      }),
      expect.objectContaining({
        headingAncestors: ["Guide", "Restore"],
        searchText: expect.stringContaining("Steps")
      }),
      expect.objectContaining({
        headingAncestors: ["Guide", "Restore", "Verify"],
        searchText: expect.stringContaining("Checks")
      }),
      expect.objectContaining({
        headingAncestors: ["Guide", "Rollback"],
        searchText: expect.stringContaining("Undo")
      })
    ]));
  });

  it("is stable across provider chunk boundaries including split UTF-8 code points", async () => {
    const markdown = "# 标题\nAlpha 中文 beta\n## Child\nGamma";
    const whole = await collect(markdown, [], 64);
    const bytewise = await collect(
      markdown,
      Array.from({ length: encoder.encode(markdown).length - 1 }, (_, index) => index + 1),
      64
    );

    expect(bytewise).toEqual(whole);
  });

  it("bounds an unbroken large line without accumulating the full source corpus", async () => {
    const markdown = "x".repeat(20_000);
    const segments = await collect(markdown, [10_000], 128);

    expect(segments.length).toBeGreaterThan(100);
    expect(segments.map((segment) => segment.searchText).join("")).toBe(markdown);
    expect(Math.max(...segments.map(
      (segment) => Buffer.byteLength(segment.searchText, "utf8")
    ))).toBe(128);
  });
});
