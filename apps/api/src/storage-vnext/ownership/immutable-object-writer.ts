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
const DEFAULT_CONCURRENT_WRITE_WAIT_MILLISECONDS = 30_000;
const DEFAULT_CONCURRENT_WRITE_POLL_MILLISECONDS = 50;
const DEFAULT_RESERVATION_LEASE_MILLISECONDS = 30_000;

export type StorageVnextImmutableObjectWriter = {
  putVerified(input: {
    bytes: Uint8Array;
    objectFormat: StorageVnextImmutableObjectFormat;
    writeAttemptPublicId: string;
    createdAt: StorageVnextTimestamp;
    retainVerifiedReservation?: boolean;
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
  concurrentWriteWaitMilliseconds?: number;
  concurrentWritePollMilliseconds?: number;
  reservationLeaseMilliseconds?: number;
}): StorageVnextImmutableObjectWriter {
  const concurrentWriteWaitMilliseconds = boundedMilliseconds(
    input.concurrentWriteWaitMilliseconds,
    DEFAULT_CONCURRENT_WRITE_WAIT_MILLISECONDS
  );
  const concurrentWritePollMilliseconds = boundedMilliseconds(
    input.concurrentWritePollMilliseconds,
    DEFAULT_CONCURRENT_WRITE_POLL_MILLISECONDS
  );
  const reservationLeaseMilliseconds = boundedMilliseconds(
    input.reservationLeaseMilliseconds,
    DEFAULT_RESERVATION_LEASE_MILLISECONDS
  );
  if (reservationLeaseMilliseconds < 1_000) {
    throw new StorageVnextImmutableObjectWriterError();
  }
  return {
    async putVerified(request) {
      assertRequest(request);
      const descriptor = input.bodyStore.describe({
        bytes: request.bytes,
        objectFormat: request.objectFormat
      });
      const reservationInput = {
        objectId: descriptor.objectId,
        storageKey: descriptor.storageKey,
        checksum: descriptor.checksum,
        byteCount: descriptor.byteCount,
        contentType: descriptor.contentType,
        format: descriptor.objectFormat,
        writeAttemptPublicId: request.writeAttemptPublicId,
        createdAt: request.createdAt,
        reservationExpiresAt: new Date(Math.max(
          Date.parse(request.createdAt),
          Date.parse(input.clock())
        ) + reservationLeaseMilliseconds).toISOString(),
        ...(request.retainVerifiedReservation
          ? { holdVerifiedUntil: new Date(Math.max(
              Date.parse(request.createdAt),
              Date.parse(input.clock())
            ) + reservationLeaseMilliseconds).toISOString() }
          : {})
      };
      const reservation = await reserveOrJoinConcurrentWrite({
        registrations: input.registrations,
        reservation: reservationInput,
        descriptor,
        waitMilliseconds: concurrentWriteWaitMilliseconds,
        pollMilliseconds: concurrentWritePollMilliseconds,
        ...(request.signal ? { signal: request.signal } : {})
      });
      assertRegistrationMatches(reservation.registration, descriptor);
      if (reservation.registration.state === "verified") {
        return {
          ...descriptor,
          outcome: "reused",
          requests: {
            put: 0,
            head: 0,
            verification: 0,
            attemptedBytes: 0,
            retries: 0,
            latencyMilliseconds: 0
          }
        };
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
          verifiedAt: input.clock(),
          ...(request.retainVerifiedReservation
            ? { holdVerifiedUntil: reservationInput.holdVerifiedUntil }
            : {})
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

async function reserveOrJoinConcurrentWrite(input: {
  registrations: StorageVnextOwnershipRepository;
  reservation: Parameters<StorageVnextOwnershipRepository["reserve"]>[0];
  descriptor: ReturnType<StorageVnextImmutableBodyStore["describe"]>;
  waitMilliseconds: number;
  pollMilliseconds: number;
  signal?: AbortSignal;
}) {
  let conflict: unknown;
  try {
    return await input.registrations.reserve(input.reservation);
  } catch (error) {
    if (!isConcurrentReservationConflict(error)) throw error;
    conflict = error;
  }

  const deadline = Date.now() + input.waitMilliseconds;
  while (true) {
    input.signal?.throwIfAborted();
    const registration = await input.registrations.getRegistration(
      input.reservation.objectId
    );
    if (registration) {
      assertRegistrationMatches(registration, input.descriptor);
      if (registration.state === "verified") {
        return { outcome: "reused" as const, registration };
      }
      if (registration.state === "reserved" || registration.state === "deleting") {
        // The current writer or cleanup owner still controls the object identity.
      } else if (registration.state === "deleted") {
        try {
          return await input.registrations.reserve(input.reservation);
        } catch (error) {
          if (!isConcurrentReservationConflict(error)) throw error;
          conflict = error;
        }
      }
    } else {
      try {
        return await input.registrations.reserve(input.reservation);
      } catch (error) {
        if (!isConcurrentReservationConflict(error)) throw error;
        conflict = error;
      }
    }
    if (Date.now() >= deadline) throw conflict;
    await waitForPoll(input.pollMilliseconds, input.signal);
  }
}

function isConcurrentReservationConflict(error: unknown): boolean {
  return hasErrorCode(error, "write_in_progress")
    || hasErrorCode(error, "state_conflict");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}

async function waitForPoll(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  signal?.throwIfAborted();
}

function boundedMilliseconds(value: number | undefined, fallback: number): number {
  const milliseconds = value ?? fallback;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 60_000) {
    throw new StorageVnextImmutableObjectWriterError();
  }
  return milliseconds;
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
