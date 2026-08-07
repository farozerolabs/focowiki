import type {
  StorageVnextBoundedResult,
  StorageVnextLiveWork,
  StorageVnextWorkflowClaimPort,
  StorageVnextWorkflowWritePort
} from "../workflow/ports.js";
import type { StorageVnextTerminalContext } from
  "../cleanup/terminal-convergence.js";
import type { WebhookDispatcher } from "../../webhooks/dispatcher.js";
import { dispatchWebhookSafely } from "../../webhooks/safe-dispatch.js";

type DeletionPurgeAttempt = {
  status: "completed" | "blocked" | "retry";
  receipts: readonly {
    target: { resourceKind: string };
    status: "completed" | "blocked" | "retry";
    reasonCode: string | null;
    checkpoint: Record<string, boolean | number | string | null>;
  }[];
};

type DeletionWorkerWorkflow = Pick<
  StorageVnextWorkflowClaimPort & StorageVnextWorkflowWritePort,
  | "claim"
  | "saveCheckpoint"
  | "releaseForContinuation"
  | "releaseForRetry"
  | "complete"
>;

export function createStorageVnextDeletionWorker(input: {
  workflow: DeletionWorkerWorkflow;
  prepare?: (
    work: StorageVnextLiveWork
  ) => Promise<Record<string, boolean | number | string | null>>;
  purge: { runAttempt(context: StorageVnextTerminalContext): Promise<DeletionPurgeAttempt> };
  owner: string;
  claimLimit: number;
  maximumAttempts: number;
  retryDelayMilliseconds(attempt: number): number;
  clock(): string;
  webhooks?: Pick<WebhookDispatcher, "dispatch">;
  onWebhookError?: (error: unknown) => void;
}) {
  validateConfiguration(input);
  return {
    async runBatch(request: { leaseExpiresAt: string }) {
      assertTimestamp(request.leaseExpiresAt);
      const works = await input.workflow.claim({
        kinds: ["deletion"],
        owner: input.owner,
        limit: input.claimLimit,
        leaseExpiresAt: request.leaseExpiresAt
      });
      const outcomes = [];
      for (const work of works) {
        assertDeletionWork(work, input.owner);
        outcomes.push(await runWork(work));
      }
      return outcomes;
    }
  };

  async function runWork(work: StorageVnextLiveWork) {
    const completedAt = input.clock();
    assertTimestamp(completedAt);
    let preparedWork = work;
    let attempt: DeletionPurgeAttempt;
    try {
      const checkpointPatch = await input.prepare?.(work) ?? {};
      if (Object.keys(checkpointPatch).length > 0) {
        const checkpoint = { ...work.checkpoint, ...checkpointPatch };
        await input.workflow.saveCheckpoint({
          publicId: work.publicId,
          owner: input.owner,
          checkpoint
        });
        preparedWork = { ...work, checkpoint };
      }
      attempt = await input.purge.runAttempt({
        workPublicId: preparedWork.publicId,
        knowledgeBaseId: preparedWork.knowledgeBaseId,
        operationRevision: preparedWork.operationRevision,
        outcome: "deleted",
        resultCode: "DELETION_COMPLETED",
        safeMessage: null,
        checkpoint: preparedWork.checkpoint,
        completedAt
      });
    } catch (error) {
      return retryOrFail({
        work: preparedWork,
        completedAt,
        reasonCode: "DELETION_ATTEMPT_FAILED",
        checkpoint: preparedWork.checkpoint,
        diagnostic: deletionDiagnostic(error)
      });
    }
    if (attempt.status !== "completed") {
      const receipt = [...attempt.receipts].reverse().find((item) =>
        item.status === "retry" || item.status === "blocked");
      const checkpoint = {
        ...preparedWork.checkpoint,
        ...(receipt?.checkpoint ?? {})
      };
      if (
        attempt.status === "retry"
        && receipt?.status === "retry"
        && isContinuationReason(receipt.reasonCode)
      ) {
        return continueProgress({
          work: preparedWork,
          completedAt,
          checkpoint,
          reasonCode: receipt.reasonCode
        });
      }
      return retryOrFail({
        work: preparedWork,
        completedAt,
        reasonCode: receipt?.reasonCode
          ?? (attempt.status === "blocked"
            ? "DELETION_CLEANUP_BLOCKED"
            : "DELETION_ATTEMPT_RETRY"),
        checkpoint
      });
    }
    const targetKind = requiredCheckpointString(preparedWork, "targetKind");
    if (targetKind !== "knowledge_base") {
      await input.workflow.complete({
        publicId: preparedWork.publicId,
        owner: input.owner,
        result: resultFor(preparedWork, {
          state: "completed",
          resultCode: "DELETION_COMPLETED",
          completedAt,
          summary: {
            targetKind,
            targetPublicId: requiredCheckpointString(preparedWork, "targetPublicId"),
            cleanupReceiptCount: attempt.receipts.length
          }
        })
      });
    }
    const targetPublicId = requiredCheckpointString(preparedWork, "targetPublicId");
    await dispatchWebhookSafely({
      webhooks: input.webhooks,
      event: {
        eventId: `event-hard-delete-${preparedWork.publicId}`,
        eventType: targetKind === "knowledge_base"
          ? "knowledge_base.deleted"
          : "file.deleted",
        payload: {
          knowledgeBaseId: preparedWork.knowledgeBaseId,
          ...(targetKind === "source_file"
            ? { sourceFileId: targetPublicId }
            : {}),
          ...(targetKind === "source_directory"
            ? { sourceDirectoryId: targetPublicId }
            : {})
        },
        createdAt: completedAt
      },
      onError: input.onWebhookError
    });
    return {
      workPublicId: preparedWork.publicId,
      outcome: "completed" as const,
      reasonCode: null
    };
  }

  async function continueProgress(request: {
    work: StorageVnextLiveWork;
    completedAt: string;
    checkpoint: Record<string, boolean | number | string | null>;
    reasonCode: string;
  }) {
    await input.workflow.saveCheckpoint({
      publicId: request.work.publicId,
      owner: input.owner,
      checkpoint: request.checkpoint
    });
    const continuationAt = request.reasonCode === "DELETION_SEARCH_PROVIDER_REQUIRED"
      ? nextAttemptAt(
          request.completedAt,
          retryDelay(request.work.attempt)
        )
      : request.completedAt;
    await input.workflow.releaseForContinuation({
      publicId: request.work.publicId,
      owner: input.owner,
      nextAttemptAt: continuationAt
    });
    return {
      workPublicId: request.work.publicId,
      outcome: "retry" as const,
      reasonCode: request.reasonCode
    };
  }

  async function retryOrFail(request: {
    work: StorageVnextLiveWork;
    completedAt: string;
    reasonCode: string;
    checkpoint: Record<string, boolean | number | string | null>;
    diagnostic?: {
      errorClass: string;
      errorCode: string;
      errorConstraint?: string;
    };
  }) {
    assertReasonCode(request.reasonCode);
    await input.workflow.saveCheckpoint({
      publicId: request.work.publicId,
      owner: input.owner,
      checkpoint: request.checkpoint
    });
    if (request.work.attempt >= input.maximumAttempts) {
      await input.workflow.complete({
        publicId: request.work.publicId,
        owner: input.owner,
        result: resultFor(request.work, {
          state: "failed",
          resultCode: "DELETION_RETRY_EXHAUSTED",
          completedAt: request.completedAt,
          summary: {
            targetKind: requiredCheckpointString(request.work, "targetKind"),
            targetPublicId: requiredCheckpointString(request.work, "targetPublicId"),
            lastSafeReasonCode: request.reasonCode,
            attemptCount: request.work.attempt
          }
        })
      });
      return {
        workPublicId: request.work.publicId,
        outcome: "failed" as const,
        reasonCode: "DELETION_RETRY_EXHAUSTED",
        ...request.diagnostic
      };
    }
    const delay = retryDelay(request.work.attempt);
    await input.workflow.releaseForRetry({
      publicId: request.work.publicId,
      owner: input.owner,
      nextAttemptAt: nextAttemptAt(request.completedAt, delay),
      reasonCode: request.reasonCode
    });
    return {
      workPublicId: request.work.publicId,
      outcome: "retry" as const,
      reasonCode: request.reasonCode,
      ...request.diagnostic
    };
  }

  function retryDelay(attempt: number): number {
    const delay = input.retryDelayMilliseconds(attempt);
    if (!Number.isSafeInteger(delay) || delay < 1 || delay > 86_400_000) {
      throw workerError("invalid_configuration");
    }
    return delay;
  }
}

function isContinuationReason(reasonCode: string | null): reasonCode is string {
  return reasonCode === "DELETION_SCOPE_PAGE_REMAINING"
    || reasonCode === "DELETION_SEARCH_TASK_PAGE_REMAINING"
    || reasonCode === "DELETION_SEARCH_PROVIDER_REQUIRED";
}

function nextAttemptAt(completedAt: string, delay: number): string {
  return new Date(new Date(completedAt).getTime() + delay).toISOString();
}

function deletionDiagnostic(error: unknown): {
  errorClass: string;
  errorCode: string;
  errorConstraint?: string;
} {
  const errorClass = error instanceof Error
    && error.name
    && Buffer.byteLength(error.name) <= 128
    ? error.name
    : "Error";
  const code = error instanceof Error && "code" in error
    ? error.code
    : null;
  const errorCode = typeof code === "string"
    && code
    && Buffer.byteLength(code) <= 128
    ? code
    : "unexpected_error";
  const constraint = error instanceof Error && "constraint_name" in error
    ? error.constraint_name
    : null;
  const errorConstraint = typeof constraint === "string"
    && /^[A-Za-z0-9_]{1,128}$/.test(constraint)
    ? constraint
    : null;
  return {
    errorClass,
    errorCode,
    ...(errorConstraint ? { errorConstraint } : {})
  };
}

function resultFor(
  work: StorageVnextLiveWork,
  input: {
    state: "completed" | "failed";
    resultCode: string;
    completedAt: string;
    summary: Record<string, boolean | number | string | null>;
  }
): StorageVnextBoundedResult {
  return {
    publicId: work.publicId,
    knowledgeBaseId: work.knowledgeBaseId,
    kind: "deletion",
    state: input.state,
    resultCode: input.resultCode,
    safeMessage: null,
    summary: input.summary,
    correlationPublicId: null,
    completedAt: input.completedAt,
    expiresAt: work.idempotency.expiresAt
  };
}

function requiredCheckpointString(work: StorageVnextLiveWork, key: string): string {
  const value = work.checkpoint[key];
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 255) {
    throw workerError("invalid_checkpoint");
  }
  return value;
}

function assertDeletionWork(work: StorageVnextLiveWork, owner: string): void {
  if (
    work.kind !== "deletion"
    || work.state !== "running"
    || work.leaseOwner !== owner
    || !work.leaseExpiresAt
  ) throw workerError("invalid_work");
  requiredCheckpointString(work, "targetKind");
  requiredCheckpointString(work, "targetPublicId");
}

function validateConfiguration(input: {
  owner: string;
  claimLimit: number;
  maximumAttempts: number;
}): void {
  if (
    !input.owner
    || Buffer.byteLength(input.owner) > 255
    || !Number.isSafeInteger(input.claimLimit)
    || input.claimLimit < 1
    || input.claimLimit > 100
    || !Number.isSafeInteger(input.maximumAttempts)
    || input.maximumAttempts < 1
    || input.maximumAttempts > 1_000
  ) throw workerError("invalid_configuration");
}

function assertReasonCode(value: string): void {
  if (!value || Buffer.byteLength(value) > 128) throw workerError("invalid_result");
}

function assertTimestamp(value: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw workerError("invalid_input");
  }
}

function workerError(code: string): Error {
  return Object.assign(new Error(`Storage vNext deletion worker error: ${code}`), { code });
}
