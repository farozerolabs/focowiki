import {
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
  type S3Client
} from "@aws-sdk/client-s3";
import type { StorageVnextOpaqueCursor, StorageVnextTimestamp } from "../shared/types.js";
import type { StorageVnextOwnershipRepository } from "./ports.js";
import { createS3StorageVnextVersionAwareDeletionProvider } from
  "./version-aware-deletion.js";

export type StorageVnextFailedWriteReason =
  | "upload_failed"
  | "metadata_mismatch"
  | "timed_out"
  | "registration_failed"
  | "owner_attach_failed"
  | "process_terminated";

export type StorageVnextFailedWrite = {
  objectId: string;
  storageKey: string;
  writeAttemptPublicId: string;
  reasonCode: StorageVnextFailedWriteReason;
  failedAt: StorageVnextTimestamp;
};

export type StorageVnextFailedWriteCompensation = {
  compensate(input: StorageVnextFailedWrite): Promise<"deleted" | "missing" | "preserved">;
};

export type StorageVnextFailedWriteProvider = {
  abortMultipartUploads(storageKey: string): Promise<void>;
  deleteCurrentObject(storageKey: string): Promise<void>;
};

export function createStorageVnextFailedWriteCompensator(input: {
  registrations: StorageVnextOwnershipRepository;
  provider: StorageVnextFailedWriteProvider;
}): StorageVnextFailedWriteCompensation {
  return {
    async compensate(failure) {
      const registration = await input.registrations.getRegistration(failure.objectId);
      if (!registration) return "missing";
      if (
        registration.storageKey !== failure.storageKey
        || registration.writeAttemptPublicId !== failure.writeAttemptPublicId
      ) {
        throw compensationError("registration_conflict");
      }
      const closure = await input.registrations.getClosure(failure.objectId);
      if (closure.ownerCount > 0) return "preserved";
      if (registration.state === "deleted") return "deleted";
      if (registration.state === "verified") {
        await input.registrations.markDeleting(failure.objectId);
      } else if (registration.state !== "reserved" && registration.state !== "deleting") {
        throw compensationError("state_conflict");
      }
      await input.provider.abortMultipartUploads(failure.storageKey);
      await input.provider.deleteCurrentObject(failure.storageKey);
      if (registration.state === "reserved") {
        await input.registrations.deleteFailedReservation({
          objectId: failure.objectId,
          writeAttemptPublicId: failure.writeAttemptPublicId
        });
      } else {
        await input.registrations.markDeleted(failure.objectId);
      }
      return "deleted";
    }
  };
}

export function createS3StorageVnextFailedWriteProvider(input: {
  client: S3Client;
  bucket: string;
  prefix: string;
}): StorageVnextFailedWriteProvider {
  const bucket = requireNonempty(input.bucket);
  const prefix = requireNonempty(input.prefix).replace(/\/+$/gu, "");
  const versionAwareDeletion = createS3StorageVnextVersionAwareDeletionProvider({
    client: input.client,
    bucket,
    prefix
  });
  return {
    async abortMultipartUploads(storageKey) {
      assertOwnedKey(prefix, storageKey);
      let keyMarker: string | undefined;
      let uploadIdMarker: string | undefined;
      do {
        const page = await input.client.send(new ListMultipartUploadsCommand({
          Bucket: bucket,
          Prefix: storageKey,
          ...(keyMarker ? { KeyMarker: keyMarker } : {}),
          ...(uploadIdMarker ? { UploadIdMarker: uploadIdMarker } : {})
        }));
        for (const upload of page.Uploads ?? []) {
          if (upload.Key !== storageKey || !upload.UploadId) continue;
          await input.client.send(new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: storageKey,
            UploadId: upload.UploadId
          }));
        }
        if (!page.IsTruncated) break;
        if (!page.NextKeyMarker) throw providerError("pagination_incomplete");
        keyMarker = page.NextKeyMarker;
        uploadIdMarker = page.NextUploadIdMarker;
      } while (true);
    },

    async deleteCurrentObject(storageKey) {
      assertOwnedKey(prefix, storageKey);
      await versionAwareDeletion.purge(storageKey);
    }
  };
}

export async function recoverStorageVnextStaleReservations(input: {
  registrations: StorageVnextOwnershipRepository;
  compensation: StorageVnextFailedWriteCompensation;
  staleBefore: StorageVnextTimestamp;
  failedAt: StorageVnextTimestamp;
  limit: number;
  cursor: StorageVnextOpaqueCursor | null;
}): Promise<{ processed: number; nextCursor: StorageVnextOpaqueCursor | null }> {
  const page = await input.registrations.listStaleReservations({
    staleBefore: input.staleBefore,
    limit: input.limit,
    cursor: input.cursor
  });
  for (const registration of page.items) {
    await input.compensation.compensate({
      objectId: registration.objectId,
      storageKey: registration.storageKey,
      writeAttemptPublicId: registration.writeAttemptPublicId,
      reasonCode: "process_terminated",
      failedAt: input.failedAt
    });
  }
  return { processed: page.items.length, nextCursor: page.nextCursor };
}

function compensationError(code: "registration_conflict" | "state_conflict"): Error {
  return Object.assign(new Error(`Storage vNext failed-write compensation error: ${code}`), {
    code
  });
}

function assertOwnedKey(prefix: string, storageKey: string): void {
  if (!storageKey.startsWith(`${prefix}/`) || storageKey.includes("\0")) {
    throw providerError("scope_conflict");
  }
}

function requireNonempty(value: string): string {
  if (!value || value.trim() !== value) throw providerError("invalid_input");
  return value;
}

function providerError(
  code: "invalid_input" | "scope_conflict" | "pagination_incomplete"
): Error {
  return Object.assign(new Error(`Storage vNext failed-write provider error: ${code}`), {
    code
  });
}
