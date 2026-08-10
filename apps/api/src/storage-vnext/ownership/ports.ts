import type {
  StorageVnextByteCount,
  StorageVnextChecksum,
  StorageVnextKnowledgeBaseId,
  StorageVnextOpaqueCursor,
  StorageVnextPage,
  StorageVnextPublicId,
  StorageVnextTimestamp
} from "../shared/types.js";

export type StorageVnextObjectState = "reserved" | "verified" | "deleting" | "deleted";
export type StorageVnextOwnerKind =
  | "source_revision"
  | "active_root"
  | "candidate_root"
  | "rollback_root"
  | "shared_segment"
  | "live_reservation"
  | "embedding_artifact";

export type StorageVnextObjectRegistration = {
  objectId: string;
  storageKey: string;
  checksum: StorageVnextChecksum;
  byteCount: StorageVnextByteCount;
  contentType: string;
  format: string;
  state: StorageVnextObjectState;
  writeAttemptPublicId: StorageVnextPublicId;
  verifiedAt: StorageVnextTimestamp | null;
  zeroOwnerSince: StorageVnextTimestamp | null;
  createdAt: StorageVnextTimestamp;
};

export type StorageVnextObjectReservation = Omit<
  StorageVnextObjectRegistration,
  "state" | "verifiedAt" | "zeroOwnerSince"
>;

export type StorageVnextObjectReservationResult = {
  outcome: "reserved" | "reused";
  registration: StorageVnextObjectRegistration;
};

export type StorageVnextObjectOwner = {
  publicId: StorageVnextPublicId;
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  objectId: string;
  kind: StorageVnextOwnerKind;
  ownerPublicId: StorageVnextPublicId;
  createdAt: StorageVnextTimestamp;
};

export type StorageVnextOwnershipClosure = {
  objectId: string;
  owners: readonly StorageVnextObjectOwner[];
  ownerCount: number;
  referenceCount: number;
  graceExpiresAt: StorageVnextTimestamp | null;
};

export type StorageVnextOwnershipReadPort = {
  getRegistration(objectId: string): Promise<StorageVnextObjectRegistration | null>;
  getRegistrationsByStorageKeys(
    storageKeys: readonly string[]
  ): Promise<readonly StorageVnextObjectRegistration[]>;
  listRegistrations(input: {
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextObjectRegistration>>;
  getClosure(objectId: string): Promise<StorageVnextOwnershipClosure>;
  listZeroOwnerObjects(input: {
    graceElapsedBefore: StorageVnextTimestamp;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextObjectRegistration>>;
  listStaleReservations(input: {
    staleBefore: StorageVnextTimestamp;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextObjectRegistration>>;
};

export type StorageVnextOwnershipWritePort = {
  reserve(input: StorageVnextObjectReservation): Promise<StorageVnextObjectReservationResult>;
  markVerified(input: {
    objectId: string;
    writeAttemptPublicId: StorageVnextPublicId;
    checksum: StorageVnextChecksum;
    byteCount: StorageVnextByteCount;
    contentType: string;
    format: string;
    verifiedAt: StorageVnextTimestamp;
  }): Promise<StorageVnextObjectRegistration>;
  attach(owner: StorageVnextObjectOwner): Promise<void>;
  release(input: {
    objectId: string;
    ownerPublicId: StorageVnextPublicId;
    kind: StorageVnextOwnerKind;
  }): Promise<void>;
  markDeleting(objectId: string): Promise<void>;
  markDeleted(objectId: string): Promise<void>;
  deleteFailedReservation(input: {
    objectId: string;
    writeAttemptPublicId: StorageVnextPublicId;
  }): Promise<void>;
};

export type StorageVnextOwnershipRepository =
  & StorageVnextOwnershipReadPort
  & StorageVnextOwnershipWritePort;
