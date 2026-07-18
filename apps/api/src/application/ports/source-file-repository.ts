import type { SourceMetadataDefaults, SourceModelSuggestions } from "@focowiki/okf";
import type {
  SourceFileFailureStage,
  SourceFileLifecycleState,
  SourceFileTerminalFailure
} from "../../domain/source-file-lifecycle.js";

export type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
};

export type SourceFileProcessingStatus = "queued" | "running" | "completed" | "failed";
export type GeneratedOutputStatus = "pending" | "visible" | "unavailable";
export type SourceFileErrorState = "with_error" | "without_error";
export type SourceFileActionState = "openable" | "retryable" | "none";
export type SourceFileProcessingStage = SourceFileFailureStage;
export type ModelInvocationStatus = "running" | "completed" | "failed" | "skipped";
export type SourceFileModelInvocationFilter = ModelInvocationStatus | "not_recorded";

export type SourceFileRecord = {
  id: string;
  knowledgeBaseId: string;
  name: string;
  relativePath: string;
  resourceRevision?: number;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  metadata: SourceMetadataDefaults;
  modelSuggestions?: SourceModelSuggestions | null;
  processingStatus?: SourceFileProcessingStatus;
  processingStage?: SourceFileProcessingStage;
  processingStartedAt?: string | null;
  processingEndedAt?: string | null;
  generatedOutputStatus?: GeneratedOutputStatus;
  terminalFailure?: SourceFileTerminalFailure | null;
  retryCount?: number;
  modelInvocationStatus?: ModelInvocationStatus | null;
  modelInvocationModelName?: string | null;
  modelInvocationStartedAt?: string | null;
  modelInvocationEndedAt?: string | null;
  modelInvocationWarningCount?: number | null;
  modelInvocationErrorCode?: string | null;
  candidateOperationId?: string | null;
  deletionIntentId?: string | null;
  createdAt: string;
  taskDeletedAt?: string | null;
  deletedAt: string | null;
};

export type GeneratedSourceFileOutputRecord = {
  sourceFileId: string;
  fileId: string;
  logicalPath: string;
};

export type SourceFileEventRecord = {
  id: string;
  knowledgeBaseId: string;
  sourceFileId: string;
  stageKey: SourceFileProcessingStage | "source_deletion";
  messageKey: string;
  startedAt: string | null;
  endedAt: string | null;
  severity: "info" | "warning" | "error";
  createdAt: string;
};

export type SourceFileEventDraft = Omit<SourceFileEventRecord, "id" | "createdAt">;

export type SourceFileListFilters = {
  fileNameQuery?: string | null;
  fileIdQuery?: string | null;
  state?: SourceFileLifecycleState | null;
  currentStage?: SourceFileProcessingStage | null;
  modelInvocationStatus?: SourceFileModelInvocationFilter | null;
  generatedOutputStatus?: GeneratedOutputStatus | null;
  startedFrom?: string | null;
  startedTo?: string | null;
  endedFrom?: string | null;
  endedTo?: string | null;
  errorState?: SourceFileErrorState | null;
  errorCodeQuery?: string | null;
  actionState?: SourceFileActionState | null;
};

export type SourceFileRepository = {
  updateSourceFileProcessingState: (input: {
    knowledgeBaseId: string;
    sourceFileIds: string[];
    status: SourceFileProcessingStatus;
    stage: SourceFileProcessingStage;
    startedAt?: string | null;
    endedAt?: string | null;
    terminalFailure?: SourceFileTerminalFailure | null;
  }) => Promise<void>;
  updateSourceFileMetadata: (input: {
    knowledgeBaseId: string;
    sourceFileId: string;
    metadata: SourceMetadataDefaults;
  }) => Promise<void>;
  updateSourceFileModelSuggestions: (input: {
    knowledgeBaseId: string;
    sourceFileId: string;
    suggestions: SourceModelSuggestions | null;
  }) => Promise<void>;
  createSourceFileEvent: (input: SourceFileEventDraft) => Promise<SourceFileEventRecord>;
  listSourceFileEvents: (request: {
    knowledgeBaseId: string;
    sourceFileId: string;
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<SourceFileEventRecord>>;
  getSourceFile: (request: {
    knowledgeBaseId: string;
    sourceFileId: string;
  }) => Promise<SourceFileRecord | null>;
  getSourceFileForProcessing: (request: {
    knowledgeBaseId: string;
    sourceFileId: string;
  }) => Promise<SourceFileRecord | null>;
  listSourceFiles: (request: {
    knowledgeBaseId: string;
    limit: number;
    cursor: string | null;
  } & SourceFileListFilters) => Promise<CursorPage<SourceFileRecord>>;
};
