import { createSourceResourceService } from "../application/source-resources.js";
import type { AdminRepositories } from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { ApplicationRuntime } from "../application/ports/runtime.js";
import { invalidateKnowledgeBaseCaches } from "./cache-invalidation.js";

export type AdminDeletionService = {
  deleteKnowledgeBase: (input: {
    knowledgeBaseId: string;
    deletedAt: string;
    cursorTtlSeconds: number;
    hardDeleteMaxAttempts?: number | undefined;
  }) => Promise<boolean>;
  deleteSourcePage: (input: {
    knowledgeBaseId: string;
    logicalPath: string;
    deletedAt: string;
    cursorTtlSeconds: number;
    hardDeleteMaxAttempts?: number | undefined;
  }) => Promise<SourcePageDeletionResult>;
};

export type SourcePageDeletionResult =
  | { ok: true; publicationQueued: true }
  | { ok: false; reason: "not_found" | "not_deletable" };

export function createDeletionService(
  repositories: AdminRepositories,
  redis: RedisCoordinator,
  runtime: ApplicationRuntime
): AdminDeletionService | null {
  const sourceResources = repositories.sourceResources;
  const files = repositories.files;
  const workerJobs = repositories.workerJobs;

  if (!sourceResources || !files?.getBundleFile || !workerJobs) {
    return null;
  }

  const resources = createSourceResourceService(sourceResources, runtime);

  return {
    async deleteKnowledgeBase(input) {
      const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(input.knowledgeBaseId);
      if (!knowledgeBase) return false;

      const result = await resources.deleteKnowledgeBase({
        knowledgeBaseId: knowledgeBase.id,
        idempotencyKey: `admin-knowledge-base-delete:${knowledgeBase.id}:${knowledgeBase.resourceRevision ?? 1}`,
        expectedResourceRevision: knowledgeBase.resourceRevision ?? 1
      });

      if (!result.replayed) {
        const hardDeleteJob = await workerJobs.enqueueHardDeleteJob?.({
          knowledgeBaseId: knowledgeBase.id,
          targetKind: "knowledge_base",
          deletionIntentId: result.deletionIntentId,
          reason: "knowledge_base_deleted",
          runAfter: input.deletedAt,
          maxAttempts: input.hardDeleteMaxAttempts ?? 3
        });
        await workerJobs.cancelQueuedKnowledgeBaseJobs?.({
          knowledgeBaseId: knowledgeBase.id,
          excludedJobIds: hardDeleteJob ? [hardDeleteJob.id] : [],
          cancelledAt: input.deletedAt,
          errorCode: "KNOWLEDGE_BASE_DELETED",
          errorMessage: "Knowledge base deletion superseded queued work."
        });
      }

      await invalidateKnowledgeBaseCaches({
        redis,
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        ttlSeconds: input.cursorTtlSeconds
      });
      return true;
    },

    async deleteSourcePage(input) {
      const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(input.knowledgeBaseId);
      if (!knowledgeBase?.activeReleaseId) return { ok: false, reason: "not_found" };

      const file = await files.getBundleFile({
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        logicalPath: input.logicalPath
      });
      if (!file) return { ok: false, reason: "not_found" };
      if (file.fileKind !== "page" || !file.sourceFileId) {
        return { ok: false, reason: "not_deletable" };
      }

      const sourceFile = await resources.getSourceFile({
        knowledgeBaseId: knowledgeBase.id,
        sourceFileId: file.sourceFileId
      });
      if (!sourceFile) return { ok: false, reason: "not_found" };

      const result = await resources.deleteSourceFile({
        knowledgeBaseId: knowledgeBase.id,
        sourceFileId: sourceFile.id,
        idempotencyKey: `admin-source-file-delete:${sourceFile.id}:${sourceFile.resourceRevision}`,
        expectedResourceRevision: sourceFile.resourceRevision
      });

      if (!result.replayed) {
        await workerJobs.cancelQueuedSourceFileJobs?.({
          knowledgeBaseId: knowledgeBase.id,
          sourceFileIds: [sourceFile.id],
          cancelledAt: input.deletedAt,
          errorCode: "SOURCE_FILE_DELETED",
          errorMessage: "Source file deletion superseded queued processing."
        });
        await workerJobs.enqueuePublicationJob({
          knowledgeBaseId: knowledgeBase.id,
          reason: "deletion",
          runAfter: input.deletedAt,
          maxAttempts: input.hardDeleteMaxAttempts ?? 3
        });
        await workerJobs.enqueueHardDeleteJob?.({
          knowledgeBaseId: knowledgeBase.id,
          targetKind: "source_file",
          sourceFileId: sourceFile.id,
          deletionIntentId: result.deletionIntentId,
          reason: "source_file_deleted",
          runAfter: input.deletedAt,
          maxAttempts: input.hardDeleteMaxAttempts ?? 3
        });
      }

      await invalidateKnowledgeBaseCaches({
        redis,
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        sourceFileId: sourceFile.id,
        ttlSeconds: input.cursorTtlSeconds
      });
      return { ok: true, publicationQueued: true };
    }
  };
}
