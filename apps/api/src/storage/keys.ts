import { AppError } from "../errors.js";

const SAFE_ID_TOKEN_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export type StorageKeyspace = {
  prefix: string;
  knowledgeBaseRootKey: (knowledgeBaseId: string) => string;
  sourceFileKey: (
    knowledgeBaseId: string,
    sourceFileId: string,
    fileName: string
  ) => string;
  sourceRevisionKey: (
    knowledgeBaseId: string,
    sourceFileId: string,
    revisionToken: string
  ) => string;
  uploadSessionEntryKey: (
    knowledgeBaseId: string,
    sessionId: string,
    entryId: string
  ) => string;
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
    knowledgeBaseRootKey: (knowledgeBaseId) => knowledgeBaseRoot(prefix, knowledgeBaseId),
    sourceFileKey: (knowledgeBaseId, sourceFileId, fileName) =>
      `${knowledgeBaseRoot(prefix, knowledgeBaseId)}/sources/${normalizeId(sourceFileId, "sourceFileId")}/${normalizeMarkdownFileName(fileName, "fileName")}`,
    sourceRevisionKey: (knowledgeBaseId, sourceFileId, revisionToken) =>
      `${knowledgeBaseRoot(prefix, knowledgeBaseId)}/sources/${normalizeId(sourceFileId, "sourceFileId")}/revisions/${normalizeId(revisionToken, "revisionToken")}/content.md`,
    uploadSessionEntryKey: (knowledgeBaseId, sessionId, entryId) =>
      `${knowledgeBaseRoot(prefix, knowledgeBaseId)}/upload-sessions/${normalizeId(sessionId, "sessionId")}/entries/${normalizeId(entryId, "entryId")}/content.md`
  };
}

function knowledgeBaseRoot(prefix: string, knowledgeBaseId: string): string {
  return `${prefix}/knowledge-bases/${normalizeId(knowledgeBaseId, "knowledgeBaseId")}`;
}

function normalizePrefix(rawPrefix: string): string {
  let normalized: string;
  try {
    normalized = decodeForValidation(rawPrefix).replace(/^\/+|\/+$/g, "");
  } catch {
    throw new StorageKeyError("S3_PREFIX must be a non-empty relative prefix");
  }
  const segments = normalized.split("/");

  if (segments.length === 0 || segments.some((segment) => !isSafeIdSegment(segment))) {
    throw new StorageKeyError("S3_PREFIX must be a non-empty relative prefix");
  }

  return segments.join("/");
}

function normalizeId(value: string, fieldName: string): string {
  return normalizeFileName(value, fieldName);
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

  try {
    if (decodeURIComponent(decoded) !== decoded) {
      throw new StorageKeyError("path exceeds the percent-decoding limit");
    }
  } catch (error) {
    if (error instanceof StorageKeyError) {
      throw error;
    }
    throw new StorageKeyError("path contains invalid percent encoding");
  }

  return decoded;
}
