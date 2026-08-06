import type {
  StorageVnextObjectOwner,
  StorageVnextObjectRegistration,
  StorageVnextObjectReservation,
  StorageVnextOwnerKind
} from "./ports.js";

const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/u;
const PUBLIC_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,254}$/u;

export const MAX_STORAGE_VNEXT_OWNERSHIP_PAGE_SIZE = 1_000;

export type StorageVnextRegistrationRow = {
  object_id: string;
  storage_key: string;
  checksum_sha256: string;
  byte_count: number | string;
  content_type: string;
  object_format: string;
  state: StorageVnextObjectRegistration["state"];
  write_attempt_public_id: string;
  verified_at: Date | string | null;
  zero_owner_since: Date | string | null;
  created_at: Date | string;
};

export type StorageVnextOwnerRow = {
  public_id: string;
  knowledge_base_id: string;
  object_id: string;
  owner_kind: StorageVnextOwnerKind;
  owner_public_id: string;
  created_at: Date | string;
};

type ZeroOwnerCursor = {
  kind: "zero_owner";
  zeroOwnerSince: string;
  objectId: string;
};

type StaleReservationCursor = {
  kind: "stale_reservation";
  createdAt: string;
  objectId: string;
};

type RegistrationCursor = {
  kind: "registration";
  storageKey: string;
  objectId: string;
};

export type StorageVnextOwnershipRepositoryErrorCode =
  | "invalid_input"
  | "invalid_cursor"
  | "registration_conflict"
  | "write_attempt_conflict"
  | "write_in_progress"
  | "object_not_found"
  | "object_unverified"
  | "owner_target_conflict"
  | "owner_conflict"
  | "owners_present"
  | "state_conflict";

export class StorageVnextOwnershipRepositoryError extends Error {
  public constructor(public readonly code: StorageVnextOwnershipRepositoryErrorCode) {
    super(`Storage vNext ownership repository error: ${code}`);
    this.name = "StorageVnextOwnershipRepositoryError";
  }
}

export function storageVnextOwnerTarget(owner: StorageVnextObjectOwner) {
  return {
    sourceRevisionPublicId: owner.kind === "source_revision" ? owner.ownerPublicId : null,
    releaseRootPublicId: ["active_root", "candidate_root", "rollback_root"].includes(owner.kind)
      ? owner.ownerPublicId
      : null,
    releaseShardPublicId: owner.kind === "shared_segment" ? owner.ownerPublicId : null,
    operationPublicId: owner.kind === "live_reservation" ? owner.ownerPublicId : null
  };
}

export function mapStorageVnextRegistration(
  row: StorageVnextRegistrationRow
): StorageVnextObjectRegistration {
  return {
    objectId: row.object_id,
    storageKey: row.storage_key,
    checksum: row.checksum_sha256,
    byteCount: Number(row.byte_count),
    contentType: row.content_type,
    format: row.object_format,
    state: row.state,
    writeAttemptPublicId: row.write_attempt_public_id,
    verifiedAt: timestamp(row.verified_at),
    zeroOwnerSince: timestamp(row.zero_owner_since),
    createdAt: timestamp(row.created_at)!
  };
}

export function mapStorageVnextOwner(row: StorageVnextOwnerRow): StorageVnextObjectOwner {
  return {
    publicId: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    objectId: row.object_id,
    kind: row.owner_kind,
    ownerPublicId: row.owner_public_id,
    createdAt: timestamp(row.created_at)!
  };
}

export function sameStorageVnextRegistrationMetadata(
  row: StorageVnextRegistrationRow,
  input: {
    storageKey?: string;
    checksum: string;
    byteCount: number;
    contentType: string;
    format: string;
  }
): boolean {
  return (input.storageKey === undefined || row.storage_key === input.storageKey)
    && row.checksum_sha256 === input.checksum
    && Number(row.byte_count) === input.byteCount
    && row.content_type === input.contentType
    && row.object_format === input.format;
}

export function sameMappedStorageVnextRegistrationMetadata(
  registration: StorageVnextObjectRegistration,
  input: StorageVnextObjectReservation
): boolean {
  return registration.storageKey === input.storageKey
    && registration.checksum === input.checksum
    && registration.byteCount === input.byteCount
    && registration.contentType === input.contentType
    && registration.format === input.format;
}

export function assertStorageVnextReservation(input: StorageVnextObjectReservation): void {
  assertStorageVnextPublicId(input.objectId);
  assertStorageVnextPublicId(input.writeAttemptPublicId);
  if (
    !isStorageVnextStorageKey(input.storageKey)
    || !CHECKSUM_PATTERN.test(input.checksum)
    || !Number.isSafeInteger(input.byteCount)
    || input.byteCount < 0
    || !input.contentType
    || input.contentType.length > 255
    || !input.format
    || input.format.length > 128
  ) {
    throw new StorageVnextOwnershipRepositoryError("invalid_input");
  }
  assertStorageVnextOwnershipTimestamp(input.createdAt);
}

export function assertStorageVnextVerification(input: {
  objectId: string;
  writeAttemptPublicId: string;
  checksum: string;
  byteCount: number;
  contentType: string;
  format: string;
  verifiedAt: string;
}): void {
  assertStorageVnextPublicId(input.objectId);
  assertStorageVnextPublicId(input.writeAttemptPublicId);
  if (
    !CHECKSUM_PATTERN.test(input.checksum)
    || !Number.isSafeInteger(input.byteCount)
    || input.byteCount < 0
    || !input.contentType
    || !input.format
  ) {
    throw new StorageVnextOwnershipRepositoryError("invalid_input");
  }
  assertStorageVnextOwnershipTimestamp(input.verifiedAt);
}

export function assertStorageVnextOwner(owner: StorageVnextObjectOwner): void {
  assertStorageVnextPublicId(owner.publicId);
  assertStorageVnextPublicId(owner.knowledgeBaseId);
  assertStorageVnextPublicId(owner.objectId);
  assertStorageVnextPublicId(owner.ownerPublicId);
  assertStorageVnextOwnerKind(owner.kind);
  assertStorageVnextOwnershipTimestamp(owner.createdAt);
}

export function assertStorageVnextOwnerKind(
  kind: string
): asserts kind is StorageVnextOwnerKind {
  if (![
    "source_revision",
    "active_root",
    "candidate_root",
    "rollback_root",
    "shared_segment",
    "live_reservation"
  ].includes(kind)) {
    throw new StorageVnextOwnershipRepositoryError("invalid_input");
  }
}

export function assertStorageVnextPublicId(value: string): void {
  if (!PUBLIC_ID_PATTERN.test(value)) {
    throw new StorageVnextOwnershipRepositoryError("invalid_input");
  }
}

export function assertStorageVnextOwnershipTimestamp(value: string): string {
  if (!Number.isFinite(new Date(value).getTime())) {
    throw new StorageVnextOwnershipRepositoryError("invalid_input");
  }
  return value;
}

export function assertStorageVnextZeroOwnerGrace(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StorageVnextOwnershipRepositoryError("invalid_input");
  }
}

export function assertStorageVnextOwnershipPageLimit(value: number): number {
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || value > MAX_STORAGE_VNEXT_OWNERSHIP_PAGE_SIZE
  ) {
    throw new StorageVnextOwnershipRepositoryError("invalid_input");
  }
  return value;
}

export function encodeStorageVnextOwnershipCursor(
  value: ZeroOwnerCursor | StaleReservationCursor | RegistrationCursor
): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeStorageVnextRegistrationCursor(
  value: string | null
): RegistrationCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !parsed
      || typeof parsed !== "object"
      || Array.isArray(parsed)
      || parsed.kind !== "registration"
      || typeof parsed.storageKey !== "string"
      || typeof parsed.objectId !== "string"
      || !isStorageVnextStorageKey(parsed.storageKey)
    ) {
      throw new Error("invalid cursor");
    }
    assertStorageVnextPublicId(parsed.objectId);
    return parsed as RegistrationCursor;
  } catch {
    throw new StorageVnextOwnershipRepositoryError("invalid_cursor");
  }
}

export function isStorageVnextStorageKey(value: string): boolean {
  return Boolean(value) && value.length <= 2_048 && !value.includes("\0");
}

export function decodeStorageVnextStaleReservationCursor(
  value: string | null
): StaleReservationCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !parsed
      || typeof parsed !== "object"
      || Array.isArray(parsed)
      || parsed.kind !== "stale_reservation"
      || typeof parsed.createdAt !== "string"
      || typeof parsed.objectId !== "string"
    ) {
      throw new Error("invalid cursor");
    }
    assertStorageVnextOwnershipTimestamp(parsed.createdAt);
    assertStorageVnextPublicId(parsed.objectId);
    return parsed as StaleReservationCursor;
  } catch {
    throw new StorageVnextOwnershipRepositoryError("invalid_cursor");
  }
}

export function decodeStorageVnextZeroOwnerCursor(
  value: string | null
): ZeroOwnerCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !parsed
      || typeof parsed !== "object"
      || Array.isArray(parsed)
      || parsed.kind !== "zero_owner"
      || typeof parsed.zeroOwnerSince !== "string"
      || typeof parsed.objectId !== "string"
    ) {
      throw new Error("invalid cursor");
    }
    assertStorageVnextOwnershipTimestamp(parsed.zeroOwnerSince);
    assertStorageVnextPublicId(parsed.objectId);
    return parsed as ZeroOwnerCursor;
  } catch {
    throw new StorageVnextOwnershipRepositoryError("invalid_cursor");
  }
}

export function mapStorageVnextOwnershipDatabaseError(error: unknown): Error {
  if (error instanceof StorageVnextOwnershipRepositoryError) return error;
  if (error instanceof Error && "code" in error && error.code === "23505") {
    return new StorageVnextOwnershipRepositoryError("registration_conflict");
  }
  return error instanceof Error ? error : new Error(String(error));
}

function timestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
