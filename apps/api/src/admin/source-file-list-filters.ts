import type {
  GeneratedOutputStatus,
  SourceFileErrorState,
  SourceFileProcessingStage,
  SourceFileProcessingStatus
} from "../db/admin-repositories.js";

export type SourceFileListFilters = {
  processingStatus: SourceFileProcessingStatus | null;
  processingStage: SourceFileProcessingStage | null;
  generatedOutputStatus: GeneratedOutputStatus | null;
  errorState: SourceFileErrorState | null;
};

export function readSourceFileListFilters(input: {
  processingStatus: string | undefined;
  processingStage: string | undefined;
  generatedOutputStatus: string | undefined;
  errorState: string | undefined;
}): SourceFileListFilters | null {
  const processingStatus = readOptionalSourceFileFilter(input.processingStatus, [
    "queued",
    "running",
    "completed",
    "failed"
  ]);
  const processingStage = readOptionalSourceFileFilter(input.processingStage, [
    "upload_storage",
    "metadata_resolution",
    "llm_suggestion",
    "graph_generation",
    "okf_validation",
    "bundle_generation",
    "index_publication",
    "release_activation"
  ]);
  const generatedOutputStatus = readOptionalSourceFileFilter(input.generatedOutputStatus, [
    "pending",
    "visible",
    "unavailable"
  ]);
  const errorState = readOptionalSourceFileFilter(input.errorState, [
    "with_error",
    "without_error"
  ]);

  if (
    processingStatus === undefined ||
    processingStage === undefined ||
    generatedOutputStatus === undefined ||
    errorState === undefined
  ) {
    return null;
  }

  return {
    processingStatus,
    processingStage,
    generatedOutputStatus,
    errorState
  };
}

export function createSourceFileCursorScope(
  knowledgeBaseId: string,
  filters: SourceFileListFilters
): string {
  return [
    "source-files",
    knowledgeBaseId,
    `processingStatus=${filters.processingStatus ?? ""}`,
    `processingStage=${filters.processingStage ?? ""}`,
    `generatedOutputStatus=${filters.generatedOutputStatus ?? ""}`,
    `errorState=${filters.errorState ?? ""}`
  ].join(":");
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
