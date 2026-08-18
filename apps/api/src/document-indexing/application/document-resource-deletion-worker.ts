export type DocumentDeletionTargetKind =
  "source_file" | "source_directory" | "knowledge_base";

export type DocumentResourceDeletionPhase =
  "deactivate" | "reconcile_projection" | "await_external" | "purge" | "completed";

export type DocumentResourceDeletionCheckpoint = {
  phase: DocumentResourceDeletionPhase;
  cursor: string | null;
  affectedSourceCount: number;
};

export type DocumentResourceDeletionAction = {
  publicId: string;
  operationPublicId: string;
  knowledgeBaseId: string;
  targetKind: DocumentDeletionTargetKind;
  targetPublicId: string;
  attempt: number;
  maximumAttempts: number;
  checkpoint: DocumentResourceDeletionCheckpoint;
};

export function createDocumentResourceDeletionWorker(input: {
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
    }): Promise<readonly DocumentResourceDeletionAction[]>;
    releaseForRetry(request: {
      publicId: string;
      owner: string;
      notBefore: string;
      safeErrorCode: string;
      checkpoint: DocumentResourceDeletionCheckpoint;
    }): Promise<boolean>;
    complete(request: {
      publicId: string;
      owner: string;
      completedAt: string;
    }): Promise<boolean>;
    fail(request: {
      publicId: string;
      owner: string;
      failedAt: string;
      safeErrorCode: string;
      checkpoint: DocumentResourceDeletionCheckpoint;
    }): Promise<boolean>;
  };
  processor: {
    processPage(request: {
      action: DocumentResourceDeletionAction;
      pageSize: number;
      now: string;
      signal: AbortSignal;
    }): Promise<{
      done: boolean;
      processedSourceCount: number;
      checkpoint: DocumentResourceDeletionCheckpoint;
    }>;
  };
  projections: {
    reconcile(request: {
      action: DocumentResourceDeletionAction;
      pageSize: number;
      now: string;
      signal: AbortSignal;
    }): Promise<{
      done: boolean;
      processedSourceCount: number;
      checkpoint: DocumentResourceDeletionCheckpoint;
    }>;
  };
}) {
  return {
    async runBatch(request: {
      owner: string;
      limit: number;
      pageSize: number;
      now: string;
      leaseExpiresAt: string;
      retryDelayMilliseconds: number;
      signal: AbortSignal;
    }) {
      validateBatch(request);
      await input.actions.recoverStale({
        expiredBefore: request.now,
        notBefore: request.now,
        safeErrorCode: "STALE_DOCUMENT_DELETION_LEASE",
        limit: request.limit
      });
      const actions = await input.actions.claim({
        owner: request.owner,
        limit: request.limit,
        leaseExpiresAt: request.leaseExpiresAt
      });
      const result = {
        claimed: actions.length,
        processedSourceCount: 0,
        continued: 0,
        completed: 0,
        failed: 0
      };
      for (const action of actions) {
        throwIfAborted(request.signal);
        validateAction(action);
        try {
          const processor = action.checkpoint.phase === "reconcile_projection"
            ? input.projections.reconcile : input.processor.processPage;
          const page = await processor({
            action, pageSize: request.pageSize,
            now: request.now, signal: request.signal
          });
          validateCheckpoint(page.checkpoint);
          result.processedSourceCount += page.processedSourceCount;
          if (page.done) {
            await requireTransition(input.actions.complete({
              publicId: action.publicId,
              owner: request.owner,
              completedAt: request.now
            }));
            result.completed += 1;
            continue;
          }
          await requireTransition(input.actions.releaseForRetry({
            publicId: action.publicId,
            owner: request.owner,
            notBefore: request.now,
            safeErrorCode: "DOCUMENT_DELETION_PAGE_REMAINING",
            checkpoint: page.checkpoint
          }));
          result.continued += 1;
        } catch (error) {
          const safeErrorCode = errorCode(error);
          if (action.attempt < action.maximumAttempts) {
            await requireTransition(input.actions.releaseForRetry({
              publicId: action.publicId,
              owner: request.owner,
              notBefore: new Date(
                Date.parse(request.now) + request.retryDelayMilliseconds
              ).toISOString(),
              safeErrorCode,
              checkpoint: action.checkpoint
            }));
            result.continued += 1;
            continue;
          }
          await requireTransition(input.actions.fail({
            publicId: action.publicId,
            owner: request.owner,
            failedAt: request.now,
            safeErrorCode,
            checkpoint: action.checkpoint
          }));
          result.failed += 1;
        }
      }
      return result;
    }
  };
}

function validateBatch(input: {
  owner: string;
  limit: number;
  pageSize: number;
  now: string;
  leaseExpiresAt: string;
  retryDelayMilliseconds: number;
  signal: AbortSignal;
}): void {
  if (!input.owner || Buffer.byteLength(input.owner, "utf8") > 255
    || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100
    || !Number.isSafeInteger(input.pageSize)
    || input.pageSize < 1 || input.pageSize > 1_000
    || !Number.isSafeInteger(input.retryDelayMilliseconds)
    || input.retryDelayMilliseconds < 1
    || !Number.isFinite(Date.parse(input.now))
    || !Number.isFinite(Date.parse(input.leaseExpiresAt))
    || Date.parse(input.leaseExpiresAt) <= Date.parse(input.now)) {
    throw workerError("invalid_input");
  }
  throwIfAborted(input.signal);
}

function validateAction(action: DocumentResourceDeletionAction): void {
  if (!action.publicId || !action.operationPublicId || !action.knowledgeBaseId
    || !action.targetPublicId
    || !["source_file", "source_directory", "knowledge_base"]
      .includes(action.targetKind)
    || !Number.isSafeInteger(action.attempt) || action.attempt < 1
    || !Number.isSafeInteger(action.maximumAttempts)
    || action.maximumAttempts < action.attempt) {
    throw workerError("stored_action_invalid");
  }
  validateCheckpoint(action.checkpoint);
}

function validateCheckpoint(checkpoint: DocumentResourceDeletionCheckpoint): void {
  if (!["deactivate", "reconcile_projection", "await_external", "purge", "completed"]
    .includes(checkpoint.phase)
    || checkpoint.cursor !== null && (!checkpoint.cursor
      || Buffer.byteLength(checkpoint.cursor, "utf8") > 255)
    || !Number.isSafeInteger(checkpoint.affectedSourceCount)
    || checkpoint.affectedSourceCount < 0) {
    throw workerError("checkpoint_invalid");
  }
}

async function requireTransition(value: Promise<boolean>): Promise<void> {
  if (!await value) throw workerError("lease_lost");
}

function errorCode(error: unknown): string {
  if (error instanceof Error && "code" in error
    && typeof error.code === "string" && error.code) {
    return error.code.slice(0, 128);
  }
  return "DOCUMENT_RESOURCE_DELETION_FAILED";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? workerError("cancelled");
}

function workerError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document resource deletion worker error: ${code}`), {
    code
  });
}
