export const OKF_V02_PINNED_REVISION =
  "930b65fc3f5619d5d0591f88c72ebae8b848d60d";
export const OKF_V02_MARKDOWN_COUNT = 78;
export const OKF_V02_RESERVED_MARKDOWN_COUNT = 25;
export const OKF_V02_CONCEPT_COUNT = 53;
export const OKF_V01_COMPATIBILITY_COUNT = 147;
export const OKF_V02_E2E_FILE_COUNT = 200;

export function verifyOkfV02OfficialCheckout(input) {
  if (
    typeof input.expectedRevision !== "string"
    || input.expectedRevision !== OKF_V02_PINNED_REVISION
    || input.actualRevision !== input.expectedRevision
  ) {
    throw new Error("The official OKF checkout revision does not match the pinned revision.");
  }
  const markdownPaths = uniqueSafePaths(input.markdownPaths, "official Markdown");
  const reservedPaths = uniqueSafePaths(input.reservedPaths, "reserved Markdown");
  const markdownSet = new Set(markdownPaths);
  if (reservedPaths.some((item) => !markdownSet.has(item))) {
    throw new Error("The reserved Markdown census is outside the official Markdown census.");
  }
  const uploadableConceptCount = markdownPaths.length - reservedPaths.length;
  if (
    markdownPaths.length !== OKF_V02_MARKDOWN_COUNT
    || reservedPaths.length !== OKF_V02_RESERVED_MARKDOWN_COUNT
    || uploadableConceptCount !== OKF_V02_CONCEPT_COUNT
  ) {
    throw new Error("The official OKF Markdown census changed.");
  }
  return {
    markdownCount: markdownPaths.length,
    reservedMarkdownCount: reservedPaths.length,
    uploadableConceptCount
  };
}

export function selectOkfV01CompatibilityFiles(files, count = OKF_V01_COMPATIBILITY_COUNT) {
  if (count !== OKF_V01_COMPATIBILITY_COUNT || !Array.isArray(files)) {
    throw new Error(`The compatibility corpus must select exactly ${OKF_V01_COMPATIBILITY_COUNT} files.`);
  }
  const normalized = files.map((file) => normalizeFixtureFile(file, "legacy"));
  const paths = normalized.map((file) => file.relativePath);
  if (new Set(paths).size !== paths.length) {
    throw new Error("The compatibility corpus contains duplicate paths.");
  }
  if (normalized.length < count) {
    throw new Error(`The compatibility corpus must contain at least ${count} safe Markdown files.`);
  }
  return normalized
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .slice(0, count);
}

export function buildOkfV02FixtureManifest(input) {
  if (
    !Array.isArray(input.official)
    || input.official.length !== OKF_V02_CONCEPT_COUNT
    || !Array.isArray(input.legacy)
    || input.legacy.length !== OKF_V01_COMPATIBILITY_COUNT
  ) {
    throw new Error("The OKF 0.2 E2E manifest must contain 53 official and 147 legacy files.");
  }
  const entries = [
    ...input.official.map((file) => manifestEntry(file, "official", "native-v02")),
    ...input.legacy.map((file) => manifestEntry(file, "legacy", "legacy-v01"))
  ];
  if (entries.length !== OKF_V02_E2E_FILE_COUNT) {
    throw new Error("The OKF 0.2 E2E manifest must contain exactly 200 files.");
  }
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error("The OKF 0.2 E2E manifest contains duplicate staged paths.");
  }
  return { entries };
}

export function summarizeOkfV02FixtureRun(input) {
  return {
    runId: safeRunId(input.runId),
    sourceRoots: {
      official: "<PINNED_GOOGLE_OKF_CHECKOUT>",
      legacy: "<OKF_V01_COMPAT_CORPUS_DIR>"
    },
    cleanup: normalizeOwnedResources(input.ownedResources)
  };
}

function manifestEntry(file, prefix, compatibility) {
  const normalized = normalizeFixtureFile(file, prefix);
  return {
    path: `${prefix}/${normalized.relativePath}`,
    checksumSha256: normalized.checksumSha256,
    sizeBytes: normalized.sizeBytes,
    compatibility
  };
}

function normalizeFixtureFile(file, label) {
  if (!file || typeof file !== "object") {
    throw new Error(`The ${label} fixture entry is invalid.`);
  }
  const relativePath = normalizeRelativePath(file.relativePath);
  if (!relativePath.toLowerCase().endsWith(".md")) {
    throw new Error(`The ${label} fixture path must identify Markdown.`);
  }
  if (!/^[a-f0-9]{64}$/u.test(file.checksumSha256)) {
    throw new Error(`The ${label} fixture checksum is invalid.`);
  }
  if (
    file.sizeBytes !== undefined
    && (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0)
  ) {
    throw new Error(`The ${label} fixture size is invalid.`);
  }
  return {
    relativePath,
    checksumSha256: file.checksumSha256,
    ...(file.sizeBytes === undefined ? {} : { sizeBytes: file.sizeBytes })
  };
}

function uniqueSafePaths(values, label) {
  if (!Array.isArray(values)) throw new Error(`The ${label} census is invalid.`);
  const normalized = values.map(normalizeRelativePath);
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`The ${label} census contains duplicate paths.`);
  }
  return normalized;
}

function normalizeRelativePath(value) {
  if (typeof value !== "string") throw new Error("Fixture path must be a string.");
  const normalized = value.normalize("NFC").replaceAll("\\", "/");
  if (
    !normalized
    || normalized.startsWith("/")
    || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
    || /[\u0000-\u001F\u007F]/u.test(normalized)
  ) throw new Error("Fixture path is not a safe normalized relative path.");
  return normalized;
}

function safeRunId(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/u.test(value)) {
    throw new Error("The OKF 0.2 E2E run ID is invalid.");
  }
  return value;
}

function normalizeOwnedResources(value) {
  const input = value && typeof value === "object" ? value : {};
  const keys = [
    "knowledgeBaseIds",
    "openApiKeyIds",
    "uploadSessionIds",
    "webhookIds",
    "operationIds",
    "searchIndexes",
    "temporaryPaths",
    "evidenceArtifacts"
  ];
  return Object.fromEntries(keys.map((key) => [
    key,
    normalizeOwnedResourceValues(key, input[key])
  ]));
}

function normalizeOwnedResourceValues(key, value) {
  const values = Array.isArray(value)
    ? value.filter((item) => typeof item === "string")
    : [];
  if (key === "temporaryPaths") {
    return values.length > 0 ? ["<RUN_WORKSPACE>"] : [];
  }
  if (key === "evidenceArtifacts") {
    return values.length > 0 ? ["<RUN_EVIDENCE>"] : [];
  }
  return values;
}
