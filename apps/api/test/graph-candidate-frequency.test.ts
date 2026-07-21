import { describe, expect, it } from "vitest";
import { createCandidateTermFrequency } from "../src/graph/graph-candidate-frequency.js";

describe("graph candidate term frequency", () => {
  it("preserves document-frequency semantics for exact and containing terms", () => {
    const frequency = createCandidateTermFrequency([
      new Set(["shared-policy", "alpha"]),
      new Set(["shared-policy-guidance", "beta"]),
      new Set(["shared-policy-reference", "lambda"]),
      new Set(["gamma"]),
      new Set(["delta"]),
      new Set(["epsilon"]),
      new Set(["zeta"]),
      new Set(["eta"]),
      new Set(["theta"]),
      new Set(["iota"]),
      new Set(["kappa"])
    ]);

    expect(frequency.isFrequent("shared-policy")).toBe(true);
    expect(frequency.isFrequent("alpha")).toBe(false);
    expect(frequency.isFrequent("missing")).toBe(false);
  });

  it("normalizes compact terms and caches repeated lookups", () => {
    const frequency = createCandidateTermFrequency([
      new Set(["sharedpolicy"]),
      new Set(["sharedpolicy"]),
      new Set(["sharedpolicy"]),
      new Set(["other"])
    ]);

    expect(frequency.isFrequent("shared policy")).toBe(true);
    expect(frequency.isFrequent("shared policy")).toBe(true);
    expect(frequency.cacheSize()).toBe(1);
  });
});
