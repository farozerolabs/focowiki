import { describe, expect, it } from "vitest";
import {
  createPublicationJobPayload,
  parsePublicationJobPayload
} from "../src/domain/publication-job.js";

describe("publication job payload", () => {
  it("requires a bounded target catalog generation", () => {
    expect(createPublicationJobPayload("manual", 42)).toEqual({
      reason: "manual",
      targetCatalogGeneration: 42
    });
    expect(parsePublicationJobPayload({ reason: "deletion", targetCatalogGeneration: 7 })).toEqual({
      reason: "deletion",
      targetCatalogGeneration: 7
    });
  });

  it.each([
    {},
    { reason: "manual" },
    { reason: "unknown", targetCatalogGeneration: 1 },
    { reason: "manual", targetCatalogGeneration: -1 },
    { reason: "manual", targetCatalogGeneration: 1.5 },
    { reason: "manual", targetCatalogGeneration: "1" }
  ])("rejects obsolete or invalid publication payload %#", (payload) => {
    expect(() => parsePublicationJobPayload(payload)).toThrow(/publication job payload/iu);
  });
});
