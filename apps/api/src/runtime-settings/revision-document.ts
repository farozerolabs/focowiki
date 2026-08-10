import { createHash } from "node:crypto";
import type { RuntimeSettingKey } from "./types.js";

const SCHEMA_VERSION = "storage-vnext-settings-v1" as const;
const MAXIMUM_DOCUMENT_BYTES = 65_536;
const SETTING_KEYS: readonly RuntimeSettingKey[] = [
  "rate_limits",
  "worker",
  "publication",
  "graph",
  "maintenance",
  "semantic",
  "search"
];

export type StorageVnextRuntimeSettingsRevisionDocument = {
  schemaVersion: typeof SCHEMA_VERSION;
  version: number;
  source: "bootstrap" | "admin";
  sections: Partial<Record<RuntimeSettingKey, unknown>>;
};

export type StorageVnextRuntimeSettingsRevision = {
  publicId: string;
  checksum: string;
  document: StorageVnextRuntimeSettingsRevisionDocument;
};

export type StorageVnextRuntimeSettingsRevisionErrorCode =
  | "invalid_revision"
  | "revision_conflict"
  | "revision_too_large";

export class StorageVnextRuntimeSettingsRevisionError extends Error {
  public constructor(
    public readonly code: StorageVnextRuntimeSettingsRevisionErrorCode
  ) {
    super(`Storage vNext runtime settings revision error: ${code}`);
    this.name = "StorageVnextRuntimeSettingsRevisionError";
  }
}

export function createStorageVnextRuntimeSettingsRevision(input: {
  current: StorageVnextRuntimeSettingsRevisionDocument | null;
  key: RuntimeSettingKey;
  value: unknown;
  source: "bootstrap" | "admin";
}): StorageVnextRuntimeSettingsRevision {
  assertKey(input.key);
  if (!isRecord(input.value)) throw revisionError("invalid_revision");
  const current = input.current === null ? null : readDocument(input.current);
  const document: StorageVnextRuntimeSettingsRevisionDocument = {
    schemaVersion: SCHEMA_VERSION,
    version: (current?.version ?? 0) + 1,
    source: input.source,
    sections: {
      ...(current?.sections ?? {}),
      [input.key]: structuredClone(input.value)
    }
  };
  return identity(document);
}

export function readStorageVnextRuntimeSettingsRevision(input: {
  publicId: string;
  checksum: string;
  document: unknown;
}): StorageVnextRuntimeSettingsRevision {
  const document = readDocument(input.document);
  const verified = identity(document);
  if (input.publicId !== verified.publicId || input.checksum !== verified.checksum) {
    throw revisionError("revision_conflict");
  }
  return verified;
}

function identity(
  document: StorageVnextRuntimeSettingsRevisionDocument
): StorageVnextRuntimeSettingsRevision {
  const serialized = canonicalJson(document);
  if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_DOCUMENT_BYTES) {
    throw revisionError("revision_too_large");
  }
  const checksum = createHash("sha256").update(serialized).digest("hex");
  return {
    publicId: `runtime-settings-${checksum}`,
    checksum,
    document: structuredClone(document)
  };
}

function readDocument(value: unknown): StorageVnextRuntimeSettingsRevisionDocument {
  if (!isRecord(value)) throw revisionError("invalid_revision");
  if (
    value.schemaVersion !== SCHEMA_VERSION
    || !Number.isSafeInteger(value.version)
    || Number(value.version) < 1
    || (value.source !== "bootstrap" && value.source !== "admin")
    || !isRecord(value.sections)
  ) {
    throw revisionError("invalid_revision");
  }
  const sections: Partial<Record<RuntimeSettingKey, unknown>> = {};
  for (const [key, sectionValue] of Object.entries(value.sections)) {
    assertKey(key);
    if (!isRecord(sectionValue)) throw revisionError("invalid_revision");
    sections[key] = structuredClone(sectionValue);
  }
  const document: StorageVnextRuntimeSettingsRevisionDocument = {
    schemaVersion: SCHEMA_VERSION,
    version: Number(value.version),
    source: value.source,
    sections
  };
  canonicalJson(document);
  return document;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw revisionError("invalid_revision");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw revisionError("invalid_revision");
}

function assertKey(value: string): asserts value is RuntimeSettingKey {
  if (!SETTING_KEYS.includes(value as RuntimeSettingKey)) {
    throw revisionError("invalid_revision");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function revisionError(code: StorageVnextRuntimeSettingsRevisionErrorCode) {
  return new StorageVnextRuntimeSettingsRevisionError(code);
}
