import { createHash } from "node:crypto";
import type {
  StorageVnextCandidateDelta,
  StorageVnextCandidateTerminalOutcome,
  StorageVnextReleaseReadPort,
  StorageVnextReleaseWritePort
} from "../release/ports.js";
import type {
  StorageVnextBoundedMetadata,
  StorageVnextPublicId
} from "../shared/types.js";
import type {
  StorageVnextBoundedResult,
  StorageVnextLiveWork,
  StorageVnextWorkflowClaimPort,
  StorageVnextWorkflowWritePort
} from "../workflow/ports.js";
import type { WebhookDispatcher } from "../../webhooks/dispatcher.js";
import { dispatchWebhookSafely } from "../../webhooks/safe-dispatch.js";

type PublicationWorkflowPort = Pick<
  StorageVnextWorkflowClaimPort & StorageVnextWorkflowWritePort,
  | "claim" | "renew" | "saveCheckpoint" | "complete"
  | "releaseForRetry" | "releaseForContinuation"
>;

type PublicationReleasePort = Pick<
  StorageVnextReleaseReadPort & StorageVnextReleaseWritePort,
  "getLiveCandidate" | "activateCandidate" | "terminateCandidate"
>;

type PublicationLimits = {
  maximumConcurrency: number;
  maximumAttempts: number;
  attemptDeadlineMilliseconds: number;
  heartbeatIntervalMilliseconds: number;
  leaseTtlMilliseconds: number;
  retryDelayMilliseconds: number;
  resultRetentionMilliseconds: number;
  rollbackRetentionMilliseconds: number;
};

type PublicationProcessor = {
  publish(input: {
    knowledgeBaseId: string;
    candidatePublicId: string;
    operationPublicId: string;
    signal: AbortSignal;
    beforeValidate?: () => Promise<
      | { state: "ready" }
      | { state: "pending" }
    >;
  }): Promise<
    | { searchProjectionPublicId: StorageVnextPublicId }
    | { state: "pending" }
  >;
};

type PublicationReadiness = {
  inspect(input: { knowledgeBaseId: string }): Promise<
    | { state: "ready" }
    | { state: "pending" }
  >;
};

type FailureObserver = (failure: {
  operationPublicId: string;
  knowledgeBaseId: string;
  attempt: number;
  code: string;
  error: unknown;
}) => void;

type PublicationWorkerInput = {
  workflow: PublicationWorkflowPort;
  releases: PublicationReleasePort;
  processor: PublicationProcessor;
  readiness?: PublicationReadiness;
  mutations?: {
    prepare(input: {
      work: StorageVnextLiveWork;
      signal?: AbortSignal;
    }): Promise<{ checkpoint: StorageVnextBoundedMetadata }>;
    inspectSemanticStages?(input: {
      work: StorageVnextLiveWork;
    }): Promise<
      | { state: "ready" }
      | { state: "pending" }
      | { state: "failed"; safeCode: string }
    >;
    ensureSemanticStages?(input: {
      work: StorageVnextLiveWork;
    }): Promise<void>;
    terminate?(input: {
      work: StorageVnextLiveWork;
      outcome: "failed" | "timed_out";
      resultCode: string;
      completedAt: string;
      resultExpiresAt: string;
    }): Promise<void>;
  };
  limits: PublicationLimits;
  clock(): string;
  onFailure?: FailureObserver;
  webhooks?: Pick<WebhookDispatcher, "dispatch">;
  onWebhookError?: (error: unknown) => void;
};

type PublicationCheckpoint = {
  phase: "planning" | "candidate_ready";
  candidatePublicId: string;
  expectedActiveRootPublicId?: string | null;
  expectedActiveRevision?: number;
  searchProjectionPublicId?: string;
};

type WorkOutcome = "completed" | "retried" | "terminal";

export function createStorageVnextPublicationWorker(input: PublicationWorkerInput) {
  validateLimits(input.limits);
  return {
    async runOnce(request: {
      owner: string;
      limit: number;
      leaseExpiresAt: string;
      signal?: AbortSignal;
    }): Promise<{ claimed: number; completed: number; retried: number; terminal: number }> {
      assertClaim(request, input.limits.maximumConcurrency);
      if (request.signal?.aborted) {
        return { claimed: 0, completed: 0, retried: 0, terminal: 0 };
      }
      const works = await input.workflow.claim({
        kinds: input.mutations ? ["publication", "mutation"] : ["publication"],
        owner: request.owner,
        limit: request.limit,
        leaseExpiresAt: request.leaseExpiresAt
      });
      const outcomes = await Promise.all(works.map((work) =>
        processWork(input, work, request.owner, request.signal)));
      return {
        claimed: works.length,
        completed: outcomes.filter((outcome) => outcome === "completed").length,
        retried: outcomes.filter((outcome) => outcome === "retried").length,
        terminal: outcomes.filter((outcome) => outcome === "terminal").length
      };
    }
  };
}

async function processWork(
  input: PublicationWorkerInput,
  work: StorageVnextLiveWork,
  owner: string,
  roleSignal: AbortSignal | undefined
): Promise<WorkOutcome> {
  assertClaimedWork(work, owner);
  const heartbeat = startLeaseHeartbeat(input, work, owner, roleSignal);
  let durableCheckpoint = work.checkpoint;
  let checkpoint: PublicationCheckpoint | null = null;
  try {
    if (work.kind === "mutation" && !isPublicationCheckpoint(durableCheckpoint)) {
      if (!input.mutations) throw workerError("mutation_preparer_unavailable");
      const prepared = await input.mutations.prepare({
        work,
        ...(roleSignal ? { signal: roleSignal } : {})
      });
      durableCheckpoint = prepared.checkpoint;
      await input.workflow.saveCheckpoint({
        publicId: work.publicId,
        owner,
        checkpoint: durableCheckpoint
      });
    }
    checkpoint = parseCheckpoint(durableCheckpoint);
    if (work.kind === "mutation" && input.mutations?.ensureSemanticStages) {
      await input.mutations.ensureSemanticStages({
        work: { ...work, checkpoint: durableCheckpoint }
      });
    }
    if (work.kind === "mutation" && input.mutations?.inspectSemanticStages) {
      const semantic = await input.mutations.inspectSemanticStages({
        work: { ...work, checkpoint: durableCheckpoint }
      });
      if (semantic.state === "pending") {
        await input.workflow.releaseForContinuation({
          publicId: work.publicId,
          owner,
          nextAttemptAt: addMilliseconds(
            input.clock(),
            input.limits.retryDelayMilliseconds
          )
        });
        return "retried";
      }
      if (semantic.state === "failed") {
        await terminateCandidate(
          input,
          work,
          checkpoint.candidatePublicId,
          "failed",
          semantic.safeCode
        );
        return "terminal";
      }
    }
    if (input.readiness) {
      const readiness = await input.readiness.inspect({
        knowledgeBaseId: work.knowledgeBaseId
      });
      if (readiness.state === "pending") {
        await input.workflow.releaseForContinuation({
          publicId: work.publicId,
          owner,
          nextAttemptAt: addMilliseconds(
            input.clock(),
            input.limits.retryDelayMilliseconds
          )
        });
        return "retried";
      }
    }
    if (checkpoint.phase === "planning") {
      const resolution = await resolvePlanningCandidate(input, work, checkpoint);
      if (resolution.state === "pending") {
        if (work.kind === "publication" && work.attempt >= input.limits.maximumAttempts) {
          await completePlanningSuperseded(input, work, owner, checkpoint, null);
          return "terminal";
        }
        await input.workflow.releaseForContinuation({
          publicId: work.publicId,
          owner,
          nextAttemptAt: addMilliseconds(
            input.clock(),
            input.limits.retryDelayMilliseconds
          )
        });
        return "retried";
      }
      if (resolution.state === "superseded") {
        await completePlanningSuperseded(
          input,
          work,
          owner,
          checkpoint,
          resolution.candidate
        );
        return "terminal";
      }
      const candidate = resolution.candidate;
      const published = await publishWithDeadline(input, work, candidate, heartbeat.signal);
      if ("state" in published) {
        await input.workflow.releaseForContinuation({
          publicId: work.publicId,
          owner,
          nextAttemptAt: addMilliseconds(
            input.clock(),
            input.limits.retryDelayMilliseconds
          )
        });
        return "retried";
      }
      checkpoint = {
        phase: "candidate_ready",
        candidatePublicId: candidate.publicId,
        expectedActiveRootPublicId: candidate.expectedActiveRootPublicId,
        expectedActiveRevision: candidate.expectedActiveRevision,
        searchProjectionPublicId: published.searchProjectionPublicId
      };
      durableCheckpoint = { ...durableCheckpoint, ...checkpoint };
      await input.workflow.saveCheckpoint({
        publicId: work.publicId,
        owner,
        checkpoint: durableCheckpoint
      });
    }
    return await activateCandidate(input, work, owner, checkpoint);
  } catch (error) {
    const code = safeFailureCode(error);
    input.onFailure?.({
      operationPublicId: work.publicId,
      knowledgeBaseId: work.knowledgeBaseId,
      attempt: work.attempt,
      code,
      error
    });
    if (hasCode(error, "lease_lost")) return "terminal";
    return checkpoint
      ? retryOrTerminate(input, work, owner, checkpoint, code)
      : retryOrTerminateBeforeCandidate(input, work, owner, code);
  } finally {
    await heartbeat.stop();
  }
}

function startLeaseHeartbeat(
  input: PublicationWorkerInput,
  work: StorageVnextLiveWork,
  owner: string,
  roleSignal: AbortSignal | undefined
): { signal: AbortSignal; stop(): Promise<void> } {
  const controller = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const abortFromRole = () => {
    controller.abort(
      roleSignal?.reason ?? new DOMException("Publication role shutting down", "AbortError")
    );
    wake?.();
  };
  roleSignal?.addEventListener("abort", abortFromRole, { once: true });
  if (roleSignal?.aborted) abortFromRole();

  const running = (async () => {
    while (!stopped && !controller.signal.aborted) {
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, input.limits.heartbeatIntervalMilliseconds);
        timer.unref?.();
      });
      timer = undefined;
      wake = undefined;
      if (stopped || controller.signal.aborted) break;
      try {
        const renewed = await input.workflow.renew({
          publicId: work.publicId,
          owner,
          leaseExpiresAt: addMilliseconds(input.clock(), input.limits.leaseTtlMilliseconds)
        });
        if (!renewed) throw workerError("lease_lost");
      } catch (error) {
        controller.abort(error);
      }
    }
  })();

  return {
    signal: controller.signal,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      wake?.();
      roleSignal?.removeEventListener("abort", abortFromRole);
      await running;
    }
  };
}

async function retryOrTerminateBeforeCandidate(
  input: PublicationWorkerInput,
  work: StorageVnextLiveWork,
  owner: string,
  reasonCode: string
): Promise<WorkOutcome> {
  if (work.attempt < input.limits.maximumAttempts) {
    return await releaseForRetry(input, work, owner, reasonCode)
      ? "retried"
      : "terminal";
  }
  if (work.kind !== "mutation" || !input.mutations?.terminate) {
    throw workerError("candidate_unavailable");
  }
  const completedAt = input.clock();
  const outcome = reasonCode === "PUBLICATION_TIMEOUT" ? "timed_out" : "failed";
  await input.mutations.terminate({
    work,
    outcome,
    resultCode: reasonCode,
    completedAt,
    resultExpiresAt: addMilliseconds(
      completedAt,
      input.limits.resultRetentionMilliseconds
    )
  });
  return "terminal";
}

async function publishWithDeadline(
  input: PublicationWorkerInput,
  work: StorageVnextLiveWork,
  candidate: StorageVnextCandidateDelta,
  roleSignal: AbortSignal | undefined
): Promise<
  | { searchProjectionPublicId: string }
  | { state: "pending" }
> {
  const controller = new AbortController();
  const abortFromRole = () => controller.abort(
    roleSignal?.reason ?? new DOMException("Publication role shutting down", "AbortError")
  );
  roleSignal?.addEventListener("abort", abortFromRole, { once: true });
  if (roleSignal?.aborted) abortFromRole();
  const deadline = setTimeout(() => {
    const error = new Error("Storage vNext publication attempt timed out");
    error.name = "TimeoutError";
    controller.abort(error);
  }, input.limits.attemptDeadlineMilliseconds);
  deadline.unref?.();
  try {
    const result = await input.processor.publish({
      knowledgeBaseId: work.knowledgeBaseId,
      candidatePublicId: candidate.publicId,
      operationPublicId: work.publicId,
      signal: controller.signal,
      ...(input.readiness ? {
        beforeValidate: () => input.readiness!.inspect({
          knowledgeBaseId: work.knowledgeBaseId
        })
      } : {})
    });
    if ("state" in result) return result;
    assertPublicId(result.searchProjectionPublicId, "invalid_processor_result");
    return result;
  } finally {
    clearTimeout(deadline);
    roleSignal?.removeEventListener("abort", abortFromRole);
  }
}

async function activateCandidate(
  input: PublicationWorkerInput,
  work: StorageVnextLiveWork,
  owner: string,
  checkpoint: PublicationCheckpoint
): Promise<WorkOutcome> {
  const expectedActiveRevision = checkpoint.expectedActiveRevision;
  const searchProjectionPublicId = checkpoint.searchProjectionPublicId;
  if (
    checkpoint.phase !== "candidate_ready"
    || !Number.isSafeInteger(expectedActiveRevision)
    || expectedActiveRevision! < 0
    || typeof searchProjectionPublicId !== "string"
  ) throw workerError("invalid_checkpoint");
  const activatedAt = input.clock();
  assertTimestamp(activatedAt, "invalid_clock");
  const activation = await input.releases.activateCandidate({
    knowledgeBaseId: work.knowledgeBaseId,
    candidatePublicId: checkpoint.candidatePublicId,
    expectedActiveRootPublicId: checkpoint.expectedActiveRootPublicId ?? null,
    expectedActiveRevision: expectedActiveRevision!,
    searchProjectionPublicId,
    rollbackExpiresAt: checkpoint.expectedActiveRootPublicId
      ? addMilliseconds(activatedAt, input.limits.rollbackRetentionMilliseconds)
      : null,
    eventPublicId: createEventPublicId(work.publicId, "activated"),
    eventExpiresAt: addMilliseconds(activatedAt, input.limits.resultRetentionMilliseconds),
    activatedAt
  });
  if (activation.outcome === "activated") {
    if (work.kind !== "mutation") {
      await input.workflow.complete({
        publicId: work.publicId,
        owner,
        result: result(input, work, {
          state: "completed",
          resultCode: "PUBLICATION_COMPLETED",
          correlationPublicId: activation.snapshot.releaseRootPublicId,
          summary: {
            candidatePublicId: checkpoint.candidatePublicId,
            releaseRootPublicId: activation.snapshot.releaseRootPublicId,
            searchProjectionPublicId
          }
        })
      });
    }
    await dispatchWebhookSafely({
      webhooks: input.webhooks,
      event: {
        eventId: `event-generation-activated-${activation.snapshot.releaseRootPublicId}`,
        eventType: "generation.activated",
        payload: {
          knowledgeBaseId: work.knowledgeBaseId,
          generationId: activation.snapshot.releaseRootPublicId
        },
        createdAt: activatedAt
      },
      onError: input.onWebhookError
    });
    return "completed";
  }
  if (activation.outcome === "stale") {
    await terminateCandidate(input, work, checkpoint.candidatePublicId, "superseded", "PUBLICATION_SUPERSEDED");
    if (work.kind === "mutation") return "terminal";
    await input.workflow.complete({
      publicId: work.publicId,
      owner,
      result: result(input, work, {
        state: "superseded",
        resultCode: "PUBLICATION_SUPERSEDED",
        correlationPublicId: activation.activeRootPublicId,
        summary: {
          candidatePublicId: checkpoint.candidatePublicId,
          activeRootPublicId: activation.activeRootPublicId,
          activeRevision: activation.activeRevision
        }
      })
    });
    return "terminal";
  }
  const error = workerError(
    activation.outcome === "rollback_pending"
      ? "rollback_pending"
      : "candidate_not_ready"
  );
  throw error;
}

async function resolvePlanningCandidate(
  input: PublicationWorkerInput,
  work: StorageVnextLiveWork,
  checkpoint: PublicationCheckpoint
): Promise<
  | { state: "ready"; candidate: StorageVnextCandidateDelta }
  | { state: "pending" }
  | { state: "superseded"; candidate: StorageVnextCandidateDelta }
> {
  const candidate = await input.releases.getLiveCandidate(work.knowledgeBaseId);
  if (!candidate) {
    if (work.kind === "publication") return { state: "pending" };
    throw workerError("candidate_unavailable");
  }
  if (candidate.knowledgeBaseId !== work.knowledgeBaseId) {
    throw workerError("candidate_unavailable");
  }
  if (
    candidate.publicId !== checkpoint.candidatePublicId
    || candidate.operationPublicId !== work.publicId
  ) {
    if (work.kind === "publication") return { state: "superseded", candidate };
    throw workerError("candidate_unavailable");
  }
  return { state: "ready", candidate };
}

async function completePlanningSuperseded(
  input: PublicationWorkerInput,
  work: StorageVnextLiveWork,
  owner: string,
  checkpoint: PublicationCheckpoint,
  winner: StorageVnextCandidateDelta | null
): Promise<void> {
  if (work.kind === "mutation") throw workerError("candidate_unavailable");
  await input.workflow.complete({
    publicId: work.publicId,
    owner,
    result: result(input, work, {
      state: "superseded",
      resultCode: "PUBLICATION_SUPERSEDED",
      correlationPublicId: winner?.publicId ?? null,
      summary: {
        candidatePublicId: checkpoint.candidatePublicId,
        activeCandidatePublicId: winner?.publicId ?? null
      }
    })
  });
}

async function retryOrTerminate(
  input: PublicationWorkerInput,
  work: StorageVnextLiveWork,
  owner: string,
  checkpoint: PublicationCheckpoint,
  reasonCode: string
): Promise<WorkOutcome> {
  if (work.attempt < input.limits.maximumAttempts) {
    return await releaseForRetry(input, work, owner, reasonCode)
      ? "retried"
      : "terminal";
  }
  const outcome: StorageVnextCandidateTerminalOutcome = reasonCode === "PUBLICATION_TIMEOUT"
    ? "timed_out"
    : "failed";
  await terminateCandidate(input, work, checkpoint.candidatePublicId, outcome, reasonCode);
  if (work.kind === "mutation") return "terminal";
  await input.workflow.complete({
    publicId: work.publicId,
    owner,
    result: result(input, work, {
      state: outcome,
      resultCode: reasonCode,
      correlationPublicId: checkpoint.candidatePublicId,
      summary: {
        candidatePublicId: checkpoint.candidatePublicId,
        attemptCount: work.attempt
      }
    })
  });
  return "terminal";
}

async function releaseForRetry(
  input: PublicationWorkerInput,
  work: StorageVnextLiveWork,
  owner: string,
  reasonCode: string
): Promise<boolean> {
  try {
    await input.workflow.releaseForRetry({
      publicId: work.publicId,
      owner,
      nextAttemptAt: addMilliseconds(
        input.clock(),
        input.limits.retryDelayMilliseconds
      ),
      reasonCode
    });
    return true;
  } catch (error) {
    if (hasCode(error, "lease_lost")) return false;
    throw error;
  }
}

async function terminateCandidate(
  input: PublicationWorkerInput,
  work: StorageVnextLiveWork,
  candidatePublicId: string,
  outcome: StorageVnextCandidateTerminalOutcome,
  reasonCode: string
): Promise<void> {
  const terminatedAt = input.clock();
  assertTimestamp(terminatedAt, "invalid_clock");
  await input.releases.terminateCandidate({
    knowledgeBaseId: work.knowledgeBaseId,
    candidatePublicId,
    outcome,
    reasonCode,
    safeMessage: null,
    eventPublicId: createEventPublicId(work.publicId, outcome),
    eventExpiresAt: addMilliseconds(terminatedAt, input.limits.resultRetentionMilliseconds),
    terminatedAt
  });
}

function result(
  input: PublicationWorkerInput,
  work: StorageVnextLiveWork,
  value: Pick<
    StorageVnextBoundedResult,
    "state" | "resultCode" | "correlationPublicId" | "summary"
  >
): StorageVnextBoundedResult {
  const completedAt = input.clock();
  assertTimestamp(completedAt, "invalid_clock");
  return {
    publicId: work.publicId,
    knowledgeBaseId: work.knowledgeBaseId,
    kind: "publication",
    ...value,
    safeMessage: null,
    completedAt,
    expiresAt: addMilliseconds(completedAt, input.limits.resultRetentionMilliseconds)
  };
}

function parseCheckpoint(metadata: StorageVnextBoundedMetadata): PublicationCheckpoint {
  const phase = metadata.phase;
  const candidatePublicId = metadata.candidatePublicId;
  if (
    (phase !== "planning" && phase !== "candidate_ready")
    || typeof candidatePublicId !== "string"
  ) throw workerError("invalid_checkpoint");
  assertPublicId(candidatePublicId, "invalid_checkpoint");
  if (phase === "planning") return { phase, candidatePublicId };
  const expectedActiveRootPublicId = metadata.expectedActiveRootPublicId;
  const expectedActiveRevision = metadata.expectedActiveRevision;
  const searchProjectionPublicId = metadata.searchProjectionPublicId;
  if (
    (expectedActiveRootPublicId !== null && typeof expectedActiveRootPublicId !== "string")
    || !Number.isSafeInteger(expectedActiveRevision)
    || Number(expectedActiveRevision) < 0
    || typeof searchProjectionPublicId !== "string"
  ) throw workerError("invalid_checkpoint");
  if (expectedActiveRootPublicId) assertPublicId(expectedActiveRootPublicId, "invalid_checkpoint");
  assertPublicId(searchProjectionPublicId, "invalid_checkpoint");
  return {
    phase,
    candidatePublicId,
    expectedActiveRootPublicId,
    expectedActiveRevision: Number(expectedActiveRevision),
    searchProjectionPublicId
  };
}

function isPublicationCheckpoint(metadata: StorageVnextBoundedMetadata): boolean {
  return (metadata.phase === "planning" || metadata.phase === "candidate_ready")
    && typeof metadata.candidatePublicId === "string";
}

function safeFailureCode(error: unknown): string {
  if (error instanceof Error) {
    if (["AbortError", "TimeoutError"].includes(error.name)) return "PUBLICATION_TIMEOUT";
    if ("code" in error) {
      const code = String(error.code);
      if (code === "rollback_pending") return "PUBLICATION_ROLLBACK_PENDING";
      if (code === "candidate_not_ready") return "PUBLICATION_CANDIDATE_NOT_READY";
      if (code === "RESOURCE_PATH_CONFLICT") return code;
    }
  }
  return "PUBLICATION_FAILED";
}

function createEventPublicId(operationPublicId: string, outcome: string): string {
  const digest = createHash("sha256")
    .update("storage-vnext-publication-release-event-v1\0")
    .update(operationPublicId)
    .update("\0")
    .update(outcome)
    .digest("hex");
  return `release-event-${digest}`;
}

function assertClaimedWork(work: StorageVnextLiveWork, owner: string): void {
  if (
    !["publication", "mutation"].includes(work.kind)
    || work.state !== "running"
    || work.leaseOwner !== owner
    || !work.leaseExpiresAt
  ) throw workerError("invalid_claim");
}

function assertClaim(
  request: { owner: string; limit: number; leaseExpiresAt: string },
  maximumConcurrency: number
): void {
  if (
    request.owner.length === 0
    || Buffer.byteLength(request.owner) > 255
    || !Number.isSafeInteger(request.limit)
    || request.limit < 1
    || request.limit > maximumConcurrency
  ) throw workerError("invalid_claim");
  assertTimestamp(request.leaseExpiresAt, "invalid_claim");
}

function validateLimits(limits: PublicationLimits): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw workerError("invalid_limits");
  }
  if (limits.heartbeatIntervalMilliseconds >= limits.leaseTtlMilliseconds) {
    throw workerError("invalid_limits");
  }
}

function assertPublicId(value: string, code: string): void {
  if (!value || Buffer.byteLength(value) > 255) throw workerError(code);
}

function assertTimestamp(value: string, code: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw workerError(code);
  }
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function workerError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Storage vNext publication worker error: ${code}`), { code });
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && String(error.code) === code;
}
