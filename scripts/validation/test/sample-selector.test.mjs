import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  BATCH_SAMPLE_COUNT_ENV,
  LARGE_SCALE_MIN_BATCH_FILES_ENV,
  SAMPLE_PROFILE_ENV,
  REQUIRED_SAMPLE_COVERAGE,
  SAMPLE_COUNT_ENV,
  SAMPLE_SOURCE_ENV,
  SINGLE_SAMPLE_ENV,
  selectSingleAndBatchSamples,
  selectSingleAndBatchSamplesFromEnvironment,
  selectSamples,
  selectSamplesFromEnvironment
} from "../lib/sample-selector.mjs";

test("selectSamples chooses a deterministic bounded Markdown sample without reading full file bodies first", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focowiki-samples-"));
  const markdownDir = path.join(root, "markdown");
  fs.mkdirSync(markdownDir);
  writeCoverageFiles(markdownDir);
  fs.writeFileSync(path.join(markdownDir, "ignored.txt"), "not markdown");

  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = () => {
    throw new Error("full body read should not be used during sample selection");
  };

  try {
    const result = selectSamples(root, 14);
    const repeated = selectSamples(root, 14);

    assert.equal(result.sampleCount, 14);
    assert.equal(result.samples.length, 14);
    assert.deepEqual(
      [...result.samples.map((sample) => sample.basename)],
      [...repeated.samples.map((sample) => sample.basename)]
    );
    assert.equal(result.samples.some((sample) => sample.basename === "ignored.txt"), false);
    assert.equal(result.coverage.includesUnknownDate, true);
    assert.equal(result.coverage.includesLongTitle, true);
    assert.equal(result.coverage.includesDuplicatedTitle, true);
    assert.equal(result.coverage.includesNonAsciiBasename, true);
    assert.equal(result.coverage.includesUnknownMetadata, true);
    assert.equal(result.coverage.statuses.length >= REQUIRED_SAMPLE_COVERAGE.minDistinctStatuses, true);
    assert.equal(result.coverage.types.length >= REQUIRED_SAMPLE_COVERAGE.minDistinctTypes, true);
    assert.equal(result.samples.every((sample) => sample.hasBody), true);
    assert.equal(result.samples.some((sample) => Object.hasOwn(sample, "body")), false);
    assert.equal(result.samples.some((sample) => sample.hasNonAsciiBasename), true);
    assert.equal(result.samples.some((sample) => sample.hasUnknownMetadata), true);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("selectSamplesFromEnvironment validates local-only input configuration", () => {
  assert.throws(
    () => selectSamplesFromEnvironment({}),
    new RegExp(`${SAMPLE_SOURCE_ENV} must be set`)
  );
  assert.throws(
    () =>
      selectSamplesFromEnvironment({
        [SAMPLE_SOURCE_ENV]: path.join(os.tmpdir(), "missing-focowiki-samples"),
        [SAMPLE_COUNT_ENV]: "13"
      }),
    new RegExp(`${SAMPLE_COUNT_ENV} must be an integer`)
  );
});

test("selectSamples preserves relative paths for equal basenames in different directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focowiki-nested-samples-"));
  const markdownDir = path.join(root, "markdown");
  const nestedDir = path.join(markdownDir, "archive");
  fs.mkdirSync(nestedDir, { recursive: true });
  writeCoverageFiles(markdownDir);
  fs.copyFileSync(path.join(markdownDir, "02.md"), path.join(nestedDir, "02.md"));

  try {
    const result = selectSamples(root, 15);
    const equalBasenames = result.samples.filter((sample) => sample.basename === "02.md");

    assert.equal(equalBasenames.length, 2);
    assert.deepEqual(
      equalBasenames.map((sample) => sample.relativePath).sort(),
      ["markdown/02.md", "markdown/archive/02.md"]
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("selectSingleAndBatchSamples chooses non-overlapping single and batch Markdown samples", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focowiki-single-batch-"));
  const markdownDir = path.join(root, "markdown");
  fs.mkdirSync(markdownDir);
  writeCoverageFiles(markdownDir);
  fs.writeFileSync(path.join(markdownDir, "ignored.json"), "{}");

  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = () => {
    throw new Error("full body read should not be used during single and batch selection");
  };

  try {
    const result = selectSingleAndBatchSamples(root, { batchSampleCount: 13 });
    const repeated = selectSingleAndBatchSamples(root, { batchSampleCount: 13 });

    assert.equal(result.sampleCount, 14);
    assert.equal(result.batchSampleCount, 13);
    assert.equal(result.batchSamples.length, 13);
    assert.equal(result.samples[0].basename, result.singleSample.basename);
    assert.equal(
      result.batchSamples.some((sample) => sample.basename === result.singleSample.basename),
      false
    );
    assert.deepEqual(
      result.samples.map((sample) => sample.basename),
      repeated.samples.map((sample) => sample.basename)
    );
    assert.equal(result.samples.some((sample) => sample.basename === "ignored.json"), false);
    assert.equal(result.samples.some((sample) => Object.hasOwn(sample, "body")), false);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("selectSingleAndBatchSamplesFromEnvironment supports explicit single sample and batch count", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focowiki-single-batch-env-"));
  const markdownDir = path.join(root, "markdown");
  fs.mkdirSync(markdownDir);
  writeCoverageFiles(markdownDir);

  try {
    const result = selectSingleAndBatchSamplesFromEnvironment({
      [SAMPLE_SOURCE_ENV]: root,
      [SAMPLE_COUNT_ENV]: "14",
      [BATCH_SAMPLE_COUNT_ENV]: "4",
      [SINGLE_SAMPLE_ENV]: "03.md"
    });

    assert.equal(result.singleSample.basename, "03.md");
    assert.equal(result.batchSamples.length, 4);
    assert.equal(result.batchSamples.some((sample) => sample.basename === "03.md"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("selectSingleAndBatchSamplesFromEnvironment supports a large-scale profile with at least 99 batch files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focowiki-large-profile-"));
  const markdownDir = path.join(root, "markdown");
  fs.mkdirSync(markdownDir);
  writeCoverageFiles(markdownDir, 106);

  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = () => {
    throw new Error("full body read should not be used during large-scale selection");
  };

  try {
    const result = selectSingleAndBatchSamplesFromEnvironment({
      [SAMPLE_SOURCE_ENV]: root,
      [SAMPLE_PROFILE_ENV]: "large-scale"
    });
    const repeated = selectSingleAndBatchSamplesFromEnvironment({
      [SAMPLE_SOURCE_ENV]: root,
      [SAMPLE_PROFILE_ENV]: "large-scale"
    });

    assert.equal(result.batchSampleCount, 99);
    assert.equal(result.batchSamples.length, 99);
    assert.equal(result.sampleCount, 100);
    assert.equal(result.profile, "large-scale");
    assert.deepEqual(
      result.samples.map((sample) => sample.basename),
      repeated.samples.map((sample) => sample.basename)
    );
    assert.equal(result.samples.every((sample) => sample.basename.endsWith(".md")), true);
    assert.equal(result.samples.some((sample) => Object.hasOwn(sample, "body")), false);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("selectSingleAndBatchSamplesFromEnvironment fails clearly when large-scale profile has fewer than 99 batch files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focowiki-large-profile-small-"));
  const markdownDir = path.join(root, "markdown");
  fs.mkdirSync(markdownDir);
  writeCoverageFiles(markdownDir, 60);

  try {
    assert.throws(
      () =>
        selectSingleAndBatchSamplesFromEnvironment({
          [SAMPLE_SOURCE_ENV]: root,
          [SAMPLE_PROFILE_ENV]: "large-scale"
        }),
      new RegExp(`${LARGE_SCALE_MIN_BATCH_FILES_ENV} requires at least 99 batch Markdown files`)
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("selectSingleAndBatchSamples rejects invalid flow sample settings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focowiki-single-batch-invalid-"));
  const markdownDir = path.join(root, "markdown");
  fs.mkdirSync(markdownDir);
  writeCoverageFiles(markdownDir);

  try {
    assert.throws(
      () => selectSingleAndBatchSamples(root, { batchSampleCount: 1 }),
      new RegExp(`${BATCH_SAMPLE_COUNT_ENV} must be an integer`)
    );
    assert.throws(
      () => selectSingleAndBatchSamples(root, { batchSampleCount: 13, singleSampleBasename: "missing.md" }),
      new RegExp(`${SINGLE_SAMPLE_ENV} did not match`)
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeCoverageFiles(markdownDir, count = 14) {
  const longTitle = "Long validation title ".repeat(5).trim();
  const duplicateTitle = "Duplicated validation title";
  const types = ["policy", "guide", "manual", "workflow", "reference"];
  const statuses = ["active", "revised", "draft"];
  const baseRows = [
    ["01__unknown-date__.md", "Sample one", types[0], statuses[0]],
    ["02.md", "Sample two", types[1], statuses[1]],
    ["03.md", "Sample three", types[2], statuses[2]],
    ["04.md", "Sample four", types[3], statuses[0]],
    ["05.md", "Sample five", types[4], statuses[1]],
    ["06.md", longTitle, types[0], statuses[2]],
    ["07.md", duplicateTitle, types[1], statuses[0]],
    ["08.md", duplicateTitle, types[2], statuses[1]],
    ["09.md", "Sample nine", types[3], statuses[2]],
    ["10.md", "Sample ten", types[4], statuses[0]],
    ["11.md", "Sample eleven", types[0], statuses[1]],
    ["12.md", "Sample twelve", types[1], statuses[2]],
    ["13.md", "Sample thirteen", types[2], statuses[0]],
    ["示例14.md", "Sample fourteen", types[3], statuses[1]]
  ];
  const rows = [...baseRows];

  for (let index = rows.length + 1; index <= count; index += 1) {
    rows.push([
      `${String(index).padStart(2, "0")}.md`,
      `Sample ${index}`,
      types[index % types.length],
      statuses[index % statuses.length]
    ]);
  }

  for (const [name, title, type, status] of rows) {
    fs.writeFileSync(
      path.join(markdownDir, name),
      `---\ntitle: "${title}"\ntype: "${type}"\nstatus: "${status}"\ncategory: "Validation"\npublicationDate: "2026-01-01"\nvalidationOnly: "yes"\n---\n# ${title}\n\nBody ${name}.\n`
    );
  }
}
