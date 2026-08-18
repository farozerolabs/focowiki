import { describe, expect, it } from "vitest";
import { documentSourceExcerpt } from
  "../src/document-indexing/application/document-source-excerpt.js";

describe("document source excerpt", () => {
  it("limits ordinary text to 1,200 Unicode characters", () => {
    const excerpt = documentSourceExcerpt("a".repeat(2_000));

    expect([...excerpt]).toHaveLength(1_200);
    expect(Buffer.byteLength(excerpt, "utf8")).toBe(1_200);
  });

  it("keeps multilingual excerpts within the 4,096-byte storage contract", () => {
    const excerpt = documentSourceExcerpt("😀".repeat(2_000));

    expect([...excerpt]).toHaveLength(1_024);
    expect(Buffer.byteLength(excerpt, "utf8")).toBe(4_096);
    expect(excerpt.endsWith("😀")).toBe(true);
  });

  it("does not unnecessarily shorten Chinese text below the character limit", () => {
    const excerpt = documentSourceExcerpt("知识库".repeat(500));

    expect([...excerpt]).toHaveLength(1_200);
    expect(Buffer.byteLength(excerpt, "utf8")).toBe(3_600);
  });
});
