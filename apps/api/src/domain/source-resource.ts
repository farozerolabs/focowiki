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
  processingState: "queued" | "running" | "completed" | "failed";
  currentStage: string;
  processingErrorCode: string | null;
  generatedOutputStatus: "pending" | "visible" | "unavailable";
  generatedPath: string | null;
  deleting: boolean;
  createdAt: string;
};

export type SourceResourceFileFilters = {
  pathQuery: string | null;
  sourceFileIdPrefix: string | null;
  processingState: SourceResourceFileRecord["processingState"] | null;
  currentStage: string | null;
  generatedOutputStatus: SourceResourceFileRecord["generatedOutputStatus"] | null;
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
