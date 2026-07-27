import assert from "node:assert/strict";
import test from "node:test";
import {
  BOUNDARY_FIXTURE_CASES,
  buildInterleavedCorpusManifest
} from "../lib/interleaved-lifecycle-corpus.mjs";

test("partitions samples deterministically without local file paths", () => {
  const samples = Array.from({ length: 8 }, (_, index) => ({
    filePath: `/private/source/file-${index}.md`,
    relativePath: `group/file-${index}.md`,
    basename: `file-${index}.md`,
    title: `Title ${index}`,
    type: "reference",
    status: "active",
    sizeBytes: 100 + index
  }));
  const scenarios = ["control", "pairwise", "multi-way", "manual"];
  const manifest = buildInterleavedCorpusManifest({
    runId: "validation-20260726123000-1234abcd",
    samples,
    scenarioIds: scenarios
  });

  assert.equal(manifest.samples.length, samples.length);
  assert.deepEqual(
    [...new Set(manifest.samples.map((sample) => sample.scenarioId))].sort(),
    [...scenarios].sort()
  );
  assert.doesNotMatch(JSON.stringify(manifest), /private\/source/);
  assert.equal(
    manifest.samples.reduce((total, sample) => total + sample.sizeBytes, 0),
    828
  );
});

test("declares every required boundary fixture family", () => {
  assert.deepEqual(BOUNDARY_FIXTURE_CASES, [
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
});
