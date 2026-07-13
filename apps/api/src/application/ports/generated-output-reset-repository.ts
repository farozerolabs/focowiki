export type GeneratedOutputResetState = "pending" | "running" | "completed" | "failed";

export type GeneratedOutputResetRepository = {
  beginReset: (input: {
    knowledgeBaseId: string;
    startedAt: string;
  }) => Promise<GeneratedOutputResetState | null>;
  listPendingPrefixes: (input: {
    knowledgeBaseId: string;
    limit: number;
  }) => Promise<string[]>;
  markPrefixDeleted: (input: {
    knowledgeBaseId: string;
    prefix: string;
    deletedAt: string;
  }) => Promise<void>;
  completeResetAndEnqueueRebuild: (input: {
    knowledgeBaseId: string;
    completedAt: string;
    publicationJobMaxAttempts: number;
  }) => Promise<void>;
  failReset: (input: {
    knowledgeBaseId: string;
    failedAt: string;
    errorCode: string;
    errorMessage: string;
  }) => Promise<void>;
  isResetPending: (input: { knowledgeBaseId: string }) => Promise<boolean>;
};
