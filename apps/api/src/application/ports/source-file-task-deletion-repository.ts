export type SourceFileTaskDeletionSkippedReason =
  | "missing"
  | "wrong_knowledge_base"
  | "already_removed"
  | "running"
  | "job_already_claimed";

export type SourceFileTaskDeletionRepositoryResult =
  | {
      sourceFileId: string;
      outcome: "deleted";
    }
  | {
      sourceFileId: string;
      outcome: "hidden";
      generatedFileId?: string | null;
      generatedFilePath?: string | null;
    }
  | {
      sourceFileId: string;
      outcome: "skipped";
      reason: SourceFileTaskDeletionSkippedReason;
    };

export type SourceFileTaskDeletionRepository = {
  deleteTasks: (input: {
    knowledgeBaseId: string;
    sourceFileIds: string[];
    deletedAt: string;
    hardDeleteMaxAttempts: number;
    publicationSettingsSnapshot: SerializableJson;
  }) => Promise<SourceFileTaskDeletionRepositoryResult[]>;
};
import type { SerializableJson } from "./source-dispatch-repository.js";
