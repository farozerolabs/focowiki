import { describe, expect, it } from "vitest";
import { createCandidateTermFrequency } from "../src/graph/graph-candidate-frequency.js";
import { buildPersistedGraphCandidateTerms } from "../src/graph/graph-candidates.js";

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

  it("reuses persisted graph terms without loading a runtime tokenizer", () => {
    const terms = buildPersistedGraphCandidateTerms({
      fileId: "file-one",
      path: "pages/legal/atomic-index.md",
      title: "Atomic index",
      subjects: ["index lifecycle"],
      keywords: ["activation"],
      metadata: {
        contentProfile: {
          definitions: ["active pointer"],
          tokenizerContractVersion: "lexical-tokenizer-v1:test"
        }
      }
    });

    expect(terms).toEqual(expect.arrayContaining([
      "Atomic index",
      "legal",
      "atomic",
      "index",
      "index lifecycle",
      "activation",
      "active pointer"
    ]));
    expect(terms.length).toBeLessThanOrEqual(100);
  });
});
