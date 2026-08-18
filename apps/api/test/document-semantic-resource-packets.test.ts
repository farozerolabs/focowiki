import { describe, expect, it } from "vitest";
import {
  buildDocumentSemanticPacketPages
} from "../src/document-indexing/application/document-semantic-resource-packets.js";

describe("document semantic resource packets", () => {
  it("splits a high-frequency term across named parts without losing postings", () => {
    const postings = Array.from({ length: 2_000 }, (_, index) => ({
      path: `pages/library/document-${String(index).padStart(4, "0")}.md`,
      fields: ["body"]
    }));
    const result = buildDocumentSemanticPacketPages({
      family: "term_postings",
      directoryPath: "_index/terms",
      subject: "latin",
      title: "latin terms",
      prefix: "latin",
      records: [{ term: "document", postings }],
      recordKey: (record) => String(record.term),
      maximumRecords: 500,
      maximumBytes: 16_384
    });

    expect(result.pages.length).toBeGreaterThan(1);
    expect(result.pages.every((page) =>
      /latin-terms-part-[0-9]{4}\.json$/u.test(page.logicalPath))).toBe(true);
    const projected = result.pages.flatMap((page) => {
      const value = JSON.parse(new TextDecoder().decode(page.bytes));
      expect(value.terms).toHaveLength(1);
      expect(value.terms[0].term).toBe("document");
      return value.terms[0].postings;
    });
    expect(projected).toEqual(postings);
    expect(result.descriptors.every((item) =>
      item.firstKey === "document" && item.lastKey === "document")).toBe(true);
  });
});
