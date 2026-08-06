import { createHash } from "node:crypto";
import { normalizeSourceRelativePath } from "../../domain/source-path.js";
import {
  STORAGE_VNEXT_MARKDOWN_CONTENT_TYPE,
  type StorageVnextUploadManifestEntry
} from "./ports.js";

const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/u;
const PUBLIC_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,254}$/u;

export type StorageVnextUploadManifestErrorCode =
  | "duplicate_identity"
  | "duplicate_path"
  | "invalid_manifest"
  | "manifest_limit"
  | "malformed_path"
  | "unsupported_file";

export class StorageVnextUploadManifestError extends Error {
  public constructor(public readonly code: StorageVnextUploadManifestErrorCode) {
    super(`Storage vNext upload manifest error: ${code}`);
    this.name = "StorageVnextUploadManifestError";
  }
}

export function normalizeStorageVnextUploadManifest(input: {
  knowledgeBaseId: string;
  settingsRevisionPublicId: string;
  entries: ReadonlyArray<{
    entryPublicId: string;
    sourceFilePublicId: string;
    logicalPath: string;
    byteCount: number;
    checksumSha256: string;
    contentType: string;
  }>;
  maximumEntries: number;
  maximumManifestBytes: number;
}): {
  entries: readonly StorageVnextUploadManifestEntry[];
  manifestFingerprint: string;
  requestHash: string;
} {
  assertLimits(input.maximumEntries, input.maximumManifestBytes);
  if (input.entries.length > input.maximumEntries) {
    throw new StorageVnextUploadManifestError("manifest_limit");
  }

  const paths = new Set<string>();
  const identities = new Set<string>();
  const entries: StorageVnextUploadManifestEntry[] = input.entries.map((entry) => {
    if (entry.contentType !== STORAGE_VNEXT_MARKDOWN_CONTENT_TYPE) {
      throw new StorageVnextUploadManifestError("unsupported_file");
    }
    if (
      !PUBLIC_ID_PATTERN.test(entry.entryPublicId)
      || !PUBLIC_ID_PATTERN.test(entry.sourceFilePublicId)
      || !Number.isSafeInteger(entry.byteCount)
      || entry.byteCount < 0
      || !CHECKSUM_PATTERN.test(entry.checksumSha256)
    ) throw new StorageVnextUploadManifestError("invalid_manifest");

    let path: ReturnType<typeof normalizeSourceRelativePath>;
    try {
      path = normalizeSourceRelativePath(entry.logicalPath);
    } catch {
      throw new StorageVnextUploadManifestError("malformed_path");
    }
    if (paths.has(path.pathKey)) {
      throw new StorageVnextUploadManifestError("duplicate_path");
    }
    const identity = `${entry.entryPublicId}\0${entry.sourceFilePublicId}`;
    if (identities.has(identity)) {
      throw new StorageVnextUploadManifestError("duplicate_identity");
    }
    paths.add(path.pathKey);
    identities.add(identity);
    return {
      ...entry,
      logicalPath: path.relativePath,
      normalizedPath: path.pathKey,
      contentType: STORAGE_VNEXT_MARKDOWN_CONTENT_TYPE
    };
  });

  const canonical = entries
    .map((entry) => ({
      entryPublicId: entry.entryPublicId,
      sourceFilePublicId: entry.sourceFilePublicId,
      logicalPath: entry.logicalPath,
      normalizedPath: entry.normalizedPath,
      byteCount: entry.byteCount,
      checksumSha256: entry.checksumSha256,
      contentType: entry.contentType
    }))
    .sort((left, right) => left.normalizedPath.localeCompare(right.normalizedPath)
      || left.entryPublicId.localeCompare(right.entryPublicId));
  const serialized = JSON.stringify(canonical);
  if (Buffer.byteLength(serialized, "utf8") > input.maximumManifestBytes) {
    throw new StorageVnextUploadManifestError("manifest_limit");
  }
  const manifestFingerprint = digest(JSON.stringify({
    knowledgeBaseId: input.knowledgeBaseId,
    entries: canonical
  }));
  return {
    entries,
    manifestFingerprint,
    requestHash: digest(JSON.stringify({
      knowledgeBaseId: input.knowledgeBaseId,
      settingsRevisionPublicId: input.settingsRevisionPublicId,
      manifestFingerprint
    }))
  };
}

function assertLimits(maximumEntries: number, maximumManifestBytes: number): void {
  if (
    !Number.isSafeInteger(maximumEntries)
    || maximumEntries < 1
    || !Number.isSafeInteger(maximumManifestBytes)
    || maximumManifestBytes < 1
  ) throw new StorageVnextUploadManifestError("invalid_manifest");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
