import { describe, expect, it } from "vitest";
import {
  calculateRemainingReadSampleDelay,
  calculateLexicalReadAcceptanceBounds,
  isSearchResponseGenerationConsistent
} from
  "../scripts/support/lexical-evidence-http.js";

describe("lexical HTTP evidence read bounds", () => {
  it("uses the slower pre-load or post-load idle baseline", () => {
    expect(calculateLexicalReadAcceptanceBounds({
      idleBefore: {
        adminP95Ms: 8,
        developerOpenApiP95Ms: 10,
        contentP95Ms: 700
      },
      idleAfter: {
        adminP95Ms: 12,
        developerOpenApiP95Ms: 9,
        contentP95Ms: 900
      }
    })).toEqual({
      indexedP95BoundMs: 250,
      contentP95BoundMs: 1080
    });
  });

  it("accepts an atomic generation transition across complete responses", () => {
    expect(isSearchResponseGenerationConsistent({
      generationId: "generation-new",
      items: [
        { fileId: "file-a", generationId: "generation-new" },
        { fileId: "file-b", generationId: "generation-new" }
      ]
    })).toBe(true);
  });

  it("rejects a response that mixes active generations", () => {
    expect(isSearchResponseGenerationConsistent({
      generationId: "generation-new",
      items: [
        { fileId: "file-a", generationId: "generation-old" }
      ]
    })).toBe(false);
  });

  it("paces read samples below the default API rate limits", () => {
    expect(calculateRemainingReadSampleDelay({
      startedAtMs: 1_000,
      completedAtMs: 1_300,
      minimumIntervalMs: 500
    })).toBe(200);
    expect(calculateRemainingReadSampleDelay({
      startedAtMs: 1_000,
      completedAtMs: 1_600,
      minimumIntervalMs: 500
    })).toBe(0);
  });
});
