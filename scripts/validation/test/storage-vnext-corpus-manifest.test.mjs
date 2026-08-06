import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStorageVnextCorpusManifest
} from "../lib/storage-vnext-corpus-manifest.mjs";

test("builds a redacted real-corpus manifest with generic controls", () => {
  const externalSamples = Array.from({ length: 200 }, (_value, index) => sample({
    index,
    group: "external",
    relativePath: `category-${index % 5}/document-${index}.md`,
    basename: index === 0 ? "示例__unknown-date__.md" : `document-${index}.md`,
    title: index < 2 ? "Duplicated title" : `Document ${index}`,
    type: `type-${index % 5}`,
    status: `status-${index % 3}`,
    hasUnknownMetadata: index === 0,
    sizeBytes: index === 0 ? 70_000 : 1_000,
    body: index === 0
      ? `# Long document\n\n[Reference](https://example.test)\n${"x".repeat(69_000)}`
      : `# Document ${index}\n\n[Reference](https://example.test/${index})`
  }));
  const controlSamples = Array.from({ length: 14 }, (_value, index) => sample({
    index,
    group: "control",
    relativePath: `technical/group-${index % 2}/control-${index}.md`,
    basename: `control-${index}.md`,
    title: `Control ${index}`,
    type: "technical-guide",
    status: "",
    sizeBytes: 500,
    body: `# Control ${index}\n\n[Reference](https://example.test/control/${index})`
  }));

  const manifest = buildStorageVnextCorpusManifest({
    createdAt: "2026-08-02T00:00:00.000Z",
    corpusName: "cleaned-corpus",
    totalCandidateFiles: 29_737,
    externalSelection: selection(externalSamples),
    controlSelection: selection(controlSamples),
    readText: (entry) => entry.body
  });

  assert.equal(manifest.externalSampleCount, 200);
  assert.equal(manifest.genericControlSampleCount, 14);
  assert.equal(manifest.samples.length, 214);
  assert.equal(manifest.coverage.includesNestedDirectories, true);
  assert.equal(manifest.coverage.includesLongContent, true);
  assert.equal(manifest.coverage.includesMarkdownLinks, true);
  assert.equal(manifest.coverage.includesDuplicatedTitle, true);
  assert.equal(manifest.coverage.includesUnicodeBasename, true);
  assert.equal(manifest.samples.every((entry) => /^[0-9a-f]{64}$/u.test(entry.checksumSha256)), true);
  assert.equal(manifest.samples.some((entry) => Object.hasOwn(entry, "body")), false);
  assert.doesNotMatch(JSON.stringify(manifest), /private\/source|filePath/u);
});

test("rejects an incomplete external corpus selection", () => {
  const externalSamples = Array.from({ length: 199 }, (_value, index) => sample({
    index,
    group: "external",
    relativePath: `category/document-${index}.md`,
    basename: `document-${index}.md`,
    title: `Document ${index}`,
    type: "guide",
    status: "active",
    sizeBytes: 1_000,
    body: `# Document ${index}`
  }));

  assert.throws(
    () => buildStorageVnextCorpusManifest({
      createdAt: "2026-08-02T00:00:00.000Z",
      corpusName: "cleaned-corpus",
      totalCandidateFiles: 29_737,
      externalSelection: selection(externalSamples),
      controlSelection: selection([]),
      readText: (entry) => entry.body
    }),
    /exactly 200 external Markdown samples/u
  );
});

function selection(samples) {
  return {
    samples,
    sampleCount: samples.length,
    scannedCandidateProfiles: samples.length,
    coverage: {
      statuses: [...new Set(samples.map((entry) => entry.status).filter(Boolean))],
      types: [...new Set(samples.map((entry) => entry.type).filter(Boolean))],
      categories: [],
      includesUnknownDate: true,
      includesLongTitle: true,
      includesDuplicatedTitle: true,
      includesNonAsciiBasename: true,
      includesUnknownMetadata: true,
      totalSizeBytes: samples.reduce((total, entry) => total + entry.sizeBytes, 0)
    },
    coverageWarnings: []
  };
}

function sample(input) {
  return {
    ...input,
    sizeBytes: Buffer.byteLength(input.body, "utf8"),
    filePath: `/private/source/${input.group}/${input.basename}`,
    category: input.group,
    publicationDate: "2026-01-01",
    hasNonAsciiBasename: /[^\x00-\x7F]/u.test(input.basename),
    hasUnknownMetadata: input.hasUnknownMetadata === true,
    metadataKeys: ["title", "type", "status"],
    hasBody: true
  };
}
