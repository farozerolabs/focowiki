import { randomUUID } from "node:crypto";
import type { ImmutableObjectRecoveryRepository } from "../application/ports/immutable-object-repository.js";
import { matchesImmutableStorageIdentity } from "../domain/immutable-object-storage-identity.js";
import type { StorageAdapter } from "../storage/s3.js";

const DEFAULT_STALE_WRITE_MS = 5 * 60_000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_CONCURRENCY = 8;

export async function runImmutableWriteRecoverySlice(input: {
  repository: ImmutableObjectRecoveryRepository;
  storage: Pick<StorageAdapter, "headObjectMetadata"> & {
    headObjectMetadata: NonNullable<StorageAdapter["headObjectMetadata"]>;
  };
  now?: () => Date;
  recoveryToken?: string;
  staleWriteMs?: number;
  batchSize?: number;
  concurrency?: number;
}): Promise<{ claimed: number; activated: number; expired: number; failed: number }> {
  const now = input.now ?? (() => new Date());
  const current = now();
  const recoveryToken = input.recoveryToken ?? randomUUID();
  const concurrency = boundedConcurrency(input.concurrency ?? DEFAULT_CONCURRENCY);
  const claimLimit = Math.min(input.batchSize ?? DEFAULT_BATCH_SIZE, concurrency);
  const reservations = await input.repository.claimStaleWriting({
    staleBefore: new Date(
      current.getTime() - (input.staleWriteMs ?? DEFAULT_STALE_WRITE_MS)
    ).toISOString(),
    claimedAt: current.toISOString(),
    recoveryToken,
    limit: claimLimit
  });
  const outcomes = await Promise.all(reservations.map(async (reservation) => {
    try {
      const stored = await input.storage.headObjectMetadata(reservation.objectKey);
      if (!stored) {
        if (await input.repository.expireMissing({
          checksumSha256: reservation.checksumSha256,
          formatVersion: reservation.formatVersion,
          recoveryToken
        })) {
          return "expired" as const;
        }
        return "unchanged" as const;
      }
      if (!matchesImmutableStorageIdentity(stored, reservation)) {
        await input.repository.releaseRecoveryFailure({
          checksumSha256: reservation.checksumSha256,
          formatVersion: reservation.formatVersion,
          recoveryToken
        });
        return "failed" as const;
      }
      if (await input.repository.activateRecovered({
        ...reservation,
        recoveryToken,
        verifiedAt: now().toISOString()
      })) {
        return "activated" as const;
      }
      return "unchanged" as const;
    } catch {
      await input.repository.releaseRecoveryFailure({
        checksumSha256: reservation.checksumSha256,
        formatVersion: reservation.formatVersion,
        recoveryToken
      });
      return "failed" as const;
    }
  }));
  return {
    claimed: reservations.length,
    activated: outcomes.filter((outcome) => outcome === "activated").length,
    expired: outcomes.filter((outcome) => outcome === "expired").length,
    failed: outcomes.filter((outcome) => outcome === "failed").length
  };
}

function boundedConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) {
    throw new Error("Immutable object recovery concurrency must be between 1 and 32");
  }
  return value;
}
