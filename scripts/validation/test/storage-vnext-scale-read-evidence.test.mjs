import assert from "node:assert/strict";
import test from "node:test";

import {
  STORAGE_VNEXT_SCALE_READ_KINDS,
  summarizeStorageVnextScaleReadEvidence
} from "../lib/storage-vnext-scale-read-evidence.mjs";

const SEARCH_KINDS = new Set([
  "exact", "title", "path", "content", "broad", "chinese", "mixed-script",
  "multi-term", "phrase", "typo", "graph", "hybrid"
]);

test("summarizes every required cold and warm scale read independently", () => {
  const result = summarizeStorageVnextScaleReadEvidence({
    measurements: STORAGE_VNEXT_SCALE_READ_KINDS.map((kind, index) => ({
      kind,
      relevantSourceFileIds: SEARCH_KINDS.has(kind) ? ["source-a"] : [],
      cold: sample(index + 1),
      warm: Array.from({ length: 5 }, (_value, warmIndex) =>
        sample(index + warmIndex + 2))
    })),
    providerProcessingTimesMs: [4, 2, 3, 1]
  });

  assert.equal(result.cases.length, STORAGE_VNEXT_SCALE_READ_KINDS.length);
  assert.equal(result.minimumRecall, 1);
  assert.equal(result.minimumNdcg, 1);
  assert.equal(result.searchProviderP95Ms, 4);
  assert.equal(result.cases.every((item) => item.warmSampleCount === 5), true);
  assert.equal(result.cases.every((item) => item.coldMs >= 1), true);
});

test("rejects an incomplete matrix or failed public read contract", () => {
  assert.throws(() => summarizeStorageVnextScaleReadEvidence({
    measurements: [],
    providerProcessingTimesMs: [1]
  }), /matrix is incomplete/u);

  const measurements = STORAGE_VNEXT_SCALE_READ_KINDS.map((kind) => ({
    kind,
    relevantSourceFileIds: SEARCH_KINDS.has(kind) ? ["source-a"] : [],
    cold: sample(1),
    warm: Array.from({ length: 5 }, () => sample(1))
  }));
  measurements.at(-1).warm[2].contractPassed = false;
  assert.throws(() => summarizeStorageVnextScaleReadEvidence({
    measurements,
    providerProcessingTimesMs: [1]
  }), /public read contract failed/u);
});

test("reports a ranking regression below perfect NDCG", () => {
  const measurements = STORAGE_VNEXT_SCALE_READ_KINDS.map((kind) => ({
    kind,
    relevantSourceFileIds: SEARCH_KINDS.has(kind) ? ["source-a"] : [],
    cold: sample(1),
    warm: Array.from({ length: 5 }, () => sample(1))
  }));
  const exact = measurements.find((item) => item.kind === "exact");
  exact.warm[0].returnedSourceFileIds = ["source-b", "source-a"];

  const result = summarizeStorageVnextScaleReadEvidence({
    measurements,
    providerProcessingTimesMs: [1]
  });
  assert.equal(result.minimumRecall, 1);
  assert.equal(result.minimumNdcg < 1, true);
});

function sample(durationMs) {
  return {
    durationMs,
    contractPassed: true,
    returnedSourceFileIds: ["source-a", "source-b"]
  };
}
