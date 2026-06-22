import { AppError } from "../errors.js";

const BUNDLE_ROOT_FILES = new Set(["index.md", "log.md", "schema.md"]);
const INDEX_FILES = new Set(["manifest.json", "search.json", "links.json"]);
const INDEX_SHARD_DIRECTORIES = new Set(["manifest", "search", "links"]);
const GRAPH_ROOT_FILES = new Set(["index.md", "manifest.json", "nodes.jsonl"]);
const SAFE_ID_TOKEN_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export type CurrentPointer = {
  runId: string;
  publishedAt: string;
};

export type StorageKeyspace = {
  prefix: string;
  sourceFileKey: (
    knowledgeBaseId: string,
    sourceFileId: string,
    fileName: string
  ) => string;
  releaseRootKey: (knowledgeBaseId: string, releaseId: string) => string;
  releaseBundleKey: (knowledgeBaseId: string, releaseId: string, logicalPath: string) => string;
  currentPointerKey: () => string;
  currentBundleKey: (pointer: CurrentPointer, logicalPath: string) => string;
  runBundleKey: (runId: string, logicalPath: string) => string;
  runUploadKey: (runId: string, fileName: string) => string;
};

export class StorageKeyError extends AppError {
  public constructor(message: string) {
    super("STORAGE_KEY", message, {
      expose: true,
      status: 400
    });
    this.name = "StorageKeyError";
  }
}

export function createStorageKeyspace(rawPrefix: string): StorageKeyspace {
  const prefix = normalizePrefix(rawPrefix);

  return {
    prefix,
    sourceFileKey: (knowledgeBaseId, sourceFileId, fileName) =>
      `${knowledgeBaseRoot(prefix, knowledgeBaseId)}/sources/${normalizeId(sourceFileId, "sourceFileId")}/${normalizeMarkdownFileName(fileName, "fileName")}`,
    releaseRootKey: (knowledgeBaseId, releaseId) =>
      `${knowledgeBaseRoot(prefix, knowledgeBaseId)}/releases/${normalizeId(releaseId, "releaseId")}/bundle/`,
    releaseBundleKey: (knowledgeBaseId, releaseId, logicalPath) =>
      `${knowledgeBaseRoot(prefix, knowledgeBaseId)}/releases/${normalizeId(releaseId, "releaseId")}/bundle/${normalizeBundlePath(logicalPath)}`,
    currentPointerKey: () => `${prefix}/current.json`,
    currentBundleKey: (pointer, logicalPath) =>
      `${prefix}/runs/${normalizeRunId(pointer.runId)}/bundle/${normalizeBundlePath(logicalPath)}`,
    runBundleKey: (runId, logicalPath) =>
      `${prefix}/runs/${normalizeRunId(runId)}/bundle/${normalizeBundlePath(logicalPath)}`,
    runUploadKey: (runId, fileName) =>
      `${prefix}/runs/${normalizeRunId(runId)}/uploads/${normalizeFileName(fileName, "fileName")}`
  };
}

function knowledgeBaseRoot(prefix: string, knowledgeBaseId: string): string {
  return `${prefix}/knowledge-bases/${normalizeId(knowledgeBaseId, "knowledgeBaseId")}`;
}

export function parseCurrentPointer(raw: string): CurrentPointer {
  const parsed = parsePointerJson(raw);
  const runId = normalizeRunId(parsed.runId);
  const publishedAt = parsed.publishedAt;

  if (!publishedAt || Number.isNaN(Date.parse(publishedAt))) {
    throw new StorageKeyError("publishedAt must be an ISO timestamp");
  }

  return {
    runId,
    publishedAt
  };
}

export function serializeCurrentPointer(pointer: CurrentPointer): string {
  const normalized = parseCurrentPointer(JSON.stringify(pointer));
  return `${JSON.stringify(normalized)}\n`;
}

function parsePointerJson(raw: string): CurrentPointer {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StorageKeyError("current pointer must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new StorageKeyError("current pointer must be an object");
  }

  const candidate = parsed as Partial<Record<keyof CurrentPointer, unknown>>;

  if (typeof candidate.runId !== "string") {
    throw new StorageKeyError("runId is required");
  }

  if (typeof candidate.publishedAt !== "string") {
    throw new StorageKeyError("publishedAt is required");
  }

  return {
    runId: candidate.runId,
    publishedAt: candidate.publishedAt
  };
}

function normalizePrefix(rawPrefix: string): string {
  const normalized = decodeForValidation(rawPrefix).replace(/^\/+|\/+$/g, "");
  const segments = normalized.split("/");

  if (segments.length === 0 || segments.some((segment) => !isSafeIdSegment(segment))) {
    throw new StorageKeyError("S3_PREFIX must be a non-empty relative prefix");
  }

  return segments.join("/");
}

function normalizeRunId(runId: string): string {
  return normalizeFileName(runId, "runId");
}

function normalizeId(value: string, fieldName: string): string {
  return normalizeFileName(value, fieldName);
}

function normalizeBundlePath(rawPath: string): string {
  const normalized = decodeForValidation(rawPath).replace(/^\/+/, "");
  const segments = normalized.split("/");

  if (segments.some((segment) => !isSafePathSegment(segment))) {
    throw new StorageKeyError("path must stay inside the bundle root");
  }

  if (segments.length === 1 && BUNDLE_ROOT_FILES.has(segments[0] ?? "")) {
    return segments.join("/");
  }

  if (segments[0] === "_graph") {
    return normalizeGraphBundlePath(segments);
  }

  const [directory, fileName] = segments;

  if (directory === "pages") {
    if (segments.length !== 2) {
      throw new StorageKeyError("path is not an allowed public bundle path");
    }

    return `${directory}/${normalizeMarkdownFileName(fileName ?? "", "path")}`;
  }

  if (directory === "_index") {
    if (segments.length === 3) {
      return normalizeIndexShardBundlePath(segments);
    }

    if (segments.length !== 2) {
      throw new StorageKeyError("path is not an allowed public bundle path");
    }

    if (!fileName || !INDEX_FILES.has(fileName)) {
      throw new StorageKeyError("path must reference an allowed JSON index file");
    }

    return `${directory}/${fileName}`;
  }

  throw new StorageKeyError("path is not an allowed public bundle path");
}

function normalizeIndexShardBundlePath(segments: string[]): string {
  const [, directory, fileName] = segments;

  if (!directory || !INDEX_SHARD_DIRECTORIES.has(directory)) {
    throw new StorageKeyError("path must reference an allowed index shard directory");
  }

  if (!fileName || !/^[0-9]{6}\.jsonl$/.test(fileName)) {
    throw new StorageKeyError("path must reference an allowed index shard file");
  }

  return segments.join("/");
}

function normalizeGraphBundlePath(segments: string[]): string {
  if (segments.length === 2) {
    const [, fileName] = segments;

    if (!fileName || !GRAPH_ROOT_FILES.has(fileName)) {
      throw new StorageKeyError("path must reference an allowed graph root file");
    }

    return segments.join("/");
  }

  if (segments.length === 3 && segments[1] === "edges") {
    const fileName = segments[2] ?? "";

    if (!/^[0-9]{4}\.jsonl$/.test(fileName)) {
      throw new StorageKeyError("path must reference an allowed graph edge shard");
    }

    return segments.join("/");
  }

  if (segments.length === 3 && segments[1] === "by-file") {
    const fileName = segments[2] ?? "";

    if (!fileName.endsWith(".json") || !isSafePathSegment(fileName)) {
      throw new StorageKeyError("path must reference an allowed graph file");
    }

    return segments.join("/");
  }

  throw new StorageKeyError("path is not an allowed public bundle path");
}

function normalizeFileName(value: string, fieldName: string): string {
  const normalized = decodeForValidation(value);

  if (!isSafeIdSegment(normalized)) {
    throw new StorageKeyError(`${fieldName} must be a safe path segment`);
  }

  return normalized;
}

function normalizeMarkdownFileName(value: string, fieldName: string): string {
  const normalized = decodeForValidation(value).trim();

  if (!normalized.toLowerCase().endsWith(".md") || !isSafePathSegment(normalized)) {
    throw new StorageKeyError(`${fieldName} must be a safe Markdown file name`);
  }

  return normalized;
}

function isSafeIdSegment(segment: string): boolean {
  return (
    SAFE_ID_TOKEN_PATTERN.test(segment) &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("..") &&
    !segment.includes("\\") &&
    !segment.includes("/")
  );
}

function isSafePathSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("..") &&
    !segment.includes("\\") &&
    !segment.includes("/") &&
    !/[\u0000-\u001F\u007F]/.test(segment)
  );
}

function decodeForValidation(value: string): string {
  let decoded = value.trim();

  for (let index = 0; index < 3; index += 1) {
    try {
      const next = decodeURIComponent(decoded);

      if (next === decoded) {
        return next;
      }

      decoded = next;
    } catch {
      throw new StorageKeyError("path contains invalid percent encoding");
    }
  }

  return decoded;
}
