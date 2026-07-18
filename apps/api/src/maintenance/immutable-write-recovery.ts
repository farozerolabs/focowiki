import { randomUUID } from "node:crypto";
import type { ImmutableObjectRecoveryRepository } from "../application/ports/immutable-object-repository.js";
import { matchesImmutableStorageIdentity } from "../domain/immutable-object-storage-identity.js";
import type { StorageAdapter } from "../storage/s3.js";

const DEFAULT_STALE_WRITE_MS = 5 * 60_000;
const DEFAULT_BATCH_SIZE = 100;

export async function runImmutableWriteRecoverySlice(input: {
  repository: ImmutableObjectRecoveryRepository;
  storage: Pick<StorageAdapter, "headObjectMetadata"> & {
    headObjectMetadata: NonNullable<StorageAdapter["headObjectMetadata"]>;
  };
  now?: () => Date;
  recoveryToken?: string;
  staleWriteMs?: number;
  batchSize?: number;
}): Promise<{ claimed: number; activated: number; expired: number; failed: number }> {
  const now = input.now ?? (() => new Date());
  const current = now();
  const recoveryToken = input.recoveryToken ?? randomUUID();
  const reservations = await input.repository.claimStaleWriting({
    staleBefore: new Date(
      current.getTime() - (input.staleWriteMs ?? DEFAULT_STALE_WRITE_MS)
    ).toISOString(),
    claimedAt: current.toISOString(),
    recoveryToken,
    limit: input.batchSize ?? DEFAULT_BATCH_SIZE
  });
  const result = { claimed: reservations.length, activated: 0, expired: 0, failed: 0 };

  for (const reservation of reservations) {
    try {
      const stored = await input.storage.headObjectMetadata(reservation.objectKey);
      if (!stored) {
        if (await input.repository.expireMissing({
          checksumSha256: reservation.checksumSha256,
          formatVersion: reservation.formatVersion,
          recoveryToken
        })) {
          result.expired += 1;
        }
        continue;
      }
      if (!matchesImmutableStorageIdentity(stored, reservation)) {
        await input.repository.markRecoveryFailure({
          checksumSha256: reservation.checksumSha256,
          formatVersion: reservation.formatVersion,
          recoveryToken,
          errorCode: "IMMUTABLE_OBJECT_RECOVERY_IDENTITY_MISMATCH",
          failedAt: now().toISOString()
        });
        result.failed += 1;
        continue;
      }
      if (await input.repository.activateRecovered({
        ...reservation,
        recoveryToken,
        verifiedAt: now().toISOString()
      })) {
        result.activated += 1;
      }
    } catch {
      await input.repository.markRecoveryFailure({
        checksumSha256: reservation.checksumSha256,
        formatVersion: reservation.formatVersion,
        recoveryToken,
        errorCode: "IMMUTABLE_OBJECT_RECOVERY_STORAGE_FAILED",
        failedAt: now().toISOString()
      });
      result.failed += 1;
    }
  }
  return result;
}
