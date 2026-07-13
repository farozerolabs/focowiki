import {
  normalizeGeneratedLogicalPath,
  SourcePathValidationError
} from "@focowiki/okf";
import { StorageKeyError } from "./storage/keys.js";

const SAFE_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export function buildPublicFileUrl(
  baseUrl: string,
  knowledgeBaseId: string,
  logicalPath: string
): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/openapi/v2/knowledge-bases/${normalizeId(
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
  try {
    return normalizeGeneratedLogicalPath(normalized);
  } catch (error) {
    if (!(error instanceof SourcePathValidationError)) {
      throw error;
    }
    throw new StorageKeyError("path must stay inside the public knowledge base route");
  }
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
