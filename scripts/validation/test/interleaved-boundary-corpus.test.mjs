import assert from "node:assert/strict";
import test from "node:test";
import {
  assertInterleavedBoundaryCoverage,
  buildDeploymentBoundedMaintenanceCandidates,
  buildInterleavedBoundaryCorpus,
  summarizeInterleavedBoundaryCorpus
} from "../lib/interleaved-boundary-corpus.mjs";

test("builds accepted, rejected, and deferred-validation Markdown fixtures", () => {
  const corpus = buildInterleavedBoundaryCorpus();
  const summary = summarizeInterleavedBoundaryCorpus(corpus);

  assert.equal(summary.fileCount, 24);
  assert.equal(summary.duplicateSetCount, 2);
  assert.equal(summary.protocolCaseCount, 19);
  assert.deepEqual(summary.fileExpectations, {
    accepted: 10,
    accepted_then_failed: 1,
    rejected_at_request: 13
  });
  assert.equal(new Set(summary.caseIds).size, summary.caseIds.length);
});

test("covers path, character, content, identifier, cursor, revision, and limits", () => {
  const corpus = buildInterleavedBoundaryCorpus();
  const serialized = JSON.stringify(corpus);

  for (const marker of [
    "unicode",
    "full-width",
    "unusual-whitespace",
    "whitespace",
    "max-segment",
    "max-path",
    "bidirectional-control",
    "control-character",
    "dot-segment",
    "traversal",
    "unsupported-extension",
    "malformed-markdown",
    "malformed-frontmatter",
    "identifier",
    "cursor",
    "revision",
    "request_body",
    "transport_encoding",
    "pagination",
    "runtime_setting",
    "rate_limit",
    "request_cancellation"
  ]) {
    assert.match(serialized, new RegExp(marker, "u"));
  }
});

test("uses exact accepted source path limits", () => {
  const corpus = buildInterleavedBoundaryCorpus();
  const maxSegment = corpus.files.find(
    (item) => item.id === "accepted-max-segment"
  );
  const maxPath = corpus.files.find(
    (item) => item.id === "accepted-max-path"
  );

  assert.equal(maxSegment.relativePath.split("/").at(-1).length, 240);
  assert.equal(maxPath.relativePath.length, 2_048);
  assert.ok(
    maxPath.relativePath.split("/").every((segment) => segment.length <= 240)
  );
});

test("normalization fixture declares the canonical resulting path", () => {
  const corpus = buildInterleavedBoundaryCorpus();
  const fixture = corpus.files.find(
    (item) => item.id === "accepted-unicode-nfd"
  );

  assert.notEqual(fixture.relativePath, fixture.normalizedPath);
  assert.equal(fixture.relativePath.normalize("NFC"), fixture.normalizedPath);
});

test("derives maintenance boundaries from the deployment-safe baseline", () => {
  const original = {
    reconciliationEnabled: true,
    compactionConcurrency: 3
  };

  assert.deepEqual(buildDeploymentBoundedMaintenanceCandidates(original), {
    atLimit: original,
    overLimit: {
      ...original,
      compactionConcurrency: 4
    }
  });
  assert.throws(
    () => buildDeploymentBoundedMaintenanceCandidates({
      ...original,
      compactionConcurrency: 0
    }),
    /positive integer/u
  );
});

test("rejects incomplete or duplicated boundary execution results", () => {
  const corpus = buildInterleavedBoundaryCorpus();
  const caseIds = summarizeInterleavedBoundaryCorpus(corpus).caseIds;

  assert.throws(
    () => assertInterleavedBoundaryCoverage(
      corpus,
      caseIds.slice(0, -1).map((id) => ({ id, passed: true }))
    ),
    /Missing boundary results/u
  );
  assert.throws(
    () => assertInterleavedBoundaryCoverage(
      corpus,
      [
        ...caseIds.map((id) => ({ id, passed: true })),
        { id: caseIds[0], passed: true }
      ]
    ),
    /Duplicate boundary results/u
  );
});

test("accepts one execution result for every boundary case", () => {
  const corpus = buildInterleavedBoundaryCorpus();
  const caseIds = summarizeInterleavedBoundaryCorpus(corpus).caseIds;

  assert.deepEqual(
    assertInterleavedBoundaryCoverage(
      corpus,
      caseIds.map((id) => ({ id, passed: true }))
    ),
    {
      expected: caseIds.length,
      executed: caseIds.length,
      missing: [],
      unexpected: [],
      duplicates: []
    }
  );
});
