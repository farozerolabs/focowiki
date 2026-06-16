import type {
  AdminRepositories,
  SourceFileProcessingStage,
  SourceFileProcessingStatus
} from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import { invalidateKnowledgeBaseCaches } from "./cache-invalidation.js";

export type UploadProgressTracker = {
  invalidate: () => Promise<void>;
  markFile: (input: UploadProgressUpdate & { sourceFileId: string }) => Promise<void>;
  markFiles: (input: UploadProgressUpdate & { sourceFileIds: string[] }) => Promise<void>;
};

type UploadProgressUpdate = {
  status: SourceFileProcessingStatus;
  stage: SourceFileProcessingStage;
  startedAt?: string | null;
  endedAt?: string | null;
  errorCode?: string | null;
};

export function createUploadProgressTracker(input: {
  repositories: AdminRepositories;
  redis: RedisCoordinator;
  knowledgeBaseId: string;
  taskId: string;
  ttlSeconds: number;
}): UploadProgressTracker {
  const updateSourceFileProcessingState =
    input.repositories.files?.updateSourceFileProcessingState;

  const invalidate = () =>
    invalidateKnowledgeBaseCaches({
      redis: input.redis,
      knowledgeBaseId: input.knowledgeBaseId,
      releaseId: null,
      taskId: input.taskId,
      ttlSeconds: input.ttlSeconds
    });
  const markFiles = async (update: UploadProgressUpdate & { sourceFileIds: string[] }) => {
    if (update.sourceFileIds.length === 0) {
      return;
    }

    await updateSourceFileProcessingState?.({
      knowledgeBaseId: input.knowledgeBaseId,
      taskId: input.taskId,
      sourceFileIds: update.sourceFileIds,
      status: update.status,
      stage: update.stage,
      startedAt: update.startedAt ?? null,
      endedAt: update.endedAt ?? null,
      errorCode: update.errorCode ?? null
    });
    await invalidate();
  };

  return {
    invalidate,
    async markFile(update) {
      await markFiles({
        ...update,
        sourceFileIds: [update.sourceFileId]
      });
    },
    markFiles
  };
}

export function createProgressClock(startIso: string): () => string {
  let lastMs = Date.parse(startIso);

  return () => {
    const nowMs = Date.now();
    lastMs = Number.isFinite(lastMs) ? Math.max(lastMs + 1, nowMs) : nowMs;
    return new Date(lastMs).toISOString();
  };
}
