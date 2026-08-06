import { createStorageVnextMaintenanceRequestHash } from "./identity.js";
import {
  STORAGE_VNEXT_MAINTENANCE_PHASES,
  type StorageVnextMaintenanceCheckpoint,
  type StorageVnextMaintenanceCleanup,
  type StorageVnextMaintenancePhase,
  type StorageVnextMaintenancePhaseResult,
  type StorageVnextMaintenancePhaseRunner,
  type StorageVnextMaintenanceResourceGate,
  type StorageVnextMaintenanceRepository,
  type StorageVnextMaintenanceRequest
} from "./ports.js";

const MAX_ID_BYTES = 255;
const MAX_CURSOR_BYTES = 2_048;
const MAX_ATTEMPTS = 100;
const MAX_RECOVERY_LIMIT = 1_000;
const UNIFIED_SEARCH_PROJECTION = Object.freeze({
  activeRole: "active" as const,
  candidateRole: "candidate" as const,
  documentKinds: ["content", "graph_seed"] as const
});

type FailureObserver = (failure: {
  operationPublicId: string;
  knowledgeBaseId: string;
  attempt: number;
  code: string;
  error: unknown;
}) => void;

export function createStorageVnextMaintenanceCoordinator(input: {
  repository: StorageVnextMaintenanceRepository;
  phaseRunner: StorageVnextMaintenancePhaseRunner;
  cleanup: StorageVnextMaintenanceCleanup;
  resourceGate: StorageVnextMaintenanceResourceGate;
  now?: () => Date;
  phaseTimeoutMs: number;
  onFailure?: FailureObserver;
}) {
  validateTimeout(input.phaseTimeoutMs);
  const now = input.now ?? (() => new Date());
  const requests = createStorageVnextMaintenanceRequestService({
    repository: input.repository
  });

  return {
    requestMaintenance: requests.requestMaintenance,

    async runOne(claimInput: {
      workerId: string;
      leaseExpiresAt: string;
      signal?: AbortSignal;
    }) {
      assertId(claimInput.workerId);
      assertTimestamp(claimInput.leaseExpiresAt);
      const capacity = await input.resourceGate.tryAcquire();
      if (capacity.outcome === "backpressured") {
        return {
          outcome: "backpressured" as const,
          operationPublicId: null,
          reasonCode: capacity.reasonCode
        };
      }
      try {
      const claim = await input.repository.claimOne(claimInput);
      if (!claim) return { outcome: "idle" as const, operationPublicId: null };
      if (claim.state === "superseded") {
        await terminate({
          knowledgeBaseId: claim.knowledgeBaseId,
          operationPublicId: claim.operationPublicId,
          leaseOwner: requireLeaseOwner(claim.leaseOwner),
          outcome: "superseded",
          resultCode: "MAINTENANCE_SUPERSEDED",
          summary: checkpointSummary(claim.checkpoint, claim.attempt)
        });
        return {
          outcome: "superseded" as const,
          operationPublicId: claim.operationPublicId
        };
      }

      try {
        const phaseResult = await runPhaseWithTimeout({
          phaseRunner: input.phaseRunner,
          phaseTimeoutMs: input.phaseTimeoutMs,
          knowledgeBaseId: claim.knowledgeBaseId,
          operationPublicId: claim.operationPublicId,
          checkpoint: claim.checkpoint,
          ...(claimInput.signal ? { signal: claimInput.signal } : {})
        });
        const updated = updateCheckpoint(claim.checkpoint, phaseResult, now());
        if (updated.completed) {
          await terminate({
            knowledgeBaseId: claim.knowledgeBaseId,
            operationPublicId: claim.operationPublicId,
            leaseOwner: requireLeaseOwner(claim.leaseOwner),
            outcome: "completed",
            resultCode: "MAINTENANCE_COMPLETED",
            summary: checkpointSummary(updated.checkpoint, claim.attempt)
          });
          return {
            outcome: "completed" as const,
            operationPublicId: claim.operationPublicId
          };
        }
        await input.repository.saveProgress({
          operationPublicId: claim.operationPublicId,
          leaseOwner: requireLeaseOwner(claim.leaseOwner),
          checkpoint: updated.checkpoint
        });
        return {
          outcome: phaseResult.outcome,
          operationPublicId: claim.operationPublicId
        };
      } catch (error) {
        if (isStalePlanFailure(error)) {
          await terminate({
            knowledgeBaseId: claim.knowledgeBaseId,
            operationPublicId: claim.operationPublicId,
            leaseOwner: requireLeaseOwner(claim.leaseOwner),
            outcome: "superseded",
            resultCode: "MAINTENANCE_STALE_PLAN",
            summary: checkpointSummary(claim.checkpoint, claim.attempt)
          });
          return {
            outcome: "superseded" as const,
            operationPublicId: claim.operationPublicId
          };
        }
        const safeErrorCode = maintenanceFailureCode(error);
        input.onFailure?.({
          operationPublicId: claim.operationPublicId,
          knowledgeBaseId: claim.knowledgeBaseId,
          attempt: claim.attempt + 1,
          code: safeErrorCode,
          error
        });
        const retry = await input.repository.releaseForRetry({
          operationPublicId: claim.operationPublicId,
          leaseOwner: requireLeaseOwner(claim.leaseOwner),
          safeErrorCode
        });
        if (retry === "retry") {
          return {
            outcome: "retry" as const,
            operationPublicId: claim.operationPublicId
          };
        }
        await terminate({
          knowledgeBaseId: claim.knowledgeBaseId,
          operationPublicId: claim.operationPublicId,
          leaseOwner: requireLeaseOwner(claim.leaseOwner),
          outcome: "failed",
          resultCode: "MAINTENANCE_RETRY_EXHAUSTED",
          summary: checkpointSummary(claim.checkpoint, claim.attempt + 1)
        });
        return {
          outcome: "failed" as const,
          operationPublicId: claim.operationPublicId
        };
      }
      } finally {
        capacity.release();
      }
    },

    async recoverStale(recoveryInput: {
      expiredBefore: string;
      retryAt: string;
      limit: number;
    }) {
      assertTimestamp(recoveryInput.expiredBefore);
      assertTimestamp(recoveryInput.retryAt);
      if (
        !Number.isSafeInteger(recoveryInput.limit)
        || recoveryInput.limit < 1
        || recoveryInput.limit > MAX_RECOVERY_LIMIT
      ) throw maintenanceError("invalid_input");
      return input.repository.recoverStale(recoveryInput);
    }
  };

  async function terminate(termination: {
    knowledgeBaseId: string;
    operationPublicId: string;
    leaseOwner: string;
    outcome: "completed" | "failed" | "superseded";
    resultCode: string;
    summary?: ReturnType<typeof checkpointSummary>;
  }): Promise<void> {
    await input.cleanup.terminate({
      knowledgeBaseId: termination.knowledgeBaseId,
      operationPublicId: termination.operationPublicId,
      outcome: termination.outcome
    });
    await input.repository.complete({
      operationPublicId: termination.operationPublicId,
      leaseOwner: termination.leaseOwner,
      state: termination.outcome,
      resultCode: termination.resultCode,
      ...(termination.summary ? { summary: termination.summary } : {})
    });
  }
}

export function createStorageVnextMaintenanceRequestService(input: {
  repository: StorageVnextMaintenanceRepository;
}) {
  return {
    async requestMaintenance(request: StorageVnextMaintenanceRequest) {
      validateRequest(request);
      return input.repository.acceptMaintenance({
        ...request,
        requestHash: createStorageVnextMaintenanceRequestHash(request),
        workKind: "maintenance",
        initialCheckpoint: initialCheckpoint(request)
      });
    }
  };
}

function initialCheckpoint(
  request: StorageVnextMaintenanceRequest
): StorageVnextMaintenanceCheckpoint {
  return {
    version: 1,
    trigger: request.trigger,
    phase: "planning",
    cursor: null,
    batchOrdinal: 0,
    baseResourceRevision: request.expectedResourceRevision,
    completedCount: 0,
    expectedCount: 0,
    processedBytes: 0,
    startedAt: request.requestedAt,
    lastProgressAt: request.requestedAt,
    elapsedActiveMs: 0,
    throughputPerSecond: 0,
    estimatedCompletionAt: null,
    maxAttempts: request.maxAttempts,
    resultExpiresAt: request.expiresAt
  };
}

function updateCheckpoint(
  current: StorageVnextMaintenanceCheckpoint,
  result: StorageVnextMaintenancePhaseResult,
  progressAt: Date
): { checkpoint: StorageVnextMaintenanceCheckpoint; completed: boolean } {
  assertPhaseResult(result);
  const elapsed = Math.max(0, progressAt.getTime() - Date.parse(current.lastProgressAt));
  const checkpoint: StorageVnextMaintenanceCheckpoint = {
    ...current,
    cursor: result.outcome === "progress" ? result.cursor : null,
    batchOrdinal: current.batchOrdinal + (result.batchOrdinalDelta ?? 1),
    completedCount: current.completedCount + result.completedDelta,
    expectedCount: Math.max(
      current.completedCount + result.completedDelta,
      result.expectedCount
    ),
    processedBytes: current.processedBytes + result.processedBytesDelta,
    lastProgressAt: progressAt.toISOString(),
    elapsedActiveMs: current.elapsedActiveMs + elapsed,
    throughputPerSecond: 0,
    estimatedCompletionAt: null
  };
  checkpoint.throughputPerSecond = calculateThroughputPerSecond(checkpoint);
  checkpoint.estimatedCompletionAt = calculateEstimatedCompletionAt(
    checkpoint,
    progressAt
  );
  if (result.outcome === "progress") return { checkpoint, completed: false };
  const next = nextPhase(current.phase);
  if (!next) return { checkpoint, completed: true };
  return {
    checkpoint: {
      ...checkpoint,
      phase: next,
      cursor: null,
      batchOrdinal: 0
    },
    completed: false
  };
}

function nextPhase(phase: StorageVnextMaintenancePhase): StorageVnextMaintenancePhase | null {
  const index = STORAGE_VNEXT_MAINTENANCE_PHASES.indexOf(phase);
  return STORAGE_VNEXT_MAINTENANCE_PHASES[index + 1] ?? null;
}

async function runPhaseWithTimeout(input: {
  phaseRunner: StorageVnextMaintenancePhaseRunner;
  phaseTimeoutMs: number;
  knowledgeBaseId: string;
  operationPublicId: string;
  checkpoint: StorageVnextMaintenanceCheckpoint;
  signal?: AbortSignal;
}): Promise<StorageVnextMaintenancePhaseResult> {
  const controller = new AbortController();
  const abortFromRole = () => controller.abort(
    input.signal?.reason
      ?? new DOMException("Maintenance role shutting down", "AbortError")
  );
  input.signal?.addEventListener("abort", abortFromRole, { once: true });
  if (input.signal?.aborted) abortFromRole();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(maintenanceError("phase_timeout"));
    }, input.phaseTimeoutMs);
  });
  try {
    return await Promise.race([
      input.phaseRunner.runPhase({
        knowledgeBaseId: input.knowledgeBaseId,
        operationPublicId: input.operationPublicId,
        checkpoint: input.checkpoint,
        searchProjection: UNIFIED_SEARCH_PROJECTION,
        signal: controller.signal
      }),
      timeoutPromise
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abortFromRole);
  }
}

function checkpointSummary(
  checkpoint: StorageVnextMaintenanceCheckpoint,
  retryCount: number
) {
  return {
    phase: checkpoint.phase,
    completedCount: checkpoint.completedCount,
    expectedCount: checkpoint.expectedCount,
    processedBytes: checkpoint.processedBytes,
    elapsedActiveMs: checkpoint.elapsedActiveMs,
    throughputPerSecond: checkpoint.throughputPerSecond,
    estimatedCompletionAt: checkpoint.estimatedCompletionAt,
    lastProgressAt: checkpoint.lastProgressAt,
    trigger: checkpoint.trigger,
    retryCount
  };
}

function calculateThroughputPerSecond(
  checkpoint: StorageVnextMaintenanceCheckpoint
): number {
  const activeSeconds = checkpoint.elapsedActiveMs / 1_000;
  return activeSeconds > 0 ? checkpoint.completedCount / activeSeconds : 0;
}

function calculateEstimatedCompletionAt(
  checkpoint: StorageVnextMaintenanceCheckpoint,
  progressAt: Date
): string | null {
  if (
    checkpoint.throughputPerSecond <= 0
    || checkpoint.expectedCount <= checkpoint.completedCount
  ) return null;
  const remainingMs = Math.ceil(
    (checkpoint.expectedCount - checkpoint.completedCount)
    / checkpoint.throughputPerSecond
    * 1_000
  );
  return new Date(progressAt.getTime() + remainingMs).toISOString();
}

function isStalePlanFailure(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "stale_plan" || code === "knowledge_base_deleted";
}

function maintenanceFailureCode(error: unknown): string {
  if (
    error instanceof Error
    && "code" in error
    && (error as { code?: unknown }).code === "provider_timeout"
  ) return "MAINTENANCE_PHASE_TIMEOUT";
  if (
    error instanceof Error
    && "code" in error
    && (error as { code?: unknown }).code === "phase_timeout"
  ) return "MAINTENANCE_PHASE_TIMEOUT";
  return "MAINTENANCE_PHASE_FAILED";
}

function validateRequest(request: StorageVnextMaintenanceRequest): void {
  for (const value of [
    request.knowledgeBaseId,
    request.operationPublicId,
    request.idempotencyKey,
    request.settingsRevisionPublicId
  ]) assertId(value);
  if (
    !Number.isSafeInteger(request.expectedResourceRevision)
    || request.expectedResourceRevision < 0
    || !Number.isSafeInteger(request.maxAttempts)
    || request.maxAttempts < 1
    || request.maxAttempts > MAX_ATTEMPTS
  ) throw maintenanceError("invalid_input");
  assertTimestamp(request.requestedAt);
  assertTimestamp(request.expiresAt);
  if (Date.parse(request.expiresAt) <= Date.parse(request.requestedAt)) {
    throw maintenanceError("invalid_input");
  }
}

function assertPhaseResult(result: StorageVnextMaintenancePhaseResult): void {
  for (const value of [
    result.completedDelta,
    result.expectedCount,
    result.processedBytesDelta,
    result.batchOrdinalDelta ?? 1
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw maintenanceError("invalid_phase_result");
    }
  }
  if (result.outcome === "progress") assertCursor(result.cursor);
}

function validateTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw maintenanceError("invalid_configuration");
  }
}

function assertId(value: string): void {
  if (!value || Buffer.byteLength(value) > MAX_ID_BYTES) {
    throw maintenanceError("invalid_input");
  }
}

function assertCursor(value: string): void {
  if (!value || Buffer.byteLength(value) > MAX_CURSOR_BYTES) {
    throw maintenanceError("invalid_input");
  }
}

function assertTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw maintenanceError("invalid_input");
}

function requireLeaseOwner(value: string | null): string {
  if (!value) throw maintenanceError("lease_lost");
  return value;
}

function maintenanceError(code: string): Error {
  return Object.assign(new Error(`Storage vNext maintenance error: ${code}`), { code });
}
