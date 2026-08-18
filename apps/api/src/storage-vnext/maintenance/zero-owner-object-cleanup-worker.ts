import type {
  StorageVnextCleanupActionRepository,
  StorageVnextCleanupActionSelector
} from "../cleanup/postgres-cleanup-action-repository.js";

const SELECTOR: StorageVnextCleanupActionSelector = {
  domain: "zero_owner_object",
  plane: "object_storage",
  resourceKind: "zero_owner_object"
};

export function createStorageVnextZeroOwnerObjectCleanupWorker(input: {
  actions: Pick<StorageVnextCleanupActionRepository,
    "claim" | "recoverStale" | "complete" | "releaseForRetry">;
  objects: {
    deleteZeroOwner(objectId: string): Promise<{
      deletedVersions: number;
      deletedMarkers: number;
      abortedMultipartUploads: number;
    }>;
  };
  purgeDeletedRegistrations(request: { limit: number }): Promise<number>;
}) {
  return createStorageVnextObjectCleanupWorker({
    ...input,
    selector: SELECTOR,
    staleLeaseCode: "STALE_ZERO_OWNER_OBJECT_CLEANUP_LEASE",
    providerFailureCode: "ZERO_OWNER_OBJECT_PROVIDER_DELETE_FAILED"
  });
}

export function createStorageVnextObjectCleanupWorker(input: {
  actions: Pick<StorageVnextCleanupActionRepository,
    "claim" | "recoverStale" | "complete" | "releaseForRetry">;
  objects: {
    deleteZeroOwner(objectId: string): Promise<{
      deletedVersions: number;
      deletedMarkers: number;
      abortedMultipartUploads: number;
    }>;
  };
  purgeDeletedRegistrations(request: { limit: number }): Promise<number>;
  selector: StorageVnextCleanupActionSelector;
  staleLeaseCode: string;
  providerFailureCode: string;
}) {
  return {
    async runBatch(request: {
      owner: string;
      limit: number;
      leaseExpiresAt: string;
      now: string;
      retryDelayMilliseconds: number;
      signal: AbortSignal;
    }) {
      validateRequest(request);
      const retryDelayMilliseconds = validateRetryDelay(
        request.retryDelayMilliseconds
      );
      await input.actions.recoverStale({
        expiredBefore: request.now,
        notBefore: request.now,
        safeErrorCode: input.staleLeaseCode,
        limit: request.limit,
        selector: input.selector
      });
      const actions = await input.actions.claim({
        owner: request.owner,
        limit: request.limit,
        leaseExpiresAt: request.leaseExpiresAt,
        selector: input.selector
      });
      let deleted = 0;
      let skippedOwned = 0;
      let skippedMissing = 0;
      let retried = 0;
      let completed = 0;
      for (const action of actions) {
        throwIfAborted(request.signal);
        try {
          await input.objects.deleteZeroOwner(action.target.publicId);
          deleted += 1;
        } catch (error) {
          if (hasCode(error, "owners_present")) skippedOwned += 1;
          else if (hasCode(error, "object_not_found")) skippedMissing += 1;
          else {
            await input.actions.releaseForRetry({
              publicId: action.publicId,
              owner: request.owner,
              notBefore: new Date(
                new Date(request.now).getTime() + retryDelayMilliseconds
              ).toISOString(),
              safeErrorCode: cleanupErrorCode(error, input.providerFailureCode),
              checkpoint: action.checkpoint
            });
            retried += 1;
            continue;
          }
        }
        const actionCompleted = await input.actions.complete({
          publicId: action.publicId,
          owner: request.owner
        });
        if (!actionCompleted) throw workerError("action_conflict");
        completed += 1;
      }
      const purgedRegistrations = actions.length > 0
        ? await input.purgeDeletedRegistrations({ limit: request.limit })
        : 0;
      return {
        outcome: actions.length > 0 ? "progress" as const : "idle" as const,
        claimed: actions.length,
        deleted,
        skippedOwned,
        skippedMissing,
        retried,
        completed,
        purgedRegistrations
      };
    }
  };
}

function validateRequest(input: {
  owner: string;
  limit: number;
  leaseExpiresAt: string;
  now: string;
}): void {
  if (
    !input.owner
    || !Number.isSafeInteger(input.limit)
    || input.limit < 1
    || input.limit > 1_000
    || !validTimestamp(input.now)
    || !validTimestamp(input.leaseExpiresAt)
  ) throw workerError("invalid_input");
}

function validateRetryDelay(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw workerError("invalid_configuration");
  }
  return value;
}

function validTimestamp(value: string): boolean {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Storage vNext zero-owner object cleanup aborted", "AbortError");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function cleanupErrorCode(error: unknown, fallback: string): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code.slice(0, 128);
  }
  return fallback;
}

function workerError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext zero-owner object cleanup worker error: ${code}`),
    { code }
  );
}
