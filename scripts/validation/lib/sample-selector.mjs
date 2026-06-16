import fs from "node:fs";
import path from "node:path";

export const DEFAULT_SAMPLE_COUNT = 24;
export const LARGE_SCALE_DEFAULT_BATCH_SAMPLE_COUNT = 50;
export const SAMPLE_SOURCE_ENV = "FOCOWIKI_VALIDATION_MARKDOWN_DIR";
export const SAMPLE_PROFILE_ENV = "FOCOWIKI_VALIDATION_PROFILE";
export const SAMPLE_COUNT_ENV = "FOCOWIKI_VALIDATION_SAMPLE_COUNT";
export const BATCH_SAMPLE_COUNT_ENV = "FOCOWIKI_VALIDATION_BATCH_SAMPLE_COUNT";
export const LARGE_SCALE_MIN_BATCH_FILES_ENV = "FOCOWIKI_VALIDATION_MIN_BATCH_FILES";
export const SINGLE_SAMPLE_ENV = "FOCOWIKI_VALIDATION_SINGLE_SAMPLE_BASENAME";
export const MAX_CANDIDATE_PROFILES_ENV = "FOCOWIKI_VALIDATION_MAX_CANDIDATE_PROFILES";
export const REQUIRED_SAMPLE_COVERAGE = {
  statuses: ["有效", "已修改", "尚未生效"],
  types: ["法律", "行政法规", "地方性法规", "司法解释", "监察法规"]
};

const MAX_METADATA_BYTES = 256 * 1024;
const COMMON_METADATA_KEYS = new Set([
  "title",
  "type",
  "status",
  "category",
  "description",
  "tags",
  "publicationDate",
  "effectiveDate",
  "sourceUrl",
  "officialId",
  "issuer",
  "region",
  "resource",
  "timestamp"
]);

export function selectSamplesFromEnvironment(env = process.env) {
  const sourceDir = env[SAMPLE_SOURCE_ENV];

  if (!sourceDir) {
    throw new Error(`${SAMPLE_SOURCE_ENV} must be set to a local Markdown directory.`);
  }

  const sampleCount = readSampleCount(env);
  return selectSamples(sourceDir, sampleCount, {
    maxCandidateProfiles: readMaxCandidateProfiles(env, sampleCount)
  });
}

export function selectSingleAndBatchSamplesFromEnvironment(env = process.env) {
  const sourceDir = env[SAMPLE_SOURCE_ENV];

  if (!sourceDir) {
    throw new Error(`${SAMPLE_SOURCE_ENV} must be set to a local Markdown directory.`);
  }

  const profile = readSampleProfile(env);
  const largeScaleMinBatchFiles =
    profile === "large-scale" ? readLargeScaleMinBatchFiles(env) : null;
  const defaultTotalCount = readSampleCount(env);
  const batchSampleCount = readBatchSampleCount(env, defaultTotalCount, {
    profile,
    largeScaleMinBatchFiles
  });
  const poolCount = batchSampleCount + 1;

  return selectSingleAndBatchSamples(sourceDir, {
    batchSampleCount,
    singleSampleBasename: env[SINGLE_SAMPLE_ENV]?.trim() || "",
    maxCandidateProfiles: readMaxCandidateProfiles(env, poolCount),
    profile,
    largeScaleMinBatchFiles
  });
}

export function selectSingleAndBatchSamples(
  sourceDir,
  {
    batchSampleCount = DEFAULT_SAMPLE_COUNT - 1,
    singleSampleBasename = "",
    maxCandidateProfiles,
    profile = "default",
    largeScaleMinBatchFiles = null
  } = {}
) {
  if (!Number.isSafeInteger(batchSampleCount) || batchSampleCount < 2) {
    throw new Error(`${BATCH_SAMPLE_COUNT_ENV} must be an integer greater than or equal to 2.`);
  }

  if (
    profile === "large-scale" &&
    Number.isSafeInteger(largeScaleMinBatchFiles) &&
    batchSampleCount < largeScaleMinBatchFiles
  ) {
    throw new Error(
      `${LARGE_SCALE_MIN_BATCH_FILES_ENV} requires at least ${largeScaleMinBatchFiles} batch Markdown files for the large-scale profile.`
    );
  }

  const poolCount = Math.max(batchSampleCount + 1, 14);
  const selectedPool = selectSamplesForProfile(sourceDir, poolCount, {
    maxCandidateProfiles,
    profile,
    largeScaleMinBatchFiles
  });
  const singleSample = singleSampleBasename
    ? selectedPool.samples.find((sample) => sample.basename === singleSampleBasename)
    : selectedPool.samples[0];

  if (!singleSample) {
    throw new Error(`${SINGLE_SAMPLE_ENV} did not match a selected Markdown sample.`);
  }

  const batchSamples = selectedPool.samples
    .filter((sample) => sample.basename !== singleSample.basename)
    .slice(0, batchSampleCount);

  if (batchSamples.length !== batchSampleCount) {
    throw new Error(`Expected ${batchSampleCount} batch samples, selected ${batchSamples.length}.`);
  }

  const duplicateNames = duplicatedNormalizedBasenames([singleSample, ...batchSamples]);

  if (duplicateNames.length > 0) {
    throw new Error(`Selected samples contain duplicate normalized filenames: ${duplicateNames.join(", ")}`);
  }

  const flowSamples = [singleSample, ...batchSamples];

  return {
    samples: flowSamples,
    singleSample,
    batchSamples,
    sampleCount: flowSamples.length,
    batchSampleCount,
    profile,
    largeScaleMinBatchFiles,
    coverage: sampleCoverage(flowSamples),
    coverageWarnings: selectedPool.coverageWarnings,
    selectionPoolCoverage: selectedPool.coverage,
    scannedCandidateProfiles: selectedPool.scannedCandidateProfiles
  };
}

function selectSamplesForProfile(sourceDir, poolCount, options) {
  try {
    return selectSamples(sourceDir, poolCount, {
      maxCandidateProfiles: options.maxCandidateProfiles
    });
  } catch (error) {
    if (
      options.profile === "large-scale" &&
      Number.isSafeInteger(options.largeScaleMinBatchFiles) &&
      error instanceof Error &&
      error.message.startsWith("Expected at least")
    ) {
      throw new Error(
        `${LARGE_SCALE_MIN_BATCH_FILES_ENV} requires at least ${options.largeScaleMinBatchFiles} batch Markdown files for the large-scale profile.`
      );
    }

    throw error;
  }
}

export function selectSamples(sourceDir, sampleCount = DEFAULT_SAMPLE_COUNT, options = {}) {
  const absoluteSourceDir = path.resolve(sourceDir);

  if (!fs.existsSync(absoluteSourceDir) || !fs.statSync(absoluteSourceDir).isDirectory()) {
    throw new Error(`${SAMPLE_SOURCE_ENV} must point to an existing directory.`);
  }

  const files = collectMarkdownFiles(absoluteSourceDir).sort(compareCandidatePath);
  const maxCandidateProfiles = options.maxCandidateProfiles ?? files.length;
  const candidates = [];
  let scannedCandidateProfiles = 0;

  for (const file of files) {
    if (scannedCandidateProfiles >= maxCandidateProfiles) {
      break;
    }

    scannedCandidateProfiles += 1;
    const candidate = readSampleCandidateProfile(file);

    if (candidate) {
      candidates.push(candidate);
    }

    if (candidates.length >= sampleCount && hasCoreCandidateCoverage(candidates)) {
      break;
    }
  }

  if (candidates.length < sampleCount) {
    throw new Error(
      `Expected at least ${sampleCount} upload-ready Markdown candidates, found ${candidates.length} after scanning ${scannedCandidateProfiles} candidate profiles.`
    );
  }

  const selected = [];
  const selectedNames = new Set();

  for (const status of REQUIRED_SAMPLE_COVERAGE.statuses) {
    addFirstMatching(selected, selectedNames, candidates, (candidate) => candidate.status === status);
  }

  for (const type of REQUIRED_SAMPLE_COVERAGE.types) {
    addFirstMatching(selected, selectedNames, candidates, (candidate) => candidate.type === type);
  }

  addFirstMatching(selected, selectedNames, candidates, (candidate) =>
    candidate.basename.includes("__unknown-date__")
  );
  addFirstMatching(selected, selectedNames, candidates, (candidate) => candidate.title.length >= 80);
  addFirstMatching(selected, selectedNames, candidates, (candidate) => candidate.hasNonAsciiBasename);
  addFirstMatching(selected, selectedNames, candidates, (candidate) => candidate.hasUnknownMetadata);

  for (const candidate of duplicatedTitleCandidates(candidates)) {
    addCandidate(selected, selectedNames, candidate);

    if (selected.length >= 14) {
      break;
    }
  }

  for (const candidate of candidates) {
    addCandidate(selected, selectedNames, candidate, sampleCount);

    if (selected.length >= sampleCount) {
      break;
    }
  }

  if (selected.length !== sampleCount) {
    throw new Error(`Expected ${sampleCount} samples, selected ${selected.length}.`);
  }

  const invalid = selected.filter(
    (sample) => !sample.basename.endsWith(".md") || !sample.type || !sample.title || !sample.hasBody
  );

  if (invalid.length > 0) {
    throw new Error(`Selected samples contain invalid Markdown metadata: ${invalid.map((item) => item.basename).join(", ")}`);
  }

  const coverage = sampleCoverage(selected);
  const missingStatuses = REQUIRED_SAMPLE_COVERAGE.statuses.filter(
    (status) => !coverage.statuses.includes(status)
  );
  const missingTypes = REQUIRED_SAMPLE_COVERAGE.types.filter((type) => !coverage.types.includes(type));
  const coverageWarnings = [];

  if (missingStatuses.length > 0) {
    coverageWarnings.push(`Missing optional status coverage: ${missingStatuses.join(", ")}`);
  }

  if (missingTypes.length > 0) {
    coverageWarnings.push(`Missing optional type coverage: ${missingTypes.join(", ")}`);
  }

  if (!coverage.includesUnknownDate) {
    coverageWarnings.push("Missing optional unknown-date filename coverage.");
  }

  if (!coverage.includesLongTitle) {
    coverageWarnings.push("Missing optional long-title coverage.");
  }

  if (!coverage.includesDuplicatedTitle) {
    coverageWarnings.push("Missing optional duplicated-title coverage.");
  }

  return {
    samples: selected,
    coverage,
    coverageWarnings,
    sampleCount,
    scannedCandidateProfiles
  };
}

export function readSampleText(sample) {
  return fs.readFileSync(sample.filePath, "utf8");
}

export function sampleCoverage(samples) {
  const duplicatedTitles = samples
    .map((sample) => sample.title)
    .filter((title, index, titles) => title && titles.indexOf(title) !== index);

  return {
    statuses: Array.from(new Set(samples.map((sample) => sample.status).filter(Boolean))).sort(),
    types: Array.from(new Set(samples.map((sample) => sample.type).filter(Boolean))).sort(),
    categories: Array.from(new Set(samples.map((sample) => sample.category).filter(Boolean))).sort(),
    includesUnknownDate: samples.some((sample) => sample.basename.includes("__unknown-date__")),
    includesLongTitle: samples.some((sample) => sample.title.length >= 80),
    includesDuplicatedTitle: duplicatedTitles.length > 0,
    includesNonAsciiBasename: samples.some((sample) => sample.hasNonAsciiBasename),
    includesUnknownMetadata: samples.some((sample) => sample.hasUnknownMetadata),
    totalSizeBytes: samples.reduce((sum, sample) => sum + sample.sizeBytes, 0)
  };
}

function readSampleCount(env) {
  const configured = env[SAMPLE_COUNT_ENV]?.trim();

  if (!configured) {
    return DEFAULT_SAMPLE_COUNT;
  }

  const parsed = Number(configured);

  if (!Number.isSafeInteger(parsed) || parsed < 14) {
    throw new Error(`${SAMPLE_COUNT_ENV} must be an integer greater than or equal to 14.`);
  }

  return parsed;
}

function readSampleProfile(env) {
  const profile = env[SAMPLE_PROFILE_ENV]?.trim() || "default";

  if (!["default", "large-scale"].includes(profile)) {
    throw new Error(`${SAMPLE_PROFILE_ENV} must be either default or large-scale.`);
  }

  return profile;
}

function readLargeScaleMinBatchFiles(env) {
  const configured = env[LARGE_SCALE_MIN_BATCH_FILES_ENV]?.trim();

  if (!configured) {
    return LARGE_SCALE_DEFAULT_BATCH_SAMPLE_COUNT;
  }

  const parsed = Number(configured);

  if (!Number.isSafeInteger(parsed) || parsed < LARGE_SCALE_DEFAULT_BATCH_SAMPLE_COUNT) {
    throw new Error(
      `${LARGE_SCALE_MIN_BATCH_FILES_ENV} must be an integer greater than or equal to ${LARGE_SCALE_DEFAULT_BATCH_SAMPLE_COUNT}.`
    );
  }

  return parsed;
}

function readBatchSampleCount(env, defaultTotalCount, options = {}) {
  const configured = env[BATCH_SAMPLE_COUNT_ENV]?.trim();
  const largeScaleMinBatchFiles = options.largeScaleMinBatchFiles;

  if (!configured) {
    if (options.profile === "large-scale") {
      return largeScaleMinBatchFiles;
    }

    return Math.max(defaultTotalCount - 1, 2);
  }

  const parsed = Number(configured);

  if (!Number.isSafeInteger(parsed) || parsed < 2) {
    throw new Error(`${BATCH_SAMPLE_COUNT_ENV} must be an integer greater than or equal to 2.`);
  }

  if (
    options.profile === "large-scale" &&
    Number.isSafeInteger(largeScaleMinBatchFiles) &&
    parsed < largeScaleMinBatchFiles
  ) {
    throw new Error(
      `${BATCH_SAMPLE_COUNT_ENV} must be greater than or equal to ${LARGE_SCALE_MIN_BATCH_FILES_ENV} for the large-scale profile.`
    );
  }

  return parsed;
}

function readMaxCandidateProfiles(env, sampleCount) {
  const configured = env[MAX_CANDIDATE_PROFILES_ENV]?.trim();

  if (!configured) {
    return Math.max(sampleCount * 32, 5_000);
  }

  const parsed = Number(configured);

  if (!Number.isSafeInteger(parsed) || parsed < sampleCount) {
    throw new Error(`${MAX_CANDIDATE_PROFILES_ENV} must be an integer greater than or equal to the sample count.`);
  }

  return parsed;
}

function hasCoreCandidateCoverage(candidates) {
  const coverage = sampleCoverage(candidates);
  const hasStatuses = REQUIRED_SAMPLE_COVERAGE.statuses.every((status) =>
    coverage.statuses.includes(status)
  );
  const hasTypes = REQUIRED_SAMPLE_COVERAGE.types.every((type) => coverage.types.includes(type));

  return (
    hasStatuses &&
    hasTypes &&
    coverage.includesUnknownDate &&
    coverage.includesLongTitle &&
    coverage.includesDuplicatedTitle &&
    coverage.includesNonAsciiBasename &&
    coverage.includesUnknownMetadata
  );
}

function duplicatedNormalizedBasenames(samples) {
  const seen = new Set();
  const duplicates = new Set();

  for (const sample of samples) {
    const normalized = sample.basename.trim().toLowerCase();

    if (seen.has(normalized)) {
      duplicates.add(sample.basename);
      continue;
    }

    seen.add(normalized);
  }

  return Array.from(duplicates).sort();
}

function readSampleCandidateProfile(filePath) {
  const basename = path.basename(filePath);
  const stat = fs.statSync(filePath);
  const preview = readFilePrefix(filePath, Math.min(stat.size, MAX_METADATA_BYTES));
  const { frontmatter, bodyOffset, bodyPreview } = splitFrontmatterPreview(preview.text);

  if (!frontmatter) {
    return null;
  }

  const metadata = parseFrontmatter(frontmatter);
  const metadataKeys = Object.keys(metadata).sort();
  const hasBody = bodyPreview.trim().length > 0 || stat.size > bodyOffset;

  if (!metadata.title || !metadata.type || !hasBody) {
    return null;
  }

  return {
    basename,
    filePath,
    title: String(metadata.title ?? ""),
    type: String(metadata.type ?? ""),
    status: String(metadata.status ?? ""),
    category: String(metadata.category ?? ""),
    publicationDate: String(metadata.publicationDate ?? ""),
    hasNonAsciiBasename: /[^\x00-\x7F]/.test(basename),
    hasUnknownMetadata: metadataKeys.some((key) => !COMMON_METADATA_KEYS.has(key)),
    metadataKeys,
    hasBody,
    sizeBytes: stat.size
  };
}

function readFilePrefix(filePath, byteLength) {
  const fd = fs.openSync(filePath, "r");

  try {
    const buffer = Buffer.alloc(byteLength);
    const bytesRead = fs.readSync(fd, buffer, 0, byteLength, 0);
    return {
      text: buffer.toString("utf8", 0, bytesRead),
      bytesRead
    };
  } finally {
    fs.closeSync(fd);
  }
}

function collectMarkdownFiles(sourceDir) {
  const files = [];
  const stack = [sourceDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) {
          stack.push(entryPath);
        }
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(entryPath);
      }
    }
  }

  return files;
}

function compareCandidatePath(left, right) {
  const leftRank = candidatePathRank(left);
  const rightRank = candidatePathRank(right);

  if (leftRank !== rightRank) {
    return rightRank - leftRank;
  }

  return path.basename(left).localeCompare(path.basename(right));
}

function candidatePathRank(filePath) {
  const segments = filePath.split(path.sep);
  let rank = 0;

  if (segments.includes("markdown")) {
    rank += 10;
  }

  if (path.basename(filePath).includes("__")) {
    rank += 5;
  }

  return rank;
}

function splitFrontmatterPreview(text) {
  if (!text.startsWith("---\n")) {
    return { frontmatter: "", bodyOffset: 0, bodyPreview: text };
  }

  const end = text.indexOf("\n---\n", 4);

  if (end === -1) {
    return { frontmatter: "", bodyOffset: 0, bodyPreview: text };
  }

  const bodyStart = end + 5;
  return {
    frontmatter: text.slice(4, end),
    bodyOffset: Buffer.byteLength(text.slice(0, bodyStart), "utf8"),
    bodyPreview: text.slice(bodyStart)
  };
}

function parseFrontmatter(frontmatter) {
  const metadata = {};

  for (const line of frontmatter.split("\n")) {
    const index = line.indexOf(":");

    if (index === -1) {
      continue;
    }

    metadata[line.slice(0, index).trim()] = stripYamlValue(line.slice(index + 1));
  }

  return metadata;
}

function stripYamlValue(value) {
  return String(value ?? "")
    .trim()
    .replace(/^"(.*)"$/s, "$1")
    .replace(/^'(.*)'$/s, "$1");
}

function addFirstMatching(selected, selectedNames, candidates, predicate) {
  const candidate = candidates.find((item) => !selectedNames.has(item.basename) && predicate(item));

  if (!candidate) {
    return;
  }

  addCandidate(selected, selectedNames, candidate);
}

function addCandidate(selected, selectedNames, candidate, sampleCount = DEFAULT_SAMPLE_COUNT) {
  if (selectedNames.has(candidate.basename) || selected.length >= sampleCount) {
    return;
  }

  selected.push(candidate);
  selectedNames.add(candidate.basename);
}

function duplicatedTitleCandidates(candidates) {
  const groups = new Map();

  for (const candidate of candidates) {
    if (!candidate.title) {
      continue;
    }

    const group = groups.get(candidate.title) ?? [];
    group.push(candidate);
    groups.set(candidate.title, group);
  }

  return Array.from(groups.values())
    .filter((group) => group.length > 1)
    .flatMap((group) => group.slice(0, 2))
    .sort((left, right) => left.basename.localeCompare(right.basename));
}
