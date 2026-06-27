import type {
  AdminRepositories,
  SourceFileTaskDeletionRepositoryResult,
  SourceFileTaskDeletionSkippedReason
} from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { StorageAdapter } from "../storage/s3.js";
import { invalidateKnowledgeBaseCaches } from "./cache-invalidation.js";

export type SourceFileTaskDeletionStatus = "deleted" | "hidden" | "skipped";

export type SourceFileTaskDeletionResult = {
  sourceFileId: string;
  status: SourceFileTaskDeletionStatus;
  reason?: SourceFileTaskDeletionSkippedReason;
  generatedFileId?: string;
  generatedFilePath?: string;
};

export type SourceFileTaskDeletionSummary = {
  deleted: number;
  hidden: number;
  skipped: number;
};

export type SourceFileTaskDeletionResponse = {
  results: SourceFileTaskDeletionResult[];
  summary: SourceFileTaskDeletionSummary;
};

export type SourceFileTaskDeletionService = {
  deleteTasks: (input: {
    knowledgeBaseId: string;
    sourceFileIds: string[];
    deletedAt: string;
    cursorTtlSeconds: number;
  }) => Promise<SourceFileTaskDeletionResponse | null>;
};

export function createSourceFileTaskDeletionService(
  repositories: AdminRepositories,
  storage: StorageAdapter,
  redis: RedisCoordinator
): SourceFileTaskDeletionService | null {
  const deleteSourceFileTasks = repositories.files?.deleteSourceFileTasks;

  if (!deleteSourceFileTasks) {
    return null;
  }

  return {
    async deleteTasks(input) {
      const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(input.knowledgeBaseId);

      if (!knowledgeBase) {
        return null;
      }

      const repositoryResults = await deleteSourceFileTasks({
        knowledgeBaseId: knowledgeBase.id,
        sourceFileIds: input.sourceFileIds,
        deletedAt: input.deletedAt
      });
      const deletedResults = repositoryResults.filter(isDeletedRepositoryResult);
      const hiddenResults = repositoryResults.filter((result) => result.outcome === "hidden");
      const affectedSourceFileIds = [...deletedResults, ...hiddenResults].map(
        (result) => result.sourceFileId
      );

      await cleanupDeletedSourceFiles({
        repositories,
        storage,
        knowledgeBaseId: knowledgeBase.id,
        deletedResults
      });

      if (affectedSourceFileIds.length > 0) {
        await invalidateKnowledgeBaseCaches({
          redis,
          knowledgeBaseId: knowledgeBase.id,
          releaseId: knowledgeBase.activeReleaseId,
          sourceFileIds: affectedSourceFileIds,
          ttlSeconds: input.cursorTtlSeconds
        });
      }

      return {
        results: repositoryResults.map(toSourceFileTaskDeletionResult),
        summary: summarizeSourceFileTaskDeletion(repositoryResults)
      };
    }
  };
}

async function cleanupDeletedSourceFiles(input: {
  repositories: AdminRepositories;
  storage: StorageAdapter;
  knowledgeBaseId: string;
  deletedResults: Array<Extract<SourceFileTaskDeletionRepositoryResult, { outcome: "deleted" }>>;
}): Promise<void> {
  for (const result of input.deletedResults) {
    await input.repositories.graph?.deleteGraphForSourceFile({
      knowledgeBaseId: input.knowledgeBaseId,
      sourceFileId: result.sourceFileId
    });
    await input.storage.deleteObject?.(result.objectKey).catch(() => undefined);
  }
}

function toSourceFileTaskDeletionResult(
  result: SourceFileTaskDeletionRepositoryResult
): SourceFileTaskDeletionResult {
  if (result.outcome === "skipped") {
    return {
      sourceFileId: result.sourceFileId,
      status: "skipped",
      reason: result.reason
    };
  }

  return {
    sourceFileId: result.sourceFileId,
    status: result.outcome,
    ...readGeneratedOutputFields(result)
  };
}

function summarizeSourceFileTaskDeletion(
  results: SourceFileTaskDeletionRepositoryResult[]
): SourceFileTaskDeletionSummary {
  return {
    deleted: results.filter((result) => result.outcome === "deleted").length,
    hidden: results.filter((result) => result.outcome === "hidden").length,
    skipped: results.filter((result) => result.outcome === "skipped").length
  };
}

function isDeletedRepositoryResult(
  result: SourceFileTaskDeletionRepositoryResult
): result is Extract<SourceFileTaskDeletionRepositoryResult, { outcome: "deleted" }> {
  return result.outcome === "deleted";
}

function readGeneratedOutputFields(
  result: SourceFileTaskDeletionRepositoryResult
): Pick<SourceFileTaskDeletionResult, "generatedFileId" | "generatedFilePath"> {
  if (result.outcome !== "hidden") {
    return {};
  }

  return {
    ...(result.generatedFileId ? { generatedFileId: result.generatedFileId } : {}),
    ...(result.generatedFilePath ? { generatedFilePath: result.generatedFilePath } : {})
  };
}
