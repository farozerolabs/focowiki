import type { StorageVnextTimestamp } from "../shared/types.js";
import type { StorageVnextImmutableObjectFormat } from "./content-address.js";
import type {
  StorageVnextImmutableBodyStore,
  StorageVnextImmutableBodyWriteResult
} from "./s3-immutable-body-store.js";
import type { StorageVnextOwnershipRepository } from "./ports.js";
import type {
  StorageVnextFailedWriteCompensation,
  StorageVnextFailedWriteReason
} from "./failed-write-compensation.js";

const PUBLIC_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,254}$/u;

export type StorageVnextImmutableObjectWriter = {
  putVerified(input: {
    bytes: Uint8Array;
    objectFormat: StorageVnextImmutableObjectFormat;
    writeAttemptPublicId: string;
    createdAt: StorageVnextTimestamp;
    signal?: AbortSignal;
  }): Promise<StorageVnextImmutableBodyWriteResult>;
};

export class StorageVnextImmutableObjectWriterError extends Error {
  public readonly code = "invalid_input";

  public constructor() {
    super("Storage vNext immutable object write input is invalid");
    this.name = "StorageVnextImmutableObjectWriterError";
  }
}

export function createStorageVnextImmutableObjectWriter(input: {
  registrations: StorageVnextOwnershipRepository;
  bodyStore: StorageVnextImmutableBodyStore;
  compensation: StorageVnextFailedWriteCompensation;
  clock: () => StorageVnextTimestamp;
}): StorageVnextImmutableObjectWriter {
  return {
    async putVerified(request) {
      assertRequest(request);
      const descriptor = input.bodyStore.describe({
        bytes: request.bytes,
        objectFormat: request.objectFormat
      });
      const reservation = await input.registrations.reserve({
        objectId: descriptor.objectId,
        storageKey: descriptor.storageKey,
        checksum: descriptor.checksum,
        byteCount: descriptor.byteCount,
        contentType: descriptor.contentType,
        format: descriptor.objectFormat,
        writeAttemptPublicId: request.writeAttemptPublicId,
        createdAt: request.createdAt
      });
      assertRegistrationMatches(reservation.registration, descriptor);
      if (reservation.registration.state === "verified") {
        try {
          await input.bodyStore.verify({
            descriptor,
            ...(request.signal ? { signal: request.signal } : {})
          });
          return { ...descriptor, outcome: "reused" };
        } catch (error) {
          if (!isMissingBodyError(error)) throw error;
          return input.bodyStore.putVerified({
            descriptor,
            bytes: request.bytes,
            ...(request.signal ? { signal: request.signal } : {})
          });
        }
      }
      if (
        reservation.registration.state !== "reserved"
        || reservation.registration.writeAttemptPublicId !== request.writeAttemptPublicId
      ) {
        throw new StorageVnextImmutableObjectWriterError();
      }
      let stored: StorageVnextImmutableBodyWriteResult;
      try {
        stored = await input.bodyStore.putVerified({
          descriptor,
          bytes: request.bytes,
          ...(request.signal ? { signal: request.signal } : {})
        });
      } catch (error) {
        return compensateOrThrow(input.compensation, {
          descriptor,
          writeAttemptPublicId: request.writeAttemptPublicId,
          reasonCode: providerFailureReason(error),
          failedAt: input.clock()
        }, error);
      }
      try {
        await input.registrations.markVerified({
          objectId: descriptor.objectId,
          writeAttemptPublicId: request.writeAttemptPublicId,
          checksum: descriptor.checksum,
          byteCount: descriptor.byteCount,
          contentType: descriptor.contentType,
          format: descriptor.objectFormat,
          verifiedAt: input.clock()
        });
      } catch (error) {
        return compensateOrThrow(input.compensation, {
          descriptor,
          writeAttemptPublicId: request.writeAttemptPublicId,
          reasonCode: "registration_failed",
          failedAt: input.clock()
        }, error);
      }
      return stored;
    }
  };
}

async function compensateOrThrow(
  compensation: StorageVnextFailedWriteCompensation,
  input: {
    descriptor: {
      objectId: string;
      storageKey: string;
    };
    writeAttemptPublicId: string;
    reasonCode: StorageVnextFailedWriteReason;
    failedAt: string;
  },
  originalError: unknown
): Promise<never> {
  try {
    await compensation.compensate({
      objectId: input.descriptor.objectId,
      storageKey: input.descriptor.storageKey,
      writeAttemptPublicId: input.writeAttemptPublicId,
      reasonCode: input.reasonCode,
      failedAt: input.failedAt
    });
  } catch (compensationError) {
    throw new AggregateError(
      [originalError, compensationError],
      "Storage vNext immutable write and compensation both failed"
    );
  }
  throw originalError;
}

function providerFailureReason(error: unknown): StorageVnextFailedWriteReason {
  if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
    return "timed_out";
  }
  if (
    error instanceof Error
    && "code" in error
    && error.code === "object_verification_failed"
  ) {
    return "metadata_mismatch";
  }
  return "upload_failed";
}

function isMissingBodyError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "object_missing";
}

function assertRequest(input: {
  bytes: Uint8Array;
  writeAttemptPublicId: string;
  createdAt: string;
}): void {
  if (
    !(input.bytes instanceof Uint8Array)
    || !PUBLIC_ID_PATTERN.test(input.writeAttemptPublicId)
    || !Number.isFinite(new Date(input.createdAt).getTime())
  ) {
    throw new StorageVnextImmutableObjectWriterError();
  }
}

function assertRegistrationMatches(
  registration: {
    objectId: string;
    storageKey: string;
    checksum: string;
    byteCount: number;
    contentType: string;
    format: string;
  },
  descriptor: {
    objectId: string;
    storageKey: string;
    checksum: string;
    byteCount: number;
    contentType: string;
    objectFormat: string;
  }
): void {
  if (
    registration.objectId !== descriptor.objectId
    || registration.storageKey !== descriptor.storageKey
    || registration.checksum !== descriptor.checksum
    || registration.byteCount !== descriptor.byteCount
    || registration.contentType !== descriptor.contentType
    || registration.format !== descriptor.objectFormat
  ) {
    throw new StorageVnextImmutableObjectWriterError();
  }
}
