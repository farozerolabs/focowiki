import { createHash } from "node:crypto";
import path from "node:path";

const REQUIRED_EXTERNAL_SAMPLE_COUNT = 200;
const REQUIRED_CONTROL_SAMPLE_COUNT = 14;
const LONG_CONTENT_BYTES = 64 * 1_024;

export function buildStorageVnextCorpusManifest(input) {
  assertInput(input);
  const externalSamples = input.externalSelection.samples;
  const controlSamples = input.controlSelection.samples;
  if (externalSamples.length !== REQUIRED_EXTERNAL_SAMPLE_COUNT) {
    throw new Error("Corpus manifest requires exactly 200 external Markdown samples.");
  }
  if (controlSamples.length !== REQUIRED_CONTROL_SAMPLE_COUNT) {
    throw new Error("Corpus manifest requires exactly 14 generic control samples.");
  }

  const duplicatedTitles = duplicatedValues(externalSamples.map((sample) => sample.title));
  const samples = [
    ...externalSamples.map((sample) => manifestSample(sample, "external", input.readText)),
    ...controlSamples.map((sample) => manifestSample(sample, "generic-control", input.readText))
  ];
  const coverage = manifestCoverage({
    samples,
    duplicatedTitles,
    externalSelection: input.externalSelection,
    controlSelection: input.controlSelection
  });
  assertCoverage(coverage);

  return {
    schemaVersion: 1,
    kind: "storage-vnext-cleaned-markdown-corpus-manifest",
    changeName: "implement-breaking-storage-vnext",
    createdAt: input.createdAt,
    corpusName: input.corpusName,
    totalCandidateFiles: input.totalCandidateFiles,
    externalSampleCount: externalSamples.length,
    genericControlSampleCount: controlSamples.length,
    scannedCandidateProfiles: input.externalSelection.scannedCandidateProfiles,
    selectionStrategy: "deterministic-metadata-coverage-v1",
    coverage,
    samples
  };
}

function manifestSample(sample, group, readText) {
  assertRelativeMarkdownPath(sample.relativePath);
  const body = readText(sample);
  if (typeof body !== "string" || body.trim().length === 0) {
    throw new Error(`Corpus manifest sample body is empty: ${sample.relativePath}`);
  }
  const bytes = Buffer.from(body, "utf8");
  if (bytes.byteLength !== sample.sizeBytes) {
    throw new Error(`Corpus manifest sample size differs from its profile: ${sample.relativePath}`);
  }

  return {
    group,
    relativePath: sample.relativePath,
    basename: sample.basename,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: sample.sizeBytes,
    titleLength: sample.title.length,
    type: sample.type,
    status: sample.status || null,
    category: sample.category || null,
    publicationDate: sample.publicationDate || null,
    metadataKeys: [...sample.metadataKeys],
    features: {
      nestedDirectory: sample.relativePath.split("/").length > 1,
      longContent: sample.sizeBytes >= LONG_CONTENT_BYTES,
      markdownLink: /\[[^\]]+\]\([^)]+\)/u.test(body),
      markdownHeading: /^#{1,6}\s+/mu.test(body),
      unicodeBasename: sample.hasNonAsciiBasename,
      unknownMetadata: sample.hasUnknownMetadata,
      unknownDate: sample.basename.includes("__unknown-date__")
    }
  };
}

function manifestCoverage(input) {
  const external = input.samples.filter((sample) => sample.group === "external");
  const controls = input.samples.filter((sample) => sample.group === "generic-control");
  const directories = new Set(input.samples.map((sample) => path.posix.dirname(sample.relativePath)));
  const sizes = external.map((sample) => sample.sizeBytes).sort((left, right) => left - right);

  return {
    statuses: [...input.externalSelection.coverage.statuses],
    types: [...input.externalSelection.coverage.types],
    categories: [...input.externalSelection.coverage.categories],
    directoryCount: directories.size,
    maximumDirectoryDepth: Math.max(
      ...input.samples.map((sample) => sample.relativePath.split("/").length - 1)
    ),
    externalTotalSizeBytes: sizes.reduce((total, size) => total + size, 0),
    externalMinimumSizeBytes: sizes[0],
    externalMedianSizeBytes: sizes[Math.floor(sizes.length / 2)],
    externalMaximumSizeBytes: sizes.at(-1),
    includesNestedDirectories: input.samples.some((sample) => sample.features.nestedDirectory),
    includesLongContent: external.some((sample) => sample.features.longContent),
    includesMarkdownLinks: external.some((sample) => sample.features.markdownLink),
    includesMarkdownHeadings: external.some((sample) => sample.features.markdownHeading),
    includesDuplicatedTitle: input.duplicatedTitles.size > 0,
    includesUnicodeBasename: external.some((sample) => sample.features.unicodeBasename),
    includesUnknownDate: external.some((sample) => sample.features.unknownDate),
    includesUnknownMetadata: external.some((sample) => sample.features.unknownMetadata),
    genericControlTypes: [...new Set(controls.map((sample) => sample.type))].sort(),
    genericControlHasNestedDirectories: controls.some((sample) => sample.features.nestedDirectory),
    externalCoverageWarnings: [...input.externalSelection.coverageWarnings],
    genericControlCoverageWarnings: [...input.controlSelection.coverageWarnings]
  };
}

function assertCoverage(coverage) {
  const required = [
    "includesNestedDirectories",
    "includesLongContent",
    "includesMarkdownLinks",
    "includesMarkdownHeadings",
    "includesDuplicatedTitle",
    "includesUnicodeBasename",
    "includesUnknownDate",
    "includesUnknownMetadata",
    "genericControlHasNestedDirectories"
  ];
  const missing = required.filter((field) => coverage[field] !== true);
  if (missing.length > 0) {
    throw new Error(`Corpus manifest coverage is incomplete: ${missing.join(", ")}`);
  }
  if (coverage.statuses.length < 3 || coverage.types.length < 5) {
    throw new Error("Corpus manifest metadata coverage is incomplete.");
  }
  if (coverage.externalCoverageWarnings.length > 0) {
    throw new Error("Corpus manifest external selection has coverage warnings.");
  }
}

function assertInput(input) {
  if (!input || typeof input !== "object") throw new Error("Corpus manifest input is required.");
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(input.createdAt)) {
    throw new Error("Corpus manifest creation time must be ISO-8601.");
  }
  if (
    typeof input.corpusName !== "string"
    || input.corpusName.trim().length === 0
    || /[\\/]/u.test(input.corpusName)
  ) {
    throw new Error("Corpus manifest name must be a basename without path separators.");
  }
  if (!Number.isSafeInteger(input.totalCandidateFiles) || input.totalCandidateFiles < 200) {
    throw new Error("Corpus manifest candidate count is invalid.");
  }
  if (!Array.isArray(input.externalSelection?.samples)) {
    throw new Error("Corpus manifest external selection is required.");
  }
  if (!Array.isArray(input.controlSelection?.samples)) {
    throw new Error("Corpus manifest control selection is required.");
  }
  if (typeof input.readText !== "function") {
    throw new Error("Corpus manifest text reader is required.");
  }
}

function assertRelativeMarkdownPath(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || !value.endsWith(".md")
    || path.posix.isAbsolute(value)
    || value.split("/").includes("..")
  ) {
    throw new Error("Corpus manifest sample path must be a safe relative Markdown path.");
  }
}

function duplicatedValues(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return new Set([...counts].filter(([_value, count]) => count > 1).map(([value]) => value));
}
