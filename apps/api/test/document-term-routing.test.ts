import { describe, expect, it } from "vitest";
import {
  classifyDocumentNavigationTerm,
  partitionDocumentNavigationTerms
} from "../src/document-indexing/application/document-term-routing.js";

describe("document term routing", () => {
  it("routes selected terms into a finite set of script buckets", () => {
    expect(classifyDocumentNavigationTerm("cache")).toBe("latin");
    expect(classifyDocumentNavigationTerm("缓存")).toBe("han");
    expect(classifyDocumentNavigationTerm("かな")).toBe("kana");
    expect(classifyDocumentNavigationTerm("검색")).toBe("hangul");
    expect(classifyDocumentNavigationTerm("2026")).toBe("number");
    expect(classifyDocumentNavigationTerm("🔎")).toBe("other");
  });

  it("creates bounded deterministic parts without first-character directories", () => {
    const terms = Array.from({ length: 70 }, (_, index) => ({
      term: `term-${String(index).padStart(3, "0")}`,
      postings: [{ path: `pages/${index}.md`, fields: ["body" as const] }]
    }));
    const parts = partitionDocumentNavigationTerms(terms, {
      maximumRecordsPerPart: 32
    });

    expect(parts).toHaveLength(3);
    expect(parts.map((part) => part.path)).toEqual([
      "_index/terms/latin/latin-terms-part-0001.json",
      "_index/terms/latin/latin-terms-part-0002.json",
      "_index/terms/latin/latin-terms-part-0003.json"
    ]);
    expect(parts.map((part) => part.recordCount)).toEqual([32, 32, 6]);
    expect(parts.every((part) => part.firstTerm <= part.lastTerm)).toBe(true);
  });
});
