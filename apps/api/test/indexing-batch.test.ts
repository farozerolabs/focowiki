import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  partitionSearchDocuments
} from "../src/search/indexing-batch.js";

describe("search indexing batches", () => {
  it("partitions deterministically by document count and gzip byte budget", () => {
    const documents = Array.from({ length: 7 }, (_, index) => ({
      id: `segment-${index}`,
      body: `${index}-${"content ".repeat(30)}`
    }));

    const first = partitionSearchDocuments({
      documents,
      maxDocuments: 3,
      maxCompressedBytes: 115
    });
    const second = partitionSearchDocuments({
      documents,
      maxDocuments: 3,
      maxCompressedBytes: 115
    });

    expect(first).toEqual(second);
    expect(first.flatMap((batch) => batch.documents)).toEqual(documents);
    expect(first.every((batch) => batch.documents.length <= 3)).toBe(true);
    expect(first.every((batch) =>
      gzipSync(Buffer.from(JSON.stringify(batch.documents))).byteLength <= 115
    )).toBe(true);
    expect(first.every((batch) => /^[a-f0-9]{64}$/u.test(batch.checksum)))
      .toBe(true);
  });

  it("rejects a single document that cannot fit the byte budget", () => {
    expect(() => partitionSearchDocuments({
      documents: [{ id: "large", body: "x".repeat(10_000) }],
      maxDocuments: 10,
      maxCompressedBytes: 32
    })).toThrow(/compressed byte budget/u);
  });
});
