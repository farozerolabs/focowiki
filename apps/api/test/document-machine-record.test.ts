import { describe, expect, it } from "vitest";
import { documentSourceProjectionRecord } from
  "../src/document-indexing/application/document-machine-record.js";
import { createNodeJiebaTokenizer } from
  "../src/infrastructure/tokenization/nodejieba-tokenizer.js";

const tokenizer = createNodeJiebaTokenizer();
const source = {
  path: "guides/portable.md",
  title: "Portable guide",
  body: "# Portable guide\n\nA standalone document.",
  contentType: "text/markdown; charset=utf-8",
  checksumSha256: "a".repeat(64),
  byteCount: 42,
  metadata: {},
  entities: []
};

describe("document machine record", () => {
  it("exposes zero relationships without a graph path", () => {
    const record = documentSourceProjectionRecord(source, tokenizer);

    expect(record.relationshipCount).toBe(0);
    expect(record).not.toHaveProperty("graphPath");
  });

  it("exposes the graph path only when relationships exist", () => {
    const record = documentSourceProjectionRecord(source, tokenizer, {
      hasRelationships: true
    });

    expect(record.relationshipCount).toBe(1);
    expect(record.graphPath).toBe("_graph/by-file/guides/portable.json");
  });
});
