import type {
  StorageVnextCandidateObjectCleanupActionRepository
} from "../cleanup/postgres-candidate-object-actions.js";

export function createStorageVnextMaintenanceCandidateObjectCleanup(input: {
  actions: StorageVnextCandidateObjectCleanupActionRepository;
  objects: {
    deleteZeroOwner(objectId: string): Promise<{
      deletedVersions: number;
      deletedMarkers: number;
      abortedMultipartUploads: number;
    }>;
  };
  purgeDeletedRegistrations(input: { limit: number }): Promise<number>;
  pageSize: number;
}) {
  const pageSize = validatePageSize(input.pageSize);
  return {
    async runPage(request: {
      knowledgeBaseId: string;
      operationPublicId: string;
      signal: AbortSignal;
    }) {
      validateRequest(request);
      const actions = await input.actions.listPage({
        knowledgeBaseId: request.knowledgeBaseId,
        operationPublicId: request.operationPublicId,
        limit: pageSize
      });
      let deleted = 0;
      let skippedOwned = 0;
      let skippedMissing = 0;
      for (const action of actions) {
        throwIfAborted(request.signal);
        try {
          await input.objects.deleteZeroOwner(action.objectId);
          deleted += 1;
        } catch (error) {
          if (hasCode(error, "owners_present")) skippedOwned += 1;
          else if (hasCode(error, "object_not_found")) skippedMissing += 1;
          else throw error;
        }
        const completed = await input.actions.complete({
          actionPublicId: action.actionPublicId,
          knowledgeBaseId: request.knowledgeBaseId,
          operationPublicId: request.operationPublicId
        });
        if (!completed) throw cleanupError("action_conflict");
      }
      const purgedRegistrations = await input.purgeDeletedRegistrations({
        limit: pageSize
      });
      const progress = actions.length === pageSize;
      return {
        outcome: progress ? "progress" as const : "phase_completed" as const,
        cursor: progress
          ? `candidate-object-cleanup:${request.operationPublicId}`
          : null,
        completedDelta: actions.length,
        expectedCount: actions.length,
        processedBytesDelta: 0,
        batchOrdinalDelta: 1,
        deleted,
        skippedOwned,
        skippedMissing,
        purgedRegistrations
      };
    }
  };
}

function validateRequest(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  signal: AbortSignal;
}): void {
  if (!input.knowledgeBaseId || !input.operationPublicId) {
    throw cleanupError("invalid_input");
  }
}

function validatePageSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw cleanupError("invalid_configuration");
  }
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Storage vNext candidate object cleanup aborted", "AbortError");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function cleanupError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext maintenance candidate object cleanup error: ${code}`),
    { code }
  );
}
