import type { SerializableJson } from "./source-dispatch-repository.js";

export type PublicationSubtask = {
  id: string;
  knowledgeBaseId: string;
  generationId: string;
  taskKind:
    | "coordinator"
    | "projection_partition"
    | "directory"
    | "object"
    | "validation"
    | "activation";
  projectionKind: string;
  physicalPartition: string;
  settingsSnapshot: SerializableJson;
  attemptCount: number;
  maxAttempts: number;
  processedCount: number;
  totalCount: number;
  leaseOwner: string | null;
  leaseToken: string | null;
};

export type PublicationSubtaskRepository = {
  ensureGenerationTasks: (input: {
    knowledgeBaseId: string;
    generationId: string;
    settingsSnapshot: SerializableJson;
    maxAttempts: number;
    createdAt: string;
  }) => Promise<{ taskCount: number }>;
  claim: (input: {
    workerId: string;
    limit: number;
    now: string;
    staleBefore: string;
  }) => Promise<PublicationSubtask[]>;
  heartbeat: (input: {
    taskIds: string[];
    workerId: string;
    leaseTokenByTaskId: Record<string, string>;
    heartbeatAt: string;
    leaseExpiresAt: string;
  }) => Promise<number>;
  complete: (input: {
    taskId: string;
    workerId: string;
    processedCount: number;
    completedAt: string;
  }) => Promise<boolean>;
  reschedule: (input: {
    taskId: string;
    workerId: string;
    processedCount: number;
    runAfter: string;
    rescheduledAt: string;
    preserveAttempt: boolean;
  }) => Promise<boolean>;
  fail: (input: {
    taskId: string;
    workerId: string;
    processedCount: number;
    code: string;
    message: string;
    failedAt: string;
    terminal: boolean;
  }) => Promise<{ terminal: boolean }>;
  getGenerationStatus: (input: {
    knowledgeBaseId: string;
    generationId: string;
  }) => Promise<{ pending: number; running: number; failed: number; remaining: number }>;
};
