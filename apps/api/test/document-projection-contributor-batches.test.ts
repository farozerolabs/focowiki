import { describe, expect, it } from "vitest";
import { splitDocumentProjectionContributors } from
  "../src/document-indexing/infrastructure/document-projection-contributor-batches.js";

describe("document projection contributor batches", () => {
  it("keeps every database write below the contributor-page product limit", () => {
    const contributors = Array.from({ length: 256 }, (_, index) => ({
      sourceRevisionPublicId: `revision-${index + 1}`
    }));

    const batches = splitDocumentProjectionContributors({
      contributors,
      pageCount: 44,
      maximumPairs: 10_000
    });

    expect(batches.map((batch) => batch.length)).toEqual([227, 29]);
    expect(batches.flat()).toEqual(contributors);
    expect(batches.every((batch) => batch.length * 44 <= 10_000)).toBe(true);
  });

  it("does not split empty page output or a bounded contributor set", () => {
    const contributors = [{ sourceRevisionPublicId: "revision-1" }];

    expect(splitDocumentProjectionContributors({
      contributors,
      pageCount: 0,
      maximumPairs: 10_000
    })).toEqual([]);
    expect(splitDocumentProjectionContributors({
      contributors,
      pageCount: 44,
      maximumPairs: 10_000
    })).toEqual([contributors]);
  });
});
