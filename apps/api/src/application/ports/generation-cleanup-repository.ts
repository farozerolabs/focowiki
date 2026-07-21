export type CleanupTarget =
  | {
      kind: "source_file";
      knowledgeBaseId: string;
      sourceFileId: string;
      deletionIntentId: string;
    }
  | {
      kind: "source_directory";
      knowledgeBaseId: string;
      sourceDirectoryId: string;
      deletionIntentId: string;
    }
  | {
      kind: "knowledge_base";
      knowledgeBaseId: string;
      deletionIntentId: string;
    };

export type CleanupCheckpoint = {
  phase: "object_discovery" | "object_deletion" | "database_cleanup";
  discoveryCursor: string | null;
  discoveryCompleted: boolean;
};

export type GenerationCleanupRepository = {
  supersedeTargetWork: (input: {
    jobId: string;
    target: CleanupTarget;
    supersededAt: string;
  }) => Promise<void>;
  getCheckpoint: (jobId: string) => Promise<CleanupCheckpoint | null>;
  saveCheckpoint: (input: {
    jobId: string;
    target: CleanupTarget;
    checkpoint: CleanupCheckpoint;
    updatedAt: string;
  }) => Promise<void>;
  isReady: (input: {
    jobId: string;
    target: CleanupTarget;
  }) => Promise<boolean>;
  discoverSourceObjectKeys: (input: {
    target: Exclude<CleanupTarget, { kind: "knowledge_base" }>;
    cursor: string | null;
    limit: number;
  }) => Promise<{ objectKeys: string[]; nextCursor: string | null }>;
  trackObjectKeys: (input: {
    jobId: string;
    knowledgeBaseId: string;
    objectKeys: string[];
    createdAt: string;
  }) => Promise<void>;
  listPendingObjectKeys: (input: {
    jobId: string;
    limit: number;
  }) => Promise<string[]>;
  markObjectKeysDeleted: (input: {
    jobId: string;
    objectKeys: string[];
    deletedAt: string;
  }) => Promise<void>;
  purgeTargetBatch: (input: {
    jobId: string;
    target: CleanupTarget;
    limit: number;
    purgedAt: string;
  }) => Promise<{ deletedRows: number; hasMore: boolean }>;
  complete: (input: {
    jobId: string;
    target: CleanupTarget;
    completedAt: string;
  }) => Promise<void>;
  claimUnreferencedImmutableObjects: (input: {
    jobId: string;
    cursor: string | null;
    olderThan: string;
    limit: number;
  }) => Promise<{
    objects: Array<{ checksumSha256: string; formatVersion: number; objectKey: string }>;
    nextCursor: string | null;
  }>;
  listClaimedImmutableObjects: (input: {
    jobId: string;
    limit: number;
  }) => Promise<Array<{ checksumSha256: string; formatVersion: number; objectKey: string }>>;
  completeImmutableObjectDeletions: (input: {
    jobId: string;
    objects: Array<{ checksumSha256: string; formatVersion: number }>;
  }) => Promise<number>;
  deleteExpiredGenerations: (input: {
    olderThan: string;
    limit: number;
  }) => Promise<number>;
};
