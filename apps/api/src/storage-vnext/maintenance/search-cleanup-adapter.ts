import { createHash } from "node:crypto";

type SearchCleanupPort = {
  cleanupOrphanIndexes(input: {
    updatedBefore: string;
    offset: number;
  }): Promise<{ deleted: number; nextOffset: number | null }>;
  cleanupFinishedTasks(input: {
    finishedBefore: string;
    from: number | null;
  }): Promise<{ deleted: number; next: number | null }>;
  compactHighWater(input: {
    compactedBefore: string;
    correlationPublicId: string;
    availableDiskBytes: number;
  }): Promise<unknown>;
};

export function createStorageVnextMaintenanceSearchCleanupAdapter(input: {
  cleanup: SearchCleanupPort;
  now(): string;
  availableDiskBytes(): Promise<number>;
  maximumPages: number;
}) {
  if (!Number.isSafeInteger(input.maximumPages) || input.maximumPages < 1) {
    throw adapterError("invalid_configuration");
  }
  return {
    async cleanupMaintenance(request: {
      knowledgeBaseId: string;
      operationPublicId: string;
      candidatePublicId: string;
      outcome: "completed" | "failed" | "superseded";
      promotedCandidatePublicId: string | null;
      failedCandidatePublicId: string | null;
    }) {
      validateRequest(request);
      const boundary = input.now();
      assertTimestamp(boundary);
      const deletedIndexes = await cleanupOrphanPages(boundary);
      const deletedTasks = await cleanupTaskPages(boundary);
      const availableDiskBytes = await input.availableDiskBytes();
      assertBytes(availableDiskBytes);
      const compaction = await input.cleanup.compactHighWater({
        compactedBefore: boundary,
        correlationPublicId: cleanupCorrelation(request),
        availableDiskBytes
      });
      return { deletedIndexes, deletedTasks, compaction };
    }
  };

  async function cleanupOrphanPages(updatedBefore: string): Promise<number> {
    let offset = 0;
    let deleted = 0;
    for (let page = 0; page < input.maximumPages; page += 1) {
      const result = await input.cleanup.cleanupOrphanIndexes({
        updatedBefore,
        offset
      });
      assertPageResult(result.deleted, result.nextOffset);
      deleted += result.deleted;
      if (result.nextOffset === null) return deleted;
      offset = result.nextOffset;
    }
    throw adapterError("cleanup_page_limit");
  }

  async function cleanupTaskPages(finishedBefore: string): Promise<number> {
    let from: number | null = null;
    let deleted = 0;
    for (let page = 0; page < input.maximumPages; page += 1) {
      const result = await input.cleanup.cleanupFinishedTasks({
        finishedBefore,
        from
      });
      assertPageResult(result.deleted, result.next);
      deleted += result.deleted;
      if (result.next === null) return deleted;
      from = result.next;
    }
    throw adapterError("cleanup_page_limit");
  }
}

function cleanupCorrelation(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  candidatePublicId: string;
}): string {
  const digest = createHash("sha256").update([
    "storage-vnext-maintenance-search-cleanup-v1",
    input.knowledgeBaseId,
    input.operationPublicId,
    input.candidatePublicId
  ].join("\0")).digest("hex");
  return `maintenance-search-cleanup-${digest}`;
}

function validateRequest(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  candidatePublicId: string;
  outcome: string;
  promotedCandidatePublicId: string | null;
  failedCandidatePublicId: string | null;
}): void {
  for (const value of [
    input.knowledgeBaseId,
    input.operationPublicId,
    input.candidatePublicId
  ]) {
    if (!value || Buffer.byteLength(value) > 255) throw adapterError("invalid_input");
  }
  const completed = input.outcome === "completed";
  if (
    !["completed", "failed", "superseded"].includes(input.outcome)
    || (completed && input.promotedCandidatePublicId !== input.candidatePublicId)
    || (completed && input.failedCandidatePublicId !== null)
    || (!completed && input.promotedCandidatePublicId !== null)
    || (!completed && input.failedCandidatePublicId !== input.candidatePublicId)
  ) throw adapterError("invalid_input");
}

function assertPageResult(deleted: number, next: number | null): void {
  assertBytes(deleted);
  if (next !== null) assertBytes(next);
}

function assertBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw adapterError("invalid_input");
}

function assertTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw adapterError("invalid_input");
}

function adapterError(code: string): Error {
  return Object.assign(
    new Error(`Storage vNext maintenance search cleanup adapter error: ${code}`),
    { code }
  );
}
