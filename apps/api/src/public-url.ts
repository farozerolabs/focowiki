import { StorageKeyError } from "./storage/keys.js";

const SAFE_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const UNSAFE_PUBLIC_SEGMENT_PATTERN = /[\u0000-\u001F\u007F\\]/u;
const ALLOWED_PUBLIC_PATH_PATTERNS = [
  /^index\.md$/u,
  /^schema\.md$/u,
  /^log\.md$/u,
  /^pages\/[^/]+\.md$/u,
  /^_index\/(?:manifest|search|links)\.json$/u,
  /^_index\/(?:manifest|search|links)\/[0-9]{6}\.jsonl$/u,
  /^_graph\/index\.md$/u,
  /^_graph\/manifest\.json$/u,
  /^_graph\/nodes\.jsonl$/u,
  /^_graph\/nodes\/[0-9]{4}\.jsonl$/u,
  /^_graph\/edges\/[0-9]{4}\.jsonl$/u,
  /^_graph\/by-file\/[^/]+\.json$/u
];

export function buildPublicFileUrl(
  baseUrl: string,
  knowledgeBaseId: string,
  logicalPath: string
): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/openapi/v1/knowledge-bases/${normalizeId(
    knowledgeBaseId,
    "knowledgeBaseId"
  )}/files/content?path=${encodeURIComponent(normalizePublicPath(logicalPath))}`;
}

function normalizeId(value: string, fieldName: string): string {
  const normalized = decodeForValidation(value);

  if (!isSafeIdSegment(normalized)) {
    throw new StorageKeyError(`${fieldName} must be a safe path segment`);
  }

  return normalized;
}

function normalizePublicPath(rawPath: string): string {
  const normalized = decodeForValidation(rawPath).replace(/^\/+/, "");
  const segments = normalized.split("/");

  if (
    segments.some((segment) => !isSafePublicPathSegment(segment)) ||
    !ALLOWED_PUBLIC_PATH_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    throw new StorageKeyError("path must stay inside the public knowledge base route");
  }

  return segments.join("/");
}

function isSafeIdSegment(segment: string): boolean {
  return (
    SAFE_ID_PATTERN.test(segment) &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("..") &&
    !segment.includes("\\") &&
    !segment.includes("/")
  );
}

function isSafePublicPathSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("..") &&
    !UNSAFE_PUBLIC_SEGMENT_PATTERN.test(segment) &&
    !segment.includes("/")
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
