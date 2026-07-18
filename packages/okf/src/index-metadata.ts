import type { JsonValue } from "./metadata.js";
import { canonicalizeOptionalGeneratedTextIdentity } from "./text-identity.js";

export type IndexMetadata = Record<string, JsonValue>;

export type IndexMetadataFields = {
  type?: string;
  title?: string;
  description?: string;
  resource?: string;
  timestamp?: string;
  tags?: string[];
  metadata?: IndexMetadata;
};

const INTERNAL_METADATA_KEYS = new Set([
  "accessKeyId",
  "apiKey",
  "api_key",
  "authorization",
  "bucket",
  "bucketName",
  "objectKey",
  "object_key",
  "password",
  "providerPayload",
  "provider_payload",
  "rawUploadPath",
  "raw_upload_path",
  "redisKey",
  "redis_key",
  "releaseId",
  "release_id",
  "s3ObjectKey",
  "s3_object_key",
  "secret",
  "secretAccessKey",
  "sql",
  "sqlDetails",
  "sql_details",
  "storageKey",
  "storage_key",
  "storagePrefix",
  "storage_prefix",
  "taskId",
  "task_id",
  "token"
]);

const PLACEHOLDER_METADATA_VALUES = new Set([
  "-",
  "n/a",
  "na",
  "none",
  "not applicable",
  "not provided",
  "placeholder",
  "tbd",
  "unknown",
  "undefined"
]);

export function buildIndexMetadataFields(input: unknown): IndexMetadataFields {
  const metadata = sanitizeIndexMetadata(input);

  if (!metadata) {
    return {};
  }

  const fields: IndexMetadataFields = { metadata };
  const type = readIdentity(metadata.type, "type");
  const title = readIdentity(metadata.title, "title");
  const description = readIdentity(metadata.description, "description");
  const resource = readString(metadata.resource);
  const timestamp = readIdentity(metadata.timestamp, "timestamp");
  const tags = readIdentityArray(metadata.tags, "tag");

  if (type) {
    fields.type = type;
  }

  if (title) {
    fields.title = title;
  }

  if (description) {
    fields.description = description;
  }

  if (resource) {
    fields.resource = resource;
  }

  if (timestamp) {
    fields.timestamp = timestamp;
  }

  if (tags) {
    fields.tags = tags;
  }

  return fields;
}

export function sanitizeIndexMetadata(input: unknown): IndexMetadata | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const entries = Object.entries(input)
    .map(([key, value]) => [key, sanitizeMetadataValue(key, value)] as const)
    .filter((entry): entry is readonly [string, JsonValue] => entry[1] !== undefined);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function sanitizeMetadataValue(key: string, value: unknown): JsonValue | undefined {
  if (INTERNAL_METADATA_KEYS.has(key) || value === undefined) {
    return undefined;
  }

  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed && !isPlaceholderMetadataString(trimmed) && !isUnsafeMetadataString(trimmed)
      ? trimmed
      : undefined;
  }

  if (Array.isArray(value)) {
    const values = value
      .map((item) => sanitizeMetadataValue(key, item))
      .filter((item): item is JsonValue => item !== undefined);

    return values.length > 0 ? values : undefined;
  }

  if (isRecord(value)) {
    return sanitizeIndexMetadata(value);
  }

  return undefined;
}

function isPlaceholderMetadataString(value: string): boolean {
  return PLACEHOLDER_METADATA_VALUES.has(value.toLowerCase());
}

function isUnsafeMetadataString(value: string): boolean {
  return (
    /^file:\/\//i.test(value) ||
    /^s3:\/\//i.test(value) ||
    /^\/(?:Users|home|private|var|tmp|etc)\b/.test(value) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /(?:^|\/)knowledge-bases\/[^/]+\/(?:uploads|releases)\//.test(value)
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readIdentity(value: unknown, field: string): string | undefined {
  return canonicalizeOptionalGeneratedTextIdentity(value, field) ?? undefined;
}

function readIdentityArray(value: unknown, field: string): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value.flatMap((item) => {
    const canonical = canonicalizeOptionalGeneratedTextIdentity(item, field);
    return canonical ? [canonical] : [];
  });

  return strings.length > 0 ? strings : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
