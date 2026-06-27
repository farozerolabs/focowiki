export type SourceFileProcessingStatus = "queued" | "running" | "completed" | "failed";
export type SourceFileProcessingStage =
  | "upload_storage"
  | "metadata_resolution"
  | "llm_suggestion"
  | "graph_generation"
  | "okf_validation"
  | "bundle_generation"
  | "index_publication"
  | "release_activation";
export type SourceFileModelInvocationStatus =
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "not_recorded";
export type SourceFileGeneratedOutputStatus = "pending" | "visible" | "unavailable";
export type SourceFileErrorState = "with_error" | "without_error";
export type SourceFileActionState = "openable" | "retryable" | "none";

export type SourceFileListFilters = {
  fileNameQuery: string;
  fileIdQuery: string;
  processingStatus: SourceFileProcessingStatus | null;
  processingStage: SourceFileProcessingStage | null;
  modelInvocationStatus: SourceFileModelInvocationStatus | null;
  generatedOutputStatus: SourceFileGeneratedOutputStatus | null;
  startedFrom: string | null;
  startedTo: string | null;
  endedFrom: string | null;
  endedTo: string | null;
  errorState: SourceFileErrorState | null;
  errorCodeQuery: string;
  actionState: SourceFileActionState | null;
};

export const SOURCE_FILE_PROCESSING_STATUSES: SourceFileProcessingStatus[] = [
  "queued",
  "running",
  "completed",
  "failed"
];

export const SOURCE_FILE_PROCESSING_STAGES: SourceFileProcessingStage[] = [
  "upload_storage",
  "metadata_resolution",
  "llm_suggestion",
  "graph_generation",
  "okf_validation",
  "bundle_generation",
  "index_publication",
  "release_activation"
];

export const SOURCE_FILE_MODEL_INVOCATION_STATUSES: SourceFileModelInvocationStatus[] = [
  "running",
  "completed",
  "failed",
  "skipped",
  "not_recorded"
];

export const SOURCE_FILE_GENERATED_OUTPUT_STATUSES: SourceFileGeneratedOutputStatus[] = [
  "pending",
  "visible",
  "unavailable"
];

export const SOURCE_FILE_ERROR_STATES: SourceFileErrorState[] = [
  "with_error",
  "without_error"
];

export const SOURCE_FILE_ACTION_STATES: SourceFileActionState[] = [
  "openable",
  "retryable",
  "none"
];

export function createEmptySourceFileListFilters(): SourceFileListFilters {
  return {
    fileNameQuery: "",
    fileIdQuery: "",
    processingStatus: null,
    processingStage: null,
    modelInvocationStatus: null,
    generatedOutputStatus: null,
    startedFrom: null,
    startedTo: null,
    endedFrom: null,
    endedTo: null,
    errorState: null,
    errorCodeQuery: "",
    actionState: null
  };
}

export function hasActiveSourceFileFilters(filters: SourceFileListFilters): boolean {
  return sourceFileFilterCount(filters) > 0;
}

export function sourceFileFilterCount(filters: SourceFileListFilters): number {
  return [
    filters.fileNameQuery.trim(),
    filters.fileIdQuery.trim(),
    filters.processingStatus,
    filters.processingStage,
    filters.modelInvocationStatus,
    filters.generatedOutputStatus,
    filters.startedFrom,
    filters.startedTo,
    filters.endedFrom,
    filters.endedTo,
    filters.errorState,
    filters.errorCodeQuery.trim(),
    filters.actionState
  ].filter(Boolean).length;
}

export function appendSourceFileFilterParams(
  params: URLSearchParams,
  filters: SourceFileListFilters
): void {
  setTextParam(params, "fileNameQuery", filters.fileNameQuery);
  setTextParam(params, "fileIdQuery", filters.fileIdQuery);
  setEnumParam(params, "processingStatus", filters.processingStatus);
  setEnumParam(params, "processingStage", filters.processingStage);
  setEnumParam(params, "modelInvocationStatus", filters.modelInvocationStatus);
  setEnumParam(params, "generatedOutputStatus", filters.generatedOutputStatus);
  setEnumParam(params, "startedFrom", filters.startedFrom);
  setEnumParam(params, "startedTo", filters.startedTo);
  setEnumParam(params, "endedFrom", filters.endedFrom);
  setEnumParam(params, "endedTo", filters.endedTo);
  setEnumParam(params, "errorState", filters.errorState);
  setTextParam(params, "errorCodeQuery", filters.errorCodeQuery);
  setEnumParam(params, "actionState", filters.actionState);
}

export function toDatetimeLocalValue(value: string | null): string {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

export function fromDatetimeLocalValue(value: string): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function setTextParam(params: URLSearchParams, name: string, value: string): void {
  const normalized = value.trim();

  if (normalized) {
    params.set(name, normalized);
  }
}

function setEnumParam(params: URLSearchParams, name: string, value: string | null): void {
  if (value) {
    params.set(name, value);
  }
}
