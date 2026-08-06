import { createHash } from "node:crypto";
import path from "node:path";

export const STORAGE_VNEXT_SCALE_FILE_COUNT = 10_000;

export function buildStorageVnextScaleCorpusManifest(input) {
  const expectedFileCount = expectedCount(input?.expectedFileCount);
  assertInput(input, expectedFileCount);
  const files = [];
  const normalizedPaths = new Set();
  let totalSizeBytes = 0;

  for (const sample of input.samples) {
    const relativePath = normalizeRelativePath(sample.relativePath);
    const normalizedPath = relativePath.normalize("NFC");
    if (normalizedPaths.has(normalizedPath)) {
      throw new Error(`Scale corpus contains a duplicate normalized path: ${relativePath}`);
    }
    normalizedPaths.add(normalizedPath);
    const bytes = input.readBytes(sample);
    if (!(bytes instanceof Uint8Array)) {
      throw new Error(`Scale corpus reader returned invalid bytes: ${relativePath}`);
    }
    if (bytes.byteLength !== sample.sizeBytes) {
      throw new Error(`Scale corpus file size changed: ${relativePath}`);
    }
    totalSizeBytes += bytes.byteLength;
    if (!Number.isSafeInteger(totalSizeBytes)) {
      throw new Error("Scale corpus byte count is unsafe");
    }
    files.push({
      relativePath,
      sizeBytes: bytes.byteLength,
      checksumSha256: digest(bytes)
    });
  }

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const manifestChecksumSha256 = digest(JSON.stringify(files));
  return {
    schemaVersion: 1,
    kind: "storage-vnext-scale-corpus-manifest",
    changeName: "implement-breaking-storage-vnext",
    createdAt: input.createdAt,
    corpusName: input.corpusName,
    totalCandidateFiles: input.totalCandidateFiles,
    fileCount: files.length,
    totalSizeBytes,
    selectionStrategy: input.selectionStrategy ?? "deterministic-metadata-coverage-v1",
    manifestChecksumSha256,
    files
  };
}

export function validateStorageVnextScaleCorpusManifest(manifest, options = {}) {
  const expectedFileCount = expectedCount(options.expectedFileCount);
  if (
    !manifest
    || manifest.schemaVersion !== 1
    || manifest.kind !== "storage-vnext-scale-corpus-manifest"
    || manifest.changeName !== "implement-breaking-storage-vnext"
    || manifest.fileCount !== expectedFileCount
    || !Array.isArray(manifest.files)
    || manifest.files.length !== expectedFileCount
  ) throw new Error("Scale corpus manifest is invalid");

  const files = manifest.files.map((file) => ({
    relativePath: normalizeRelativePath(file.relativePath),
    sizeBytes: safeNonnegativeInteger(file.sizeBytes, "Scale corpus file size is invalid"),
    checksumSha256: checksum(file.checksumSha256)
  }));
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (digest(JSON.stringify(files)) !== manifest.manifestChecksumSha256) {
    throw new Error("Scale corpus manifest checksum does not match");
  }
  const totalSizeBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
  if (totalSizeBytes !== manifest.totalSizeBytes) {
    throw new Error("Scale corpus total byte count does not match");
  }
  if (new Set(files.map((file) => file.relativePath.normalize("NFC"))).size !== files.length) {
    throw new Error("Scale corpus paths are not unique");
  }
  return { ...manifest, files };
}

function assertInput(input, expectedFileCount) {
  if (!input || typeof input !== "object") throw new Error("Scale corpus input is required");
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(input.createdAt ?? "")) {
    throw new Error("Scale corpus creation time must be ISO-8601");
  }
  if (
    typeof input.corpusName !== "string"
    || !input.corpusName.trim()
    || /[\\/]/u.test(input.corpusName)
  ) throw new Error("Scale corpus name must be a basename");
  if (
    !Number.isSafeInteger(input.totalCandidateFiles)
    || input.totalCandidateFiles < expectedFileCount
  ) throw new Error("Scale corpus candidate count is invalid");
  if (
    !Array.isArray(input.samples)
    || input.samples.length !== expectedFileCount
  ) throw new Error(
    `Scale corpus requires exactly ${expectedFileCount.toLocaleString("en-US")} Markdown files`
  );
  if (
    input.selectionStrategy !== undefined
    && (typeof input.selectionStrategy !== "string" || !input.selectionStrategy.trim())
  ) throw new Error("Scale corpus selection strategy is invalid");
  if (typeof input.readBytes !== "function") {
    throw new Error("Scale corpus byte reader is required");
  }
}

function expectedCount(value) {
  const count = value ?? STORAGE_VNEXT_SCALE_FILE_COUNT;
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("Scale corpus expected file count is invalid");
  }
  return count;
}

function normalizeRelativePath(value) {
  if (
    typeof value !== "string"
    || !value.endsWith(".md")
    || path.posix.isAbsolute(value)
    || value.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new Error("Scale corpus path must be a safe relative Markdown path");
  return value.normalize("NFC");
}

function checksum(value) {
  if (!/^[a-f0-9]{64}$/u.test(value ?? "")) {
    throw new Error("Scale corpus checksum is invalid");
  }
  return value;
}

function safeNonnegativeInteger(value, message) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(message);
  return value;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
