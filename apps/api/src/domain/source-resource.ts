import type { ModelProviderObservation } from "@focowiki/okf";

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
  retryCount?: number;
  processingStatus: SourceFileLifecycleState;
  requiredWorkCount: number;
  completedWorkCount: number;
  activeWorkKinds: SourceFileWorkKind[];
  blockingWorkKind: SourceFileWorkKind | null;
  retryingWorkKind: SourceFileWorkKind | null;
  terminalFailure: SourceFileTerminalFailure | null;
  generatedOutputStatus: SourceFileGeneratedOutputStatus;
  generatedPath: string | null;
  modelInvocationStatus?: "not_required" | "running" | "completed" | "failed" | null;
  modelInvocationModelName?: string | null;
  modelInvocationStartedAt?: string | null;
  modelInvocationEndedAt?: string | null;
  modelInvocationWarningCount?: number | null;
  modelInvocationErrorCode?: string | null;
  modelLayerExecutions?: Array<{
    layer: "first_layer" | "candidate_delta" | "graphrag";
    status: "running" | "completed" | "failed";
    modelName: string;
    selected: boolean | null;
    reused: boolean;
    providerRequestCount: number;
    waitTimeMs: number;
    serviceTimeMs: number;
    providerObservations: readonly ModelProviderObservation[];
    warningCount: number;
    errorCode: string | null;
    startedAt: string;
    endedAt: string | null;
  }>;
  processingStartedAt: string | null;
  processingEndedAt: string | null;
  deleting: boolean;
  createdAt: string;
  updatedAt?: string;
};

export type SourceResourceFileFilters = {
  pathQuery: string | null;
  sourceFileIdPrefix: string | null;
  state: SourceFileLifecycleState | null;
  blockingWorkKind: SourceFileWorkKind | null;
  currentStage?: SourceFileWorkKind | SourceFileLifecycleState | null;
  generatedOutputStatus: SourceResourceFileRecord["generatedOutputStatus"] | null;
  modelInvocationStatus?:
    "not_required" | "running" | "completed" | "failed" | "not_recorded" | null;
  startedFrom?: string | null;
  startedTo?: string | null;
  endedFrom?: string | null;
  endedTo?: string | null;
  errorState?: "with_error" | "without_error" | null;
  errorCodeQuery?: string | null;
  actionState?:
    | "openable"
    | "retryable"
    | "correctable"
    | "details_only"
    | "none"
    | null;
};

export type ResourceOperationKind =
  | "upload"
  | "knowledge_base_metadata"
  | "source_file_metadata"
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
      | "RESOURCE_CONTENT_UNCHANGED"
      | "RESOURCE_CONTENT_TOO_LARGE"
      | "IDEMPOTENCY_CONFLICT"
      | "INVALID_PAGINATION"
      | "INVALID_RESOURCE_MUTATION"
  ) {
    super(code);
    this.name = "SourceResourceError";
  }
}
import type {
  SourceFileGeneratedOutputStatus,
  SourceFileLifecycleState,
  SourceFileWorkKind,
  SourceFileTerminalFailure
} from "./source-file-lifecycle.js";
