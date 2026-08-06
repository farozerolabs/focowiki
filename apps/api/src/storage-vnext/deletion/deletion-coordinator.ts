import { createStorageVnextDeletionRequestHash } from "./identity.js";
import type {
  StorageVnextDeletionRepository,
  StorageVnextDeletionRequest,
  StorageVnextDeletionVisibilityCache,
  StorageVnextSourceTaskDeletionInput
} from "./ports.js";

const MAX_SOURCE_TASK_DELETION_BATCH = 1_000;
const MAX_ID_BYTES = 255;

export function createStorageVnextDeletionCoordinator(input: {
  repository: StorageVnextDeletionRepository;
  visibilityCache: StorageVnextDeletionVisibilityCache;
}) {
  return {
    async acceptDeletion(request: StorageVnextDeletionRequest) {
      validateDeletionRequest(request);
      const result = await input.repository.acceptDeletion({
        ...request,
        targetKind: request.kind,
        requestHash: createStorageVnextDeletionRequestHash(request)
      });
      await input.visibilityCache.invalidateKnowledgeBase({
        knowledgeBaseId: request.knowledgeBaseId
      });
      return result;
    },

    async deleteSourceTasks(request: StorageVnextSourceTaskDeletionInput) {
      validateSourceTaskDeletion(request);
      const results = await input.repository.deleteSourceTasks({
        ...request,
        sourceFilePublicIds: unique(request.sourceFilePublicIds)
      });
      if (results.some((result) => result.outcome !== "skipped")) {
        await input.visibilityCache.invalidateKnowledgeBase({
          knowledgeBaseId: request.knowledgeBaseId
        });
      }
      return results;
    }
  };
}

function validateDeletionRequest(request: StorageVnextDeletionRequest): void {
  for (const value of [
    request.knowledgeBaseId,
    request.operationPublicId,
    request.targetPublicId,
    request.idempotencyKey,
    request.settingsRevisionPublicId
  ]) assertId(value);
  if (
    request.kind === "knowledge_base"
    && request.targetPublicId !== request.knowledgeBaseId
  ) throw deletionError("invalid_input");
  if (
    !Number.isSafeInteger(request.expectedResourceRevision)
    || request.expectedResourceRevision < 0
  ) throw deletionError("invalid_input");
  assertTimestampOrder(request.requestedAt, request.expiresAt);
}

function validateSourceTaskDeletion(
  request: StorageVnextSourceTaskDeletionInput
): void {
  assertId(request.knowledgeBaseId);
  assertId(request.settingsRevisionPublicId);
  if (
    request.sourceFilePublicIds.length < 1
    || request.sourceFilePublicIds.length > MAX_SOURCE_TASK_DELETION_BATCH
  ) throw deletionError("invalid_input");
  for (const publicId of request.sourceFilePublicIds) assertId(publicId);
  assertTimestampOrder(request.deletedAt, request.resultExpiresAt);
}

function assertId(value: string): void {
  if (!value || Buffer.byteLength(value) > MAX_ID_BYTES) {
    throw deletionError("invalid_input");
  }
}

function assertTimestampOrder(earlier: string, later: string): void {
  const earlierTime = Date.parse(earlier);
  const laterTime = Date.parse(later);
  if (
    !Number.isFinite(earlierTime)
    || !Number.isFinite(laterTime)
    || laterTime <= earlierTime
  ) throw deletionError("invalid_input");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function deletionError(code: string): Error {
  return Object.assign(new Error(`Storage vNext deletion error: ${code}`), { code });
}
