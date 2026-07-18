import type {
  AdminRepositories
} from "../db/admin-repositories.js";
import type {
  SourceFileTaskDeletionRepository,
  SourceFileTaskDeletionRepositoryResult,
  SourceFileTaskDeletionSkippedReason
} from "../application/ports/source-file-task-deletion-repository.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { SerializableJson } from "../application/ports/source-dispatch-repository.js";
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
    hardDeleteMaxAttempts?: number | undefined;
    publicationSettingsSnapshot: SerializableJson;
  }) => Promise<SourceFileTaskDeletionResponse | null>;
};

export function createSourceFileTaskDeletionService(
  repositories: AdminRepositories,
  taskDeletions: SourceFileTaskDeletionRepository | null,
  redis: RedisCoordinator
): SourceFileTaskDeletionService | null {
  if (!taskDeletions) {
    return null;
  }

  return {
    async deleteTasks(input) {
      const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(input.knowledgeBaseId);

      if (!knowledgeBase) {
        return null;
      }

      const repositoryResults = await taskDeletions.deleteTasks({
        knowledgeBaseId: knowledgeBase.id,
        sourceFileIds: input.sourceFileIds,
        deletedAt: input.deletedAt,
        hardDeleteMaxAttempts: input.hardDeleteMaxAttempts ?? 3,
        publicationSettingsSnapshot: input.publicationSettingsSnapshot
      });
      const affectedSourceFileIds = repositoryResults
        .filter((result) => result.outcome === "deleted" || result.outcome === "hidden")
        .map((result) => result.sourceFileId);

      if (affectedSourceFileIds.length > 0) {
        await invalidateKnowledgeBaseCaches({
          redis,
          knowledgeBaseId: knowledgeBase.id,
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
