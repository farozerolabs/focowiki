export type SourceDirectoryRecord = {
  id: string;
  knowledgeBaseId: string;
  parentDirectoryId: string | null;
  name: string;
  relativePath: string;
  depth: number;
  resourceRevision: number;
  directFileCount: number;
  descendantFileCount: number;
  deleting: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SourceResourceFileRecord = {
  id: string;
  knowledgeBaseId: string;
  directoryId: string | null;
  name: string;
  relativePath: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  resourceRevision: number;
  contentRevision: number;
  activeRevisionId: string;
  processingStatus: "queued" | "running" | "completed" | "failed";
  currentStage: SourceFileFailureStage;
  terminalFailure: SourceFileTerminalFailure | null;
  generatedOutputStatus: "pending" | "visible" | "unavailable";
  generatedPath: string | null;
  modelInvocationStatus?: "running" | "completed" | "failed" | "skipped" | null;
  modelInvocationModelName?: string | null;
  modelInvocationStartedAt?: string | null;
  modelInvocationEndedAt?: string | null;
  modelInvocationWarningCount?: number | null;
  modelInvocationErrorCode?: string | null;
  deleting: boolean;
  createdAt: string;
  updatedAt?: string;
};

export type SourceResourceFileFilters = {
  pathQuery: string | null;
  sourceFileIdPrefix: string | null;
  state: SourceFileLifecycleState | null;
  currentStage: string | null;
  generatedOutputStatus: SourceResourceFileRecord["generatedOutputStatus"] | null;
  modelInvocationStatus?: "running" | "completed" | "failed" | "skipped" | "not_recorded" | null;
  startedFrom?: string | null;
  startedTo?: string | null;
  endedFrom?: string | null;
  endedTo?: string | null;
  errorState?: "with_error" | "without_error" | null;
  errorCodeQuery?: string | null;
  actionState?: "openable" | "retryable" | "none" | null;
};

export type ResourceOperationKind =
  | "source_file_replace"
  | "source_file_move"
  | "source_directory_move"
  | "source_file_delete"
  | "source_directory_delete"
  | "knowledge_base_delete";

export type ResourceOperationState =
  | "accepted"
  | "validating"
  | "processing"
  | "publishing"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded";

export type ResourceOperationRecord = {
  id: string;
  knowledgeBaseId: string;
  kind: ResourceOperationKind;
  state: ResourceOperationState;
  expectedResourceRevision: number | null;
  candidateCatalogGeneration: number;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  targetKind?: "source_file" | "source_directory" | "knowledge_base" | null;
  targetId?: string | null;
  candidateRelativePath?: string | null;
};

export class SourceResourceError extends Error {
  public constructor(
    public readonly code:
      | "RESOURCE_NOT_FOUND"
      | "RESOURCE_REVISION_CONFLICT"
      | "RESOURCE_PATH_CONFLICT"
      | "RESOURCE_DELETING"
      | "RESOURCE_BUSY"
      | "IDEMPOTENCY_CONFLICT"
      | "INVALID_RESOURCE_MUTATION"
  ) {
    super(code);
    this.name = "SourceResourceError";
  }
}
import type {
  SourceFileFailureStage,
  SourceFileLifecycleState,
  SourceFileTerminalFailure
} from "./source-file-lifecycle.js";
