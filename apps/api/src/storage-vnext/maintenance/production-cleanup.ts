import { createHash } from "node:crypto";
import type { StorageVnextMaintenanceCleanup } from "./ports.js";
import { createStorageVnextMaintenanceCandidatePublicId } from "./identity.js";

type CleanupOutcome = "completed" | "failed" | "superseded";

export function createStorageVnextMaintenanceProductionCleanup(input: {
  releases: {
    terminateCandidate(input: {
      knowledgeBaseId: string;
      candidatePublicId: string;
      outcome: "failed" | "superseded";
      reasonCode: string;
      safeMessage: null;
      eventPublicId: string;
      eventExpiresAt: string;
      terminatedAt: string;
    }): Promise<boolean>;
  };
  searchTerminal: {
    abandonCandidate(input: {
      candidatePublicId: string;
      safeErrorCode: string;
    }): Promise<boolean>;
  };
  searchCleanup: {
    cleanupFailedCandidate(input: {
      failedBefore: string;
      correlationPublicId: string;
      candidatePublicId?: string;
    }): Promise<{
      outcome: "none" | "deleted";
      candidatePublicId: string | null;
    }>;
    cleanupOrphanIndexes(input: {
      updatedBefore: string;
      continuation: string | null;
    }): Promise<{ deleted: number; continuation: string | null }>;
    cleanupFinishedTasks(input: {
      finishedBefore: string;
      continuation: string | null;
    }): Promise<{ deleted: number; continuation: string | null }>;
  };
  clock(): string;
  resultRetentionMilliseconds: number;
  maximumCleanupPages: number;
}): StorageVnextMaintenanceCleanup {
  assertPositiveInteger(input.resultRetentionMilliseconds);
  assertPositiveInteger(input.maximumCleanupPages);
  return {
    async terminate(request) {
      validateRequest(request);
      const terminatedAt = input.clock();
      assertTimestamp(terminatedAt);
      const candidatePublicId = createStorageVnextMaintenanceCandidatePublicId(request);
      const correlationPublicId = cleanupIdentity(
        request.operationPublicId,
        "search"
      );

      if (request.outcome !== "completed") {
        const abandoned = await input.searchTerminal.abandonCandidate({
          candidatePublicId,
          safeErrorCode: request.outcome === "superseded"
            ? "MAINTENANCE_SUPERSEDED"
            : "MAINTENANCE_FAILED"
        });
        if (abandoned) {
          const failedBefore = input.clock();
          assertTimestamp(failedBefore);
          await cleanupFailedCandidate(
            input,
            candidatePublicId,
            failedBefore,
            correlationPublicId
          );
        }
        await input.releases.terminateCandidate({
          knowledgeBaseId: request.knowledgeBaseId,
          candidatePublicId,
          outcome: request.outcome,
          reasonCode: request.outcome === "superseded"
            ? "MAINTENANCE_SUPERSEDED"
            : "MAINTENANCE_FAILED",
          safeMessage: null,
          eventPublicId: cleanupIdentity(request.operationPublicId, request.outcome),
          eventExpiresAt: addMilliseconds(
            terminatedAt,
            input.resultRetentionMilliseconds
          ),
          terminatedAt
        });
      }

      const deletedOrphanIndexes = await cleanupOrphanIndexes(
        input,
        terminatedAt
      );
      const deletedFinishedTasks = await cleanupFinishedTasks(
        input,
        terminatedAt
      );
      return {
        outcome: request.outcome,
        candidatePublicId,
        deletedOrphanIndexes,
        deletedFinishedTasks
      };
    }
  };
}

async function cleanupFailedCandidate(
  input: Parameters<typeof createStorageVnextMaintenanceProductionCleanup>[0],
  candidatePublicId: string,
  failedBefore: string,
  correlationPublicId: string
): Promise<void> {
  const result = await input.searchCleanup.cleanupFailedCandidate({
    failedBefore,
    correlationPublicId,
    candidatePublicId
  });
  if (
    result.outcome === "none"
    || result.candidatePublicId === candidatePublicId
  ) return;
  throw cleanupError("failed_candidate_mismatch");
}

async function cleanupOrphanIndexes(
  input: Parameters<typeof createStorageVnextMaintenanceProductionCleanup>[0],
  updatedBefore: string
): Promise<number> {
  let continuation: string | null = null;
  let deleted = 0;
  for (let page = 0; page < input.maximumCleanupPages; page += 1) {
    const result = await input.searchCleanup.cleanupOrphanIndexes({
      updatedBefore,
      continuation
    });
    validatePage(result.deleted, result.continuation);
    deleted += result.deleted;
    if (result.continuation === null) return deleted;
    continuation = result.continuation;
  }
  throw cleanupError("orphan_page_limit");
}

async function cleanupFinishedTasks(
  input: Parameters<typeof createStorageVnextMaintenanceProductionCleanup>[0],
  finishedBefore: string
): Promise<number> {
  let continuation: string | null = null;
  let deleted = 0;
  for (let page = 0; page < input.maximumCleanupPages; page += 1) {
    const result = await input.searchCleanup.cleanupFinishedTasks({
      finishedBefore,
      continuation
    });
    validatePage(result.deleted, result.continuation);
    deleted += result.deleted;
    if (result.continuation === null) return deleted;
    continuation = result.continuation;
  }
  throw cleanupError("task_page_limit");
}

function cleanupIdentity(operationPublicId: string, kind: string): string {
  const digest = createHash("sha256")
    .update("storage-vnext-maintenance-cleanup-v1")
    .update("\0")
    .update(operationPublicId)
    .update("\0")
    .update(kind)
    .digest("hex");
  return `maintenance-cleanup-${digest}`;
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function validateRequest(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  outcome: CleanupOutcome;
}): void {
  if (
    !input.knowledgeBaseId
    || !input.operationPublicId
    || !["completed", "failed", "superseded"].includes(input.outcome)
  ) throw cleanupError("invalid_input");
}

function validatePage(count: number, continuation: string | null): void {
  if (
    !Number.isSafeInteger(count)
    || count < 0
    || (continuation !== null && !continuation)
  ) throw cleanupError("invalid_page");
}

function assertPositiveInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw cleanupError("invalid_configuration");
  }
}

function assertTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw cleanupError("invalid_clock");
}

function cleanupError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext maintenance production cleanup error: ${code}`),
    { code }
  );
}
