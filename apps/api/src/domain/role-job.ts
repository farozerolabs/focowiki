import type { WorkerRole } from "./generation.js";
import type { SerializableJson } from "./serializable-json.js";

export type RoleJobKind =
  | "source_processing"
  | "generation_assembly"
  | "generation_publication"
  | "resource_operation"
  | "hard_delete"
  | "projection_audit"
  | "garbage_collection";

export type RoleJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "dead_letter"
  | "cancelled";

export type RoleJobRecord = {
  id: string;
  role: WorkerRole;
  kind: RoleJobKind;
  knowledgeBaseId: string;
  sourceFileId: string | null;
  sourceRevisionId: string | null;
  generationId: string | null;
  payload: SerializableJson;
  settingsSnapshot: SerializableJson;
  status: RoleJobStatus;
  runAfter: string;
  attemptCount: number;
  maxAttempts: number;
  lockedBy: string | null;
  lockedAt: string | null;
  heartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export class RoleJobFailure extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  public constructor(input: {
    code: string;
    message: string;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "RoleJobFailure";
    this.code = input.code;
    this.retryable = input.retryable ?? true;
  }
}

export class RoleJobReschedule extends Error {
  public constructor(public readonly runAfter: string) {
    super("Role job requires continuation");
    this.name = "RoleJobReschedule";
  }
}
