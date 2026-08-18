import { validationError } from "./errors.js";

export const KNOWLEDGE_BASE_NAME_MAX_BYTES = 255;
export const KNOWLEDGE_BASE_DESCRIPTION_MAX_BYTES = 16_384;

export function readKnowledgeBaseName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw validationError("Knowledge-base name must be a non-empty string.", {
      field: "name"
    });
  }
  const normalized = value.trim();
  assertUtf8ByteLimit(normalized, KNOWLEDGE_BASE_NAME_MAX_BYTES, "name");
  return normalized;
}

export function readKnowledgeBaseDescription(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw validationError("Knowledge-base description must be a string or null.", {
      field: "description"
    });
  }
  const normalized = value.trim();
  assertUtf8ByteLimit(
    normalized,
    KNOWLEDGE_BASE_DESCRIPTION_MAX_BYTES,
    "description"
  );
  return normalized || null;
}

function assertUtf8ByteLimit(value: string, maximumBytes: number, field: string): void {
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw validationError(`Knowledge-base ${field} exceeds its UTF-8 byte limit.`, {
      field,
      maximumBytes
    });
  }
}
