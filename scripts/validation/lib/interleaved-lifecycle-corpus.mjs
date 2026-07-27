export const BOUNDARY_FIXTURE_CASES = Object.freeze([
  "path-limits",
  "unicode-normalization",
  "unusual-whitespace",
  "control-characters",
  "duplicate-normalized-paths",
  "malformed-markdown",
  "malformed-frontmatter",
  "unsupported-file",
  "invalid-identifiers",
  "stale-cursors",
  "stale-revisions",
  "request-body-limits",
  "pagination-limits",
  "concurrency-setting-limits"
]);

export function buildInterleavedCorpusManifest(input) {
  if (!input?.runId || !Array.isArray(input.samples) || input.samples.length === 0) {
    throw new Error("Interleaved corpus requires a run ID and selected samples.");
  }
  if (!Array.isArray(input.scenarioIds) || input.scenarioIds.length === 0) {
    throw new Error("Interleaved corpus requires scenario partitions.");
  }

  const scenarioIds = [...new Set(input.scenarioIds)];
  const samples = input.samples.map((sample, index) => ({
    ordinal: index + 1,
    scenarioId: scenarioIds[index % scenarioIds.length],
    relativePath: sample.relativePath,
    basename: sample.basename,
    title: sample.title,
    type: sample.type,
    status: sample.status,
    sizeBytes: sample.sizeBytes
  }));

  return {
    kind: "focowiki-interleaved-lifecycle-corpus",
    runId: input.runId,
    sampleCount: samples.length,
    totalSizeBytes: samples.reduce(
      (total, sample) => total + sample.sizeBytes,
      0
    ),
    scenarioIds,
    boundaryFixtureCases: [...BOUNDARY_FIXTURE_CASES],
    samples
  };
}
