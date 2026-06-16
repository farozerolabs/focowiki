import { StorageKeyError } from "./storage/keys.js";

const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

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

  if (!isSafeSegment(normalized)) {
    throw new StorageKeyError(`${fieldName} must be a safe path segment`);
  }

  return normalized;
}

function normalizePublicPath(rawPath: string): string {
  const normalized = decodeForValidation(rawPath).replace(/^\/+/, "");
  const segments = normalized.split("/");

  if (segments.some((segment) => !isSafeSegment(segment))) {
    throw new StorageKeyError("path must stay inside the public knowledge base route");
  }

  return segments.join("/");
}

function isSafeSegment(segment: string): boolean {
  return (
    SAFE_TOKEN_PATTERN.test(segment) &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("..") &&
    !segment.includes("\\") &&
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
