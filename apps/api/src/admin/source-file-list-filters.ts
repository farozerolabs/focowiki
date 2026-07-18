import type {
  GeneratedOutputStatus,
  SourceFileActionState,
  SourceFileErrorState,
  SourceFileListFilters,
  SourceFileModelInvocationFilter,
  SourceFileProcessingStage
} from "../db/admin-repositories.js";
import type { SourceFileLifecycleState } from "../domain/source-file-lifecycle.js";

export type SourceFileListFilterErrorCode =
  | "INVALID_SOURCE_FILE_FILTER"
  | "SOURCE_FILE_FILTER_TEXT_TOO_SHORT"
  | "SOURCE_FILE_FILTER_TEXT_TOO_LONG"
  | "SOURCE_FILE_FILTER_TIME_RANGE_INVALID";

export type SourceFileListFilterParseResult =
  | { ok: true; filters: SourceFileListFilters }
  | { ok: false; code: SourceFileListFilterErrorCode };

const TEXT_FILTER_MAX_LENGTH = 160;
const FILE_NAME_QUERY_MIN_LENGTH = 1;
const FILE_ID_QUERY_MIN_LENGTH = 8;
const ERROR_CODE_QUERY_MIN_LENGTH = 2;

export function readSourceFileListFilters(input: {
  fileNameQuery: string | undefined;
  fileIdQuery: string | undefined;
  state: string | undefined;
  currentStage: string | undefined;
  modelInvocationStatus: string | undefined;
  generatedOutputStatus: string | undefined;
  startedFrom: string | undefined;
  startedTo: string | undefined;
  endedFrom: string | undefined;
  endedTo: string | undefined;
  errorState: string | undefined;
  errorCodeQuery: string | undefined;
  actionState: string | undefined;
}): SourceFileListFilterParseResult {
  const fileNameQuery = readTextFilter(input.fileNameQuery, {
    minLength: FILE_NAME_QUERY_MIN_LENGTH
  });
  const fileIdQuery = readTextFilter(input.fileIdQuery, {
    minLength: FILE_ID_QUERY_MIN_LENGTH
  });
  const errorCodeQuery = readTextFilter(input.errorCodeQuery, {
    minLength: ERROR_CODE_QUERY_MIN_LENGTH
  });
  const state = readOptionalSourceFileFilter<SourceFileLifecycleState>(
    input.state,
    ["queued", "running", "pending_publication", "visible", "failed"]
  );
  const currentStage = readOptionalSourceFileFilter<SourceFileProcessingStage>(
    input.currentStage,
    [
      "upload_storage",
      "metadata_resolution",
      "llm_suggestion",
      "graph_generation",
      "projection_generation",
      "generation_validation",
      "generation_activation"
    ]
  );
  const modelInvocationStatus = readOptionalSourceFileFilter<SourceFileModelInvocationFilter>(
    input.modelInvocationStatus,
    ["running", "completed", "failed", "skipped", "not_recorded"]
  );
  const generatedOutputStatus = readOptionalSourceFileFilter<GeneratedOutputStatus>(
    input.generatedOutputStatus,
    ["pending", "visible", "unavailable"]
  );
  const errorState = readOptionalSourceFileFilter<SourceFileErrorState>(input.errorState, [
    "with_error",
    "without_error"
  ]);
  const actionState = readOptionalSourceFileFilter<SourceFileActionState>(input.actionState, [
    "openable",
    "retryable",
    "none"
  ]);
  const startedFrom = readTimestampFilter(input.startedFrom);
  const startedTo = readTimestampFilter(input.startedTo);
  const endedFrom = readTimestampFilter(input.endedFrom);
  const endedTo = readTimestampFilter(input.endedTo);

  const textError = firstTextError(fileNameQuery, fileIdQuery, errorCodeQuery);

  if (textError) {
    return { ok: false, code: textError };
  }

  if (
    state === undefined ||
    currentStage === undefined ||
    modelInvocationStatus === undefined ||
    generatedOutputStatus === undefined ||
    errorState === undefined ||
    actionState === undefined ||
    startedFrom === undefined ||
    startedTo === undefined ||
    endedFrom === undefined ||
    endedTo === undefined
  ) {
    return { ok: false, code: "INVALID_SOURCE_FILE_FILTER" };
  }

  if (startedFrom && startedTo && startedFrom > startedTo) {
    return { ok: false, code: "SOURCE_FILE_FILTER_TIME_RANGE_INVALID" };
  }

  if (endedFrom && endedTo && endedFrom > endedTo) {
    return { ok: false, code: "SOURCE_FILE_FILTER_TIME_RANGE_INVALID" };
  }

  return {
    ok: true,
    filters: {
      fileNameQuery: fileNameQuery.value,
      fileIdQuery: fileIdQuery.value,
      state,
      currentStage,
      modelInvocationStatus,
      generatedOutputStatus,
      startedFrom,
      startedTo,
      endedFrom,
      endedTo,
      errorState,
      errorCodeQuery: errorCodeQuery.value,
      actionState
    }
  };
}

export function readSourceFileListFiltersFromQuery(
  readQuery: (name: string) => string | undefined
): SourceFileListFilterParseResult {
  return readSourceFileListFilters({
    fileNameQuery: readQuery("fileNameQuery"),
    fileIdQuery: readQuery("fileIdQuery"),
    state: readQuery("state"),
    currentStage: readQuery("currentStage"),
    modelInvocationStatus: readQuery("modelInvocationStatus"),
    generatedOutputStatus: readQuery("generatedOutputStatus"),
    startedFrom: readQuery("startedFrom"),
    startedTo: readQuery("startedTo"),
    endedFrom: readQuery("endedFrom"),
    endedTo: readQuery("endedTo"),
    errorState: readQuery("errorState"),
    errorCodeQuery: readQuery("errorCodeQuery"),
    actionState: readQuery("actionState")
  });
}

function readOptionalSourceFileFilter<T extends string>(
  value: string | undefined,
  allowedValues: readonly T[]
): T | null | undefined {
  if (!value) {
    return null;
  }

  return allowedValues.includes(value as T) ? (value as T) : undefined;
}

function readTextFilter(
  value: string | undefined,
  options: { minLength: number }
):
  | { value: string | null; error: null }
  | { value: null; error: "SOURCE_FILE_FILTER_TEXT_TOO_SHORT" | "SOURCE_FILE_FILTER_TEXT_TOO_LONG" } {
  const normalized = value?.trim() ?? "";

  if (!normalized) {
    return { value: null, error: null };
  }

  if (normalized.length < options.minLength) {
    return { value: null, error: "SOURCE_FILE_FILTER_TEXT_TOO_SHORT" };
  }

  if (normalized.length > TEXT_FILTER_MAX_LENGTH) {
    return { value: null, error: "SOURCE_FILE_FILTER_TEXT_TOO_LONG" };
  }

  return { value: normalized, error: null };
}

function readTimestampFilter(value: string | undefined): string | null | undefined {
  const normalized = value?.trim() ?? "";

  if (!normalized) {
    return null;
  }

  const time = Date.parse(normalized);

  if (!Number.isFinite(time)) {
    return undefined;
  }

  return new Date(time).toISOString();
}

function firstTextError(
  ...filters: Array<ReturnType<typeof readTextFilter>>
): SourceFileListFilterErrorCode | null {
  return filters.find((filter) => filter.error)?.error ?? null;
}
