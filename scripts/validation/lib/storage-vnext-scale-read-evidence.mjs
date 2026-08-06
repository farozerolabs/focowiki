export const STORAGE_VNEXT_SCALE_READ_KINDS = Object.freeze([
  "exact",
  "title",
  "path",
  "content",
  "broad",
  "chinese",
  "mixed-script",
  "multi-term",
  "phrase",
  "typo",
  "graph",
  "hybrid",
  "pagination",
  "tree",
  "file",
  "metadata",
  "related-file"
]);

const SEARCH_KINDS = new Set(STORAGE_VNEXT_SCALE_READ_KINDS.slice(0, 12));
const MINIMUM_WARM_SAMPLES = 5;

export function summarizeStorageVnextScaleReadEvidence(input) {
  assertMatrix(input.measurements);
  assertDurations(input.providerProcessingTimesMs, "Search provider timing");

  const coldDurations = [];
  const warmDurations = [];
  const quality = [];
  const cases = input.measurements.map((measurement) => {
    const samples = [measurement.cold, ...measurement.warm];
    if (samples.some((sample) => !sample.contractPassed)) {
      throw new Error(`Scale public read contract failed: ${measurement.kind}`);
    }
    coldDurations.push(measurement.cold.durationMs);
    warmDurations.push(...measurement.warm.map((sample) => sample.durationMs));
    const caseQuality = SEARCH_KINDS.has(measurement.kind)
      ? samples.map((sample) => relevanceQuality(
          measurement.relevantSourceFileIds,
          sample.returnedSourceFileIds
        ))
      : [{ recall: 1, ndcg: 1 }];
    quality.push(...caseQuality);
    return {
      kind: measurement.kind,
      coldMs: round(measurement.cold.durationMs),
      warmP95Ms: round(percentile(
        measurement.warm.map((sample) => sample.durationMs),
        0.95
      )),
      warmP99Ms: round(percentile(
        measurement.warm.map((sample) => sample.durationMs),
        0.99
      )),
      warmSampleCount: measurement.warm.length,
      minimumRecall: round(Math.min(...caseQuality.map((item) => item.recall))),
      minimumNdcg: round(Math.min(...caseQuality.map((item) => item.ndcg)))
    };
  });

  return {
    cases,
    coldReadP95Ms: round(percentile(coldDurations, 0.95)),
    warmReadP95Ms: round(percentile(warmDurations, 0.95)),
    readP99Ms: round(percentile([...coldDurations, ...warmDurations], 0.99)),
    searchProviderP95Ms: round(percentile(input.providerProcessingTimesMs, 0.95)),
    minimumRecall: round(Math.min(...quality.map((item) => item.recall))),
    minimumNdcg: round(Math.min(...quality.map((item) => item.ndcg)))
  };
}

function assertMatrix(measurements) {
  const kinds = Array.isArray(measurements)
    ? measurements.map((measurement) => measurement.kind)
    : [];
  if (
    kinds.length !== STORAGE_VNEXT_SCALE_READ_KINDS.length
    || new Set(kinds).size !== kinds.length
    || STORAGE_VNEXT_SCALE_READ_KINDS.some((kind) => !kinds.includes(kind))
  ) throw new Error("Scale read matrix is incomplete");

  for (const measurement of measurements) {
    if (
      !measurement.cold
      || !Array.isArray(measurement.warm)
      || measurement.warm.length < MINIMUM_WARM_SAMPLES
      || !Array.isArray(measurement.relevantSourceFileIds)
      || (SEARCH_KINDS.has(measurement.kind)
        && measurement.relevantSourceFileIds.length === 0)
    ) throw new Error("Scale read matrix is incomplete");
    const samples = [measurement.cold, ...measurement.warm];
    assertDurations(samples.map((sample) => sample.durationMs), "Public read timing");
    if (samples.some((sample) => !Array.isArray(sample.returnedSourceFileIds))) {
      throw new Error("Scale read matrix is incomplete");
    }
  }
}

function assertDurations(values, label) {
  if (
    !Array.isArray(values)
    || values.length === 0
    || values.some((value) => !Number.isFinite(value) || value < 0)
  ) throw new Error(`${label} is invalid`);
}

function relevanceQuality(relevantSourceFileIds, returnedSourceFileIds) {
  const relevance = new Map(relevantSourceFileIds.map((publicId) => [publicId, 3]));
  const returned = [...new Set(returnedSourceFileIds)];
  const recalled = returned.filter((publicId) => relevance.has(publicId)).length;
  const actual = dcg(returned.map((publicId) => relevance.get(publicId) ?? 0));
  const ideal = dcg([...relevance.values()].sort((left, right) => right - left));
  return {
    recall: recalled / relevance.size,
    ndcg: ideal === 0 ? 0 : actual / ideal
  };
}

function dcg(relevances) {
  return relevances.reduce((total, relevance, index) => (
    total + (2 ** relevance - 1) / Math.log2(index + 2)
  ), 0);
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}
