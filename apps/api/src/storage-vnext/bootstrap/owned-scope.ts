import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { StorageVnextOwnedScopeProof } from "../lifecycle/ports.js";

const RUN_ID_PATTERN = /^svnext-([0-9]{8}T[0-9]{6}Z)-([a-f0-9]{12})$/u;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/u;

export class StorageVnextOwnedScopeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StorageVnextOwnedScopeError";
  }
}

export function createStorageVnextOwnedScopeProof(input: {
  runId: string;
  nonceHash: string;
  createdAt: string;
  filesystemScope: string;
}): StorageVnextOwnedScopeProof {
  const runToken = parseRunToken(input.runId);
  assertChecksum(input.nonceHash, "nonce hash");
  assertTimestamp(input.createdAt);
  const filesystemScope = validateFilesystemScope(input.filesystemScope, input.runId);
  const ownerMarker = digest(
    `focowiki-storage-vnext-owner:v1:${input.runId}:${input.nonceHash}`
  );
  const unsignedProof = {
    runId: input.runId,
    nonceHash: input.nonceHash,
    ownerMarker,
    postgresScope: `focowiki_svnext_${runToken}`,
    objectScope: `focowiki-validation/${input.runId}/`,
    searchScope: `svnext_${runToken}_`,
    coordinationScope: `focowiki:validation:${input.runId}:`,
    filesystemScope,
    createdAt: input.createdAt
  };

  return {
    ...unsignedProof,
    proofChecksum: digest(JSON.stringify(unsignedProof))
  };
}

export function validateStorageVnextOwnedScopeProof(
  proof: StorageVnextOwnedScopeProof
): StorageVnextOwnedScopeProof {
  const expected = createStorageVnextOwnedScopeProof({
    runId: proof.runId,
    nonceHash: proof.nonceHash,
    createdAt: proof.createdAt,
    filesystemScope: proof.filesystemScope
  });

  for (const field of [
    "ownerMarker",
    "postgresScope",
    "objectScope",
    "searchScope",
    "coordinationScope",
    "filesystemScope",
    "proofChecksum"
  ] as const) {
    if (proof[field] !== expected[field]) {
      throw new StorageVnextOwnedScopeError(`Owned scope ${field} does not match the run proof`);
    }
  }

  return proof;
}

function parseRunToken(runId: string): string {
  const match = RUN_ID_PATTERN.exec(runId);
  if (!match) {
    throw new StorageVnextOwnedScopeError("Run ID must use the canonical storage-vNext format");
  }

  const compactTimestamp = match[1]!;
  const timestamp = `${compactTimestamp.slice(0, 4)}-${compactTimestamp.slice(4, 6)}-${
    compactTimestamp.slice(6, 8)
  }T${compactTimestamp.slice(9, 11)}:${compactTimestamp.slice(11, 13)}:${
    compactTimestamp.slice(13, 15)
  }.000Z`;
  if (new Date(timestamp).toISOString() !== timestamp) {
    throw new StorageVnextOwnedScopeError("Run ID contains an invalid UTC timestamp");
  }

  return `${compactTimestamp.toLowerCase()}_${match[2]}`;
}

function validateFilesystemScope(filesystemScope: string, runId: string): string {
  if (!isAbsolute(filesystemScope)) {
    throw new StorageVnextOwnedScopeError("Filesystem scope must be absolute");
  }

  const normalized = resolve(filesystemScope);
  const temporaryRoot = resolve(tmpdir());
  const relativePath = relative(temporaryRoot, normalized);
  if (
    basename(normalized) !== runId
    || relativePath === ""
    || relativePath.startsWith("..")
    || isAbsolute(relativePath)
  ) {
    throw new StorageVnextOwnedScopeError(
      "Filesystem scope must be one exact canonical run directory below the operating-system temporary root"
    );
  }

  return normalized;
}

function assertChecksum(value: string, label: string): void {
  if (!CHECKSUM_PATTERN.test(value)) {
    throw new StorageVnextOwnedScopeError(`Owned scope ${label} must be a SHA-256 checksum`);
  }
}

function assertTimestamp(value: string): void {
  if (new Date(value).toISOString() !== value) {
    throw new StorageVnextOwnedScopeError("Owned scope creation time must be an ISO UTC timestamp");
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
