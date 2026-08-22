import type { StorageVnextOwnershipRepository } from
  "../../storage-vnext/ownership/ports.js";

type ProjectionCleanupClaim = Readonly<{
  publicId: string;
  objectId: string;
  writeAttemptPublicId: string;
  leaseGeneration: number;
}>;

export function createDocumentProjectionCleanupRuntime(input: {
  workerId: string;
  leaseDurationMs: number;
  concurrency: number;
  retryDelayMs: number;
  outbox: {
    claim(request: {
      workerId: string;
      now: string;
      leaseDurationMs: number;
      limit: number;
    }): Promise<readonly ProjectionCleanupClaim[]>;
    complete(request: {
      publicId: string;
      workerId: string;
      leaseGeneration: number;
      now: string;
    }): Promise<boolean>;
    fail(request: {
      publicId: string;
      workerId: string;
      leaseGeneration: number;
      now: string;
      retryAt: string;
      errorCode: string;
    }): Promise<boolean>;
    metrics?(request: { now: string }): Promise<Readonly<{
      backlogDepth: number;
      oldestAgeMs: number;
      verifiedReservationDebt: number;
    }>>;
  };
  ownership: Pick<StorageVnextOwnershipRepository,
    "releaseVerifiedReservation">;
  now(): string;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
  onMetrics?(fields: Readonly<{
    claimed: number;
    completed: number;
    retried: number;
    failed: number;
    backlogDepth: number;
    oldestAgeMs: number;
    verifiedReservationDebt: number;
  }>): void;
}) {
  validateConfiguration(input);

  async function runOnce(signal: AbortSignal): Promise<number> {
    if (signal.aborted) return 0;
    const claims = await input.outbox.claim({
      workerId: input.workerId,
      now: input.now(),
      leaseDurationMs: input.leaseDurationMs,
      limit: input.concurrency
    });
    const outcomes = await Promise.all(
      claims.map((claim) => release(claim, signal))
    );
    const metrics = await input.outbox.metrics?.({ now: input.now() }) ?? {
      backlogDepth: 0,
      oldestAgeMs: 0,
      verifiedReservationDebt: 0
    };
    input.onMetrics?.({
      claimed: claims.length,
      completed: outcomes.filter((outcome) => outcome === "completed").length,
      retried: outcomes.filter((outcome) => outcome === "retried").length,
      failed: outcomes.filter((outcome) => outcome === "failed").length,
      ...metrics
    });
    return claims.length;
  }

  async function release(
    claim: ProjectionCleanupClaim,
    signal: AbortSignal
  ): Promise<"completed" | "retried" | "failed"> {
    signal.throwIfAborted();
    try {
      await input.ownership.releaseVerifiedReservation({
        objectId: claim.objectId,
        writeAttemptPublicId: claim.writeAttemptPublicId
      });
      await complete(claim);
      return "completed";
    } catch (error) {
      if (isSupersededHolder(error)) {
        await complete(claim);
        return "completed";
      }
      const now = input.now();
      const persisted = await input.outbox.fail({
        publicId: claim.publicId,
        workerId: input.workerId,
        leaseGeneration: claim.leaseGeneration,
        now,
        retryAt: new Date(Date.parse(now) + input.retryDelayMs).toISOString(),
        errorCode: cleanupErrorCode(error)
      });
      return persisted ? "retried" : "failed";
    }
  }

  async function complete(claim: ProjectionCleanupClaim): Promise<void> {
    await input.outbox.complete({
      publicId: claim.publicId,
      workerId: input.workerId,
      leaseGeneration: claim.leaseGeneration,
      now: input.now()
    });
  }

  return {
    runOnce,
    async run(signal: AbortSignal): Promise<void> {
      while (!signal.aborted) {
        const completed = await runOnce(signal);
        if (completed === 0 && !signal.aborted) {
          await input.wait(250, signal);
        }
      }
    }
  };
}

function isSupersededHolder(error: unknown): boolean {
  const code = errorCode(error);
  return code === "write_attempt_conflict" || code === "object_not_found";
}

function cleanupErrorCode(error: unknown): string {
  const code = errorCode(error);
  return code && /^[A-Za-z0-9_]{1,96}$/u.test(code)
    ? `PROJECTION_CLEANUP_${code.toLocaleUpperCase("en-US")}`
    : "PROJECTION_CLEANUP_FAILED";
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string" ? error.code : null;
}

function validateConfiguration(input: {
  leaseDurationMs: number;
  concurrency: number;
  retryDelayMs: number;
}): void {
  if (!Number.isSafeInteger(input.leaseDurationMs)
    || input.leaseDurationMs < 100
    || !Number.isSafeInteger(input.concurrency)
    || input.concurrency < 1 || input.concurrency > 64
    || !Number.isSafeInteger(input.retryDelayMs)
    || input.retryDelayMs < 1) {
    throw new Error("DOCUMENT_PROJECTION_CLEANUP_CONFIGURATION_INVALID");
  }
}
