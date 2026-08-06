import type {
  StorageVnextVerifiedSourceBody
} from "../catalog/s3-source-body-store.js";
import type {
  StorageVnextFailedWriteCompensation,
  StorageVnextFailedWriteReason
} from "../ownership/failed-write-compensation.js";
import type { StorageVnextOwnershipRepository } from "../ownership/ports.js";
import type { StorageVnextUploadBodyWriter } from "./ports.js";

type StreamingSourceBodyStore = {
  describeExpected(input: {
    checksum: string;
    byteCount: number;
    contentType: string;
  }): Omit<StorageVnextVerifiedSourceBody, "outcome">;
  putVerifiedStream(input: {
    body: AsyncIterable<Uint8Array>;
    checksum: string;
    byteCount: number;
    contentType: string;
    signal?: AbortSignal;
  }): Promise<StorageVnextVerifiedSourceBody>;
};

export function createStorageVnextStreamingUploadBodyWriter(input: {
  registrations: StorageVnextOwnershipRepository;
  bodyStore: StreamingSourceBodyStore;
  compensation: StorageVnextFailedWriteCompensation;
  clock: () => string;
}): StorageVnextUploadBodyWriter {
  return {
    async putVerifiedStream(request) {
      const createdAt = input.clock();
      const descriptor = input.bodyStore.describeExpected({
        checksum: request.checksumSha256,
        byteCount: request.byteCount,
        contentType: request.contentType
      });
      const reservation = await input.registrations.reserve({
        objectId: descriptor.objectId,
        storageKey: descriptor.storageKey,
        checksum: descriptor.checksum,
        byteCount: descriptor.byteCount,
        contentType: descriptor.contentType,
        format: descriptor.objectFormat,
        writeAttemptPublicId: request.writeAttemptPublicId,
        createdAt
      });
      assertRegistrationMatches(reservation.registration, descriptor);
      const ownsReservation = reservation.registration.state === "reserved"
        && reservation.registration.writeAttemptPublicId === request.writeAttemptPublicId;
      if (reservation.registration.state === "reserved" && !ownsReservation) {
        throw writerError("reservation_conflict");
      }
      let stored: StorageVnextVerifiedSourceBody;
      try {
        stored = await input.bodyStore.putVerifiedStream({
          body: request.body,
          checksum: request.checksumSha256,
          byteCount: request.byteCount,
          contentType: request.contentType,
          ...(request.signal ? { signal: request.signal } : {})
        });
      } catch (error) {
        if (ownsReservation) {
          await compensateOrThrow(input.compensation, {
            descriptor,
            writeAttemptPublicId: request.writeAttemptPublicId,
            reasonCode: providerFailureReason(error),
            failedAt: input.clock()
          }, error);
        }
        throw error;
      }
      if (ownsReservation) {
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
          await compensateOrThrow(input.compensation, {
            descriptor,
            writeAttemptPublicId: request.writeAttemptPublicId,
            reasonCode: "registration_failed",
            failedAt: input.clock()
          }, error);
        }
      }
      return {
        outcome: reservation.registration.state === "verified" ? "reused" : stored.outcome,
        objectId: stored.objectId,
        checksumSha256: stored.checksum,
        byteCount: stored.byteCount,
        contentType: stored.contentType
      };
    }
  };
}

async function compensateOrThrow(
  compensation: StorageVnextFailedWriteCompensation,
  input: {
    descriptor: { objectId: string; storageKey: string };
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
      "Storage vNext streaming upload and compensation both failed"
    );
  }
  throw originalError;
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
  descriptor: Omit<StorageVnextVerifiedSourceBody, "outcome">
): void {
  if (
    registration.objectId !== descriptor.objectId
    || registration.storageKey !== descriptor.storageKey
    || registration.checksum !== descriptor.checksum
    || registration.byteCount !== descriptor.byteCount
    || registration.contentType !== descriptor.contentType
    || registration.format !== descriptor.objectFormat
  ) throw writerError("registration_conflict");
}

function providerFailureReason(error: unknown): StorageVnextFailedWriteReason {
  if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) {
    return "timed_out";
  }
  if (error instanceof Error && "code" in error
    && error.code === "object_verification_failed") {
    return "metadata_mismatch";
  }
  return "upload_failed";
}

function writerError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Storage vNext streaming upload writer error: ${code}`), {
    code
  });
}
