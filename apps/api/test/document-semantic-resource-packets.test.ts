import { describe, expect, it } from "vitest";
import {
  buildDocumentSemanticPacketPages,
  createDocumentSemanticPacketAccumulator
} from "../src/document-indexing/application/document-semantic-resource-packets.js";

describe("document semantic resource packets", () => {
  it("uses the portable Unicode order for packet records and postings", () => {
    const result = buildDocumentSemanticPacketPages({
      family: "term_postings",
      directoryPath: "_index/terms/other",
      subject: "other",
      title: "other terms",
      prefix: "other",
      records: [{
        term: "\uE000",
        postings: [{ path: "pages/😀.md", fields: ["body"] },
          { path: "pages/\uE000.md", fields: ["body"] }]
      }, {
        term: "😀",
        postings: [{ path: "pages/😀.md", fields: ["title"] }]
      }],
      recordKey: (record) => String(record.term),
      maximumRecords: 500,
      maximumBytes: 16_384
    });

    expect(result.descriptors[0]).toMatchObject({
      firstKey: "\uE000",
      lastKey: "😀"
    });
    const value = JSON.parse(new TextDecoder().decode(result.pages[0]!.bytes));
    expect(value.terms[0].postings.map((posting: { path: string }) =>
      posting.path)).toEqual(["pages/\uE000.md", "pages/😀.md"]);
  });

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

  it("incrementally shards more than ten thousand ordered relationships", () => {
    const accumulator = createDocumentSemanticPacketAccumulator({
      family: "relationship_packet",
      directoryPath: "_graph/by-directory/library",
      subject: "library",
      title: "library relationships",
      scopePath: "pages/library",
      recordKey: (record) => [record.from, record.to, record.relationType]
        .map(String).join("\0"),
      maximumRecords: 500,
      maximumBytes: 1_048_576
    });
    for (let start = 0; start < 10_500; start += 375) {
      accumulator.append(Array.from({ length: 375 }, (_, offset) => {
        const index = start + offset;
        return {
          from: `pages/library/source-${String(index).padStart(5, "0")}.md`,
          to: `pages/library/target-${String(index).padStart(5, "0")}.md`,
          fromTitle: `Source ${index}`,
          toTitle: `Target ${index}`,
          relationType: "related",
          direction: "outgoing",
          weight: 0.5,
          reason: "Shared subject",
          evidence: []
        };
      }));
    }
    const result = accumulator.finish();
    expect(result.pages).toHaveLength(21);
    expect(result.descriptors.reduce((count, item) =>
      count + item.recordCount, 0)).toBe(10_500);
    expect(result.pages.every((page) =>
      /part-[0-9]{4}\.json$/u.test(page.logicalPath))).toBe(true);
  });
});
