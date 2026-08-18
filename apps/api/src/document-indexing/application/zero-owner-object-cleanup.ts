export type ZeroOwnerObjectCleanupAction = {
  publicId: string;
  objectId: string;
  attempt: number;
  maximumAttempts: number;
};

export function resolveZeroOwnerObjectCleanupConcurrency(
  objectStorageCapacity: number
): number {
  if (!Number.isSafeInteger(objectStorageCapacity)
    || objectStorageCapacity < 1 || objectStorageCapacity > 1_000) {
    throw cleanupError("invalid_configuration");
  }
  return Math.min(32, objectStorageCapacity);
}

export function createZeroOwnerObjectCleanup(input: {
  concurrency?: number;
  actions: {
    recoverStale(request: {
      expiredBefore: string;
      notBefore: string;
      safeErrorCode: string;
      limit: number;
    }): Promise<number>;
    claim(request: {
      owner: string;
      limit: number;
      leaseExpiresAt: string;
    }): Promise<readonly ZeroOwnerObjectCleanupAction[]>;
    complete(request: {
      publicId: string;
      owner: string;
      completedAt: string;
    }): Promise<boolean>;
    retry(request: {
      publicId: string;
      owner: string;
      notBefore: string;
      safeErrorCode: string;
    }): Promise<boolean>;
    fail(request: {
      publicId: string;
      owner: string;
      failedAt: string;
      safeErrorCode: string;
    }): Promise<boolean>;
  };
  objects: {
    removeZeroOwner(objectId: string): Promise<void>;
  };
}) {
  const concurrency = validateConcurrency(input.concurrency ?? 4);
  return {
    async run(request: {
      owner: string;
      limit: number;
      now: string;
      leaseExpiresAt: string;
      retryAt: string;
      signal: AbortSignal;
    }) {
      validateRequest(request);
      await input.actions.recoverStale({
        expiredBefore: request.now,
        notBefore: request.now,
        safeErrorCode: "STALE_ZERO_OWNER_OBJECT_LEASE",
        limit: request.limit
      });
      const result = {
        claimed: 0,
        completed: 0,
        retried: 0,
        failed: 0
      };
      const leaseDurationMs = Date.parse(request.leaseExpiresAt)
        - Date.parse(request.now);
      let remaining = request.limit;
      let windowIndex = 0;
      while (remaining > 0) {
        if (request.signal.aborted) throw request.signal.reason;
        const claimLimit = Math.min(remaining, concurrency);
        const actions = await input.actions.claim({
          owner: request.owner,
          limit: claimLimit,
          leaseExpiresAt: windowIndex === 0
            ? request.leaseExpiresAt
            : new Date(Date.now() + leaseDurationMs).toISOString()
        });
        if (actions.length > claimLimit) {
          throw cleanupError("claimed_action_limit_exceeded");
        }
        if (actions.length === 0) break;
        result.claimed += actions.length;
        remaining -= actions.length;
        windowIndex += 1;
        await Promise.all(actions.map(async (action) => {
          if (request.signal.aborted) throw request.signal.reason;
          validateAction(action);
          try {
            await input.objects.removeZeroOwner(action.objectId);
            await requireTransition(input.actions.complete({
              publicId: action.publicId,
              owner: request.owner,
              completedAt: request.now
            }));
            result.completed += 1;
          } catch (error) {
            const safeErrorCode = errorCode(error);
            if (safeErrorCode === "owners_present") {
              await requireTransition(input.actions.complete({
                publicId: action.publicId,
                owner: request.owner,
                completedAt: request.now
              }));
              result.completed += 1;
              return;
            }
            if (action.attempt < action.maximumAttempts) {
              await requireTransition(input.actions.retry({
                publicId: action.publicId,
                owner: request.owner,
                notBefore: request.retryAt,
                safeErrorCode
              }));
              result.retried += 1;
            } else {
              await requireTransition(input.actions.fail({
                publicId: action.publicId,
                owner: request.owner,
                failedAt: request.now,
                safeErrorCode
              }));
              result.failed += 1;
            }
          }
        }));
      }
      return result;
    }
  };
}

function validateConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) {
    throw cleanupError("invalid_configuration");
  }
  return value;
}

function validateRequest(input: {
  owner: string;
  limit: number;
  now: string;
  leaseExpiresAt: string;
  retryAt: string;
}): void {
  if (!input.owner || Buffer.byteLength(input.owner, "utf8") > 255
    || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000
    || !Number.isFinite(Date.parse(input.now))
    || !Number.isFinite(Date.parse(input.leaseExpiresAt))
    || !Number.isFinite(Date.parse(input.retryAt))
    || Date.parse(input.leaseExpiresAt) <= Date.parse(input.now)) {
    throw cleanupError("invalid_input");
  }
}

function validateAction(action: ZeroOwnerObjectCleanupAction): void {
  if (!action.publicId || !action.objectId
    || !Number.isSafeInteger(action.attempt) || action.attempt < 1
    || !Number.isSafeInteger(action.maximumAttempts)
    || action.maximumAttempts < action.attempt) {
    throw cleanupError("stored_action_invalid");
  }
}

async function requireTransition(value: Promise<boolean>): Promise<void> {
  if (!await value) throw cleanupError("lease_lost");
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error
    && typeof error.code === "string" && error.code
    ? error.code.slice(0, 128) : "ZERO_OWNER_OBJECT_CLEANUP_FAILED";
}

function cleanupError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Zero-owner object cleanup error: ${code}`), {
    code
  });
}
