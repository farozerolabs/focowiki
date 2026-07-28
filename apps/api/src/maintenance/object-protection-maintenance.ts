import { randomUUID } from "node:crypto";
import type {
  ObjectProtectionRepository
} from "../application/ports/object-protection-repository.js";

const PROTECTION_MAINTENANCE_LEASE_MS = 2 * 60_000;
const PROTECTION_MAINTENANCE_RETRY_MS = 30_000;

export type ObjectProtectionMaintenanceResult = {
  claimed: boolean;
  phase: string;
  processed: number;
  completed: boolean;
  failed: boolean;
};

export async function runObjectProtectionMaintenanceSlice(input: {
  repository: ObjectProtectionRepository;
  batchSize: number;
  leaseToken?: string;
  now?: () => Date;
}): Promise<ObjectProtectionMaintenanceResult> {
  const now = input.now ?? (() => new Date());
  const startedAt = now();
  const leaseToken = input.leaseToken ?? `object-protection-${randomUUID()}`;
  const claim = await input.repository.claimMaintenance({
    leaseToken,
    now: startedAt.toISOString(),
    leaseExpiresAt: new Date(
      startedAt.getTime() + PROTECTION_MAINTENANCE_LEASE_MS
    ).toISOString()
  });
  if (!claim) {
    const status = await input.repository.getStatus();
    return {
      claimed: false,
      phase: status.phase,
      processed: 0,
      completed: status.readiness === "ready",
      failed: status.readiness === "failed"
    };
  }

  try {
    const batch = claim.phase === "dirty_refresh"
      ? await input.repository.refreshDirtyBatch({
          claim,
          leaseToken,
          limit: input.batchSize,
          now: now().toISOString()
        })
      : await input.repository.runBackfillBatch({
          claim,
          leaseToken,
          limit: input.batchSize,
          now: now().toISOString()
        });
    return {
      claimed: true,
      phase: batch.phase,
      processed: batch.processed,
      completed: batch.completed,
      failed: false
    };
  } catch (error) {
    const failedAt = now();
    await input.repository.failMaintenance({
      claim,
      leaseToken,
      errorCode: readSafeErrorCode(error),
      errorMessage: "Object protection maintenance will retry",
      retryAt: new Date(
        failedAt.getTime() + PROTECTION_MAINTENANCE_RETRY_MS
      ).toISOString(),
      failedAt: failedAt.toISOString()
    });
    return {
      claimed: true,
      phase: claim.phase,
      processed: 0,
      completed: false,
      failed: true
    };
  }
}

function readSafeErrorCode(error: unknown): string {
  if (
    error
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
    && /^[A-Z0-9_]{3,80}$/u.test(error.code)
  ) {
    return error.code;
  }
  return "OBJECT_PROTECTION_MAINTENANCE_FAILED";
}
