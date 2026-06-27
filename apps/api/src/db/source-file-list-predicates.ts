import type { SourceFileListFilters } from "./admin-repositories.js";
import type { DatabaseClient } from "./client.js";

type SqlFragment = ReturnType<DatabaseClient>;

export function createSourceFileListFilterPredicate(
  sql: DatabaseClient,
  filters: SourceFileListFilters
): SqlFragment {
  const fileNameFilter = filters.fileNameQuery
    ? sql`AND source.original_name ILIKE ${containsPattern(filters.fileNameQuery)} ESCAPE ${"\\"}`
    : sql``;
  const fileIdFilter = filters.fileIdQuery
    ? sql`AND source.id LIKE ${prefixPattern(filters.fileIdQuery)} ESCAPE ${"\\"}`
    : sql``;
  const processingStatusFilter = filters.processingStatus
    ? sql`AND source.processing_status = ${filters.processingStatus}`
    : sql``;
  const processingStageFilter = filters.processingStage
    ? sql`AND source.processing_stage = ${filters.processingStage}`
    : sql``;
  const modelInvocationStatusFilter =
    filters.modelInvocationStatus === "not_recorded"
      ? sql`AND source.model_invocation_status IS NULL`
      : filters.modelInvocationStatus
        ? sql`AND source.model_invocation_status = ${filters.modelInvocationStatus}`
        : sql``;
  const generatedOutputStatusFilter = filters.generatedOutputStatus
    ? sql`AND source.generated_output_status = ${filters.generatedOutputStatus}`
    : sql``;
  const startedFromFilter = filters.startedFrom
    ? sql`AND source.processing_started_at >= ${filters.startedFrom}`
    : sql``;
  const startedToFilter = filters.startedTo
    ? sql`AND source.processing_started_at <= ${filters.startedTo}`
    : sql``;
  const endedFromFilter = filters.endedFrom
    ? sql`AND source.processing_ended_at >= ${filters.endedFrom}`
    : sql``;
  const endedToFilter = filters.endedTo
    ? sql`AND source.processing_ended_at <= ${filters.endedTo}`
    : sql``;
  const errorStateFilter =
    filters.errorState === "with_error"
      ? sql`AND (source.processing_error_code IS NOT NULL OR source.publication_error_code IS NOT NULL)`
      : filters.errorState === "without_error"
        ? sql`AND source.processing_error_code IS NULL AND source.publication_error_code IS NULL`
        : sql``;
  const errorCodeFilter = filters.errorCodeQuery
    ? sql`AND (
        source.processing_error_code ILIKE ${containsPattern(filters.errorCodeQuery)} ESCAPE ${"\\"}
        OR source.publication_error_code ILIKE ${containsPattern(filters.errorCodeQuery)} ESCAPE ${"\\"}
      )`
    : sql``;
  const actionStateFilter =
    filters.actionState === "openable"
      ? sql`AND source.generated_output_status = 'visible' AND source.generated_bundle_file_path IS NOT NULL`
      : filters.actionState === "retryable"
        ? sql`AND source.processing_status = 'failed'`
        : filters.actionState === "none"
          ? sql`AND NOT (
              (source.generated_output_status = 'visible' AND source.generated_bundle_file_path IS NOT NULL)
              OR source.processing_status = 'failed'
            )`
          : sql``;

  return sql`
    ${fileNameFilter}
    ${fileIdFilter}
    ${processingStatusFilter}
    ${processingStageFilter}
    ${modelInvocationStatusFilter}
    ${generatedOutputStatusFilter}
    ${startedFromFilter}
    ${startedToFilter}
    ${endedFromFilter}
    ${endedToFilter}
    ${errorStateFilter}
    ${errorCodeFilter}
    ${actionStateFilter}
  `;
}

function containsPattern(value: string): string {
  return `%${escapeLikePattern(value)}%`;
}

function prefixPattern(value: string): string {
  return `${escapeLikePattern(value)}%`;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
