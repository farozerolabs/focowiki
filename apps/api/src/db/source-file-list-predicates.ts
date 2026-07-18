import type { SourceFileListFilters } from "../application/ports/source-file-repository.js";
import type { DatabaseClient } from "./client.js";
import type { SourceFileLifecycleState } from "../domain/source-file-lifecycle.js";

type SqlFragment = ReturnType<DatabaseClient>;

export function createSourceFileListFilterPredicate(
  sql: DatabaseClient,
  filters: SourceFileListFilters
): SqlFragment {
  const fileNameFilter = filters.fileNameQuery
    ? sql`AND source.relative_path ILIKE ${containsPattern(filters.fileNameQuery)} ESCAPE ${"\\"}`
    : sql``;
  const fileIdFilter = filters.fileIdQuery
    ? sql`AND source.id LIKE ${prefixPattern(filters.fileIdQuery)} ESCAPE ${"\\"}`
    : sql``;
  const lifecycleStateFilter = createSourceFileLifecycleStatePredicate(sql, filters.state ?? null);
  const currentStageFilter = filters.currentStage
    ? sql`AND (
        source.terminal_failure_stage = ${filters.currentStage}
        OR (
          source.terminal_failure_stage IS NULL
          AND source.processing_stage = ${filters.currentStage}
        )
      )`
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
      ? sql`AND source.terminal_failure_code IS NOT NULL`
      : filters.errorState === "without_error"
        ? sql`AND source.terminal_failure_code IS NULL`
        : sql``;
  const errorCodeFilter = filters.errorCodeQuery
    ? sql`AND source.terminal_failure_code
        ILIKE ${containsPattern(filters.errorCodeQuery)} ESCAPE ${"\\"}`
    : sql``;
  const actionStateFilter =
    filters.actionState === "openable"
      ? sql`AND source.generated_output_status = 'visible'`
      : filters.actionState === "retryable"
        ? sql`AND source.terminal_failure_retry_kind IN ('source_processing', 'publication')`
        : filters.actionState === "none"
          ? sql`AND NOT (
              source.generated_output_status = 'visible'
              OR source.terminal_failure_code IS NOT NULL
            )`
          : sql``;

  return sql`
    ${fileNameFilter}
    ${fileIdFilter}
    ${lifecycleStateFilter}
    ${currentStageFilter}
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

export function createSourceFileLifecycleStatePredicate(
  sql: DatabaseClient,
  state: SourceFileLifecycleState | null
): SqlFragment {
  switch (state) {
    case "queued":
      return sql`AND source.terminal_failure_code IS NULL AND source.processing_status = 'queued'`;
    case "running":
      return sql`AND source.terminal_failure_code IS NULL AND source.processing_status = 'running'`;
    case "pending_publication":
      return sql`AND source.terminal_failure_code IS NULL
        AND source.processing_status = 'completed'
        AND source.generated_output_status <> 'visible'`;
    case "visible":
      return sql`AND source.terminal_failure_code IS NULL
        AND source.generated_output_status = 'visible'`;
    case "failed":
      return sql`AND source.terminal_failure_code IS NOT NULL`;
    default:
      return sql``;
  }
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
