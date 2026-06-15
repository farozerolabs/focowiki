import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  REQUIRED_SAMPLE_COVERAGE,
  SAMPLE_COUNT_ENV,
  SAMPLE_SOURCE_ENV,
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
    for (const status of REQUIRED_SAMPLE_COVERAGE.statuses) {
      assert.equal(result.coverage.statuses.includes(status), true);
    }
    for (const type of REQUIRED_SAMPLE_COVERAGE.types) {
      assert.equal(result.coverage.types.includes(type), true);
    }
    assert.equal(result.samples.every((sample) => sample.hasBody), true);
    assert.equal(result.samples.some((sample) => Object.hasOwn(sample, "body")), false);
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

function writeCoverageFiles(markdownDir) {
  const longTitle = "Long validation title ".repeat(5).trim();
  const duplicateTitle = "Duplicated validation title";
  const rows = [
    ["01__unknown-date__.md", "Sample one", REQUIRED_SAMPLE_COVERAGE.types[0], REQUIRED_SAMPLE_COVERAGE.statuses[0]],
    ["02.md", "Sample two", REQUIRED_SAMPLE_COVERAGE.types[1], REQUIRED_SAMPLE_COVERAGE.statuses[1]],
    ["03.md", "Sample three", REQUIRED_SAMPLE_COVERAGE.types[2], REQUIRED_SAMPLE_COVERAGE.statuses[2]],
    ["04.md", "Sample four", REQUIRED_SAMPLE_COVERAGE.types[3], REQUIRED_SAMPLE_COVERAGE.statuses[0]],
    ["05.md", "Sample five", REQUIRED_SAMPLE_COVERAGE.types[4], REQUIRED_SAMPLE_COVERAGE.statuses[1]],
    ["06.md", longTitle, REQUIRED_SAMPLE_COVERAGE.types[0], REQUIRED_SAMPLE_COVERAGE.statuses[2]],
    ["07.md", duplicateTitle, REQUIRED_SAMPLE_COVERAGE.types[1], REQUIRED_SAMPLE_COVERAGE.statuses[0]],
    ["08.md", duplicateTitle, REQUIRED_SAMPLE_COVERAGE.types[2], REQUIRED_SAMPLE_COVERAGE.statuses[1]],
    ["09.md", "Sample nine", REQUIRED_SAMPLE_COVERAGE.types[3], REQUIRED_SAMPLE_COVERAGE.statuses[2]],
    ["10.md", "Sample ten", REQUIRED_SAMPLE_COVERAGE.types[4], REQUIRED_SAMPLE_COVERAGE.statuses[0]],
    ["11.md", "Sample eleven", REQUIRED_SAMPLE_COVERAGE.types[0], REQUIRED_SAMPLE_COVERAGE.statuses[1]],
    ["12.md", "Sample twelve", REQUIRED_SAMPLE_COVERAGE.types[1], REQUIRED_SAMPLE_COVERAGE.statuses[2]],
    ["13.md", "Sample thirteen", REQUIRED_SAMPLE_COVERAGE.types[2], REQUIRED_SAMPLE_COVERAGE.statuses[0]],
    ["14.md", "Sample fourteen", REQUIRED_SAMPLE_COVERAGE.types[3], REQUIRED_SAMPLE_COVERAGE.statuses[1]]
  ];

  for (const [name, title, type, status] of rows) {
    fs.writeFileSync(
      path.join(markdownDir, name),
      `---\ntitle: "${title}"\ntype: "${type}"\nstatus: "${status}"\ncategory: "Validation"\npublicationDate: "2026-01-01"\n---\n# ${title}\n\nBody ${name}.\n`
    );
  }
}
