import { describe, expect, it } from "vitest";
import { selectDocumentRankingTerms } from
  "../src/document-indexing/domain/document-bounded-text.js";

describe("document bounded text", () => {
  it("keeps unique short ranking terms and excludes full source sentences", () => {
    const longSourceSentence = "版本沿革".repeat(90);

    expect(selectDocumentRankingTerms([
      " Patent Law ",
      "patent law",
      longSourceSentence,
      "专利法"
    ], 256, 512)).toEqual(["Patent Law", "专利法"]);
  });
});
