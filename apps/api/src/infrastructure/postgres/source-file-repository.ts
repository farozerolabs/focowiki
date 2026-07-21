import { randomUUID } from "node:crypto";
import type { SourceMetadataDefaults, SourceModelSuggestions } from "@focowiki/okf";
import type {
  CursorPage,
  GeneratedOutputStatus,
  ModelInvocationStatus,
  SourceFileEventRecord,
  SourceFileListFilters,
  SourceFileProcessingStage,
  SourceFileProcessingStatus,
  SourceFileRecord,
  SourceFileRepository
} from "../../application/ports/source-file-repository.js";
import type {
  SourceFileFailureStage,
  SourceFileTerminalFailure
} from "../../domain/source-file-lifecycle.js";
import type { DatabaseClient } from "../../db/client.js";
import { createSourceFileListFilterPredicate } from "../../db/source-file-list-predicates.js";

const SOURCE_FILE_SELECT_COLUMNS = `
  source.id,
  source.knowledge_base_id,
  source.active_revision_id AS source_revision_id,
  source.relative_path,
  source.resource_revision,
  source.object_key,
  source.content_type,
  source.size_bytes,
  source.checksum_sha256,
  source.metadata_json,
  source.model_suggestions_json,
  source.processing_status,
  source.processing_stage,
  source.processing_started_at,
  source.processing_ended_at,
  source.terminal_failure_stage,
  source.terminal_failure_code,
  source.terminal_failure_message,
  source.terminal_failure_at,
  source.terminal_failure_retry_kind,
  source.terminal_failure_correlation_id,
  source.generated_output_status,
  source.model_invocation_status,
  source.model_invocation_model_name,
  source.model_invocation_started_at,
  source.model_invocation_ended_at,
  source.model_invocation_warning_count,
  source.model_invocation_error_code,
  source.candidate_operation_id,
  source.deletion_intent_id,
  source.retry_count,
  source.created_at,
  source.task_deleted_at,
  source.deleted_at
`;

const SOURCE_FILE_PROCESSING_SELECT_COLUMNS = `
  source.id,
  source.knowledge_base_id,
  CASE WHEN source.candidate_operation_id IS NULL
    THEN source.active_revision_id ELSE source.candidate_revision_id END AS source_revision_id,
  COALESCE(source.candidate_relative_path, source.relative_path) AS relative_path,
  source.resource_revision,
  COALESCE(source.candidate_object_key, source.object_key) AS object_key,
  COALESCE(source.candidate_content_type, source.content_type) AS content_type,
  COALESCE(source.candidate_size_bytes, source.size_bytes) AS size_bytes,
  COALESCE(source.candidate_checksum_sha256, source.checksum_sha256) AS checksum_sha256,
  COALESCE(source.candidate_metadata_json, source.metadata_json) AS metadata_json,
  CASE WHEN source.candidate_operation_id IS NULL
    THEN source.model_suggestions_json ELSE source.candidate_model_suggestions_json END AS model_suggestions_json,
  source.processing_status,
  source.processing_stage,
  source.processing_started_at,
  source.processing_ended_at,
  source.terminal_failure_stage,
  source.terminal_failure_code,
  source.terminal_failure_message,
  source.terminal_failure_at,
  source.terminal_failure_retry_kind,
  source.terminal_failure_correlation_id,
  source.generated_output_status,
  source.model_invocation_status,
  source.model_invocation_model_name,
  source.model_invocation_started_at,
  source.model_invocation_ended_at,
  source.model_invocation_warning_count,
  source.model_invocation_error_code,
  source.candidate_operation_id,
  source.deletion_intent_id,
  source.retry_count,
  source.created_at,
  source.task_deleted_at,
  source.deleted_at
`;

type SourceFileRow = {
  id: string;
  knowledge_base_id: string;
  source_revision_id: string;
  relative_path: string;
  resource_revision: number;
  object_key: string;
  content_type: string;
  size_bytes: string | number;
  checksum_sha256: string;
  metadata_json: unknown;
  model_suggestions_json: unknown;
  processing_status: SourceFileProcessingStatus;
  processing_stage: SourceFileProcessingStage;
  processing_started_at: Date | null;
  processing_ended_at: Date | null;
  terminal_failure_stage: SourceFileFailureStage | null;
  terminal_failure_code: string | null;
  terminal_failure_message: string | null;
  terminal_failure_at: Date | null;
  terminal_failure_retry_kind: SourceFileTerminalFailure["retryKind"] | null;
  terminal_failure_correlation_id: string | null;
  generated_output_status: GeneratedOutputStatus;
  retry_count: string | number;
  model_invocation_status?: ModelInvocationStatus | null;
  model_invocation_model_name?: string | null;
  model_invocation_started_at?: Date | null;
  model_invocation_ended_at?: Date | null;
  model_invocation_warning_count?: string | number | null;
  model_invocation_error_code?: string | null;
  candidate_operation_id: string | null;
  deletion_intent_id: string | null;
  created_at: Date;
  task_deleted_at?: Date | null;
  deleted_at: Date | null;
};

type SourceFileEventRow = {
  id: string;
  knowledge_base_id: string;
  source_file_id: string;
  stage_key: SourceFileEventRecord["stageKey"];
  message_key: string;
  started_at: Date | null;
  ended_at: Date | null;
  severity: SourceFileEventRecord["severity"];
  created_at: Date;
};

export function createPostgresSourceFileRepository(sql: DatabaseClient): SourceFileRepository {
  return {
    async updateSourceFileProcessingState(input) {
      if (input.sourceFileIds.length === 0) return;
      if (input.status === "failed" && !input.terminalFailure) {
        throw new Error("Terminal source-file failure is required for failed state");
      }

      await sql`
        UPDATE focowiki.source_files
        SET processing_status = ${input.status},
            processing_stage = ${input.stage},
            processing_started_at = COALESCE(${input.startedAt ?? null}, processing_started_at),
            processing_ended_at = ${input.endedAt ?? null},
            terminal_failure_stage = CASE WHEN ${input.status} = 'failed'
              THEN ${input.terminalFailure?.stage ?? null} ELSE terminal_failure_stage END,
            terminal_failure_code = CASE WHEN ${input.status} = 'failed'
              THEN ${input.terminalFailure?.code ?? null} ELSE terminal_failure_code END,
            terminal_failure_message = CASE WHEN ${input.status} = 'failed'
              THEN ${input.terminalFailure?.message ?? null} ELSE terminal_failure_message END,
            terminal_failure_at = CASE WHEN ${input.status} = 'failed'
              THEN ${input.terminalFailure?.occurredAt ?? null} ELSE terminal_failure_at END,
            terminal_failure_retry_kind = CASE WHEN ${input.status} = 'failed'
              THEN ${input.terminalFailure?.retryKind ?? null} ELSE terminal_failure_retry_kind END,
            terminal_failure_correlation_id = CASE WHEN ${input.status} = 'failed'
              THEN ${input.terminalFailure?.correlationId ?? null}
              ELSE terminal_failure_correlation_id END
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND id = ANY(${input.sourceFileIds})
          AND deleted_at IS NULL
          AND task_deleted_at IS NULL
      `;
      const shouldUpdateRevision = input.status === "queued"
        || input.status === "failed"
        || (input.status === "running" && input.startedAt !== null);
      if (shouldUpdateRevision) {
        await sql`
          UPDATE focowiki.source_revisions revision
          SET processing_status = CASE
                WHEN ${input.status} = 'queued' THEN 'queued'
                WHEN ${input.status} = 'running' THEN 'running'
                ELSE 'failed'
              END
          FROM focowiki.source_files source
          WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
            AND source.id = ANY(${input.sourceFileIds})
            AND revision.id = CASE
              WHEN source.candidate_operation_id IS NULL THEN source.active_revision_id
              ELSE source.candidate_revision_id
            END
        `;
      }
    },
    async updateSourceFileMetadata(input) {
      await sql`
        UPDATE focowiki.source_files
        SET metadata_json = CASE
              WHEN candidate_operation_id IS NULL THEN ${sql.json(input.metadata as never)}
              ELSE metadata_json
            END,
            candidate_metadata_json = CASE
              WHEN candidate_operation_id IS NULL THEN candidate_metadata_json
              ELSE ${sql.json(input.metadata as never)}
            END
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND id = ${input.sourceFileId}
          AND deleted_at IS NULL
          AND task_deleted_at IS NULL
      `;
      await sql`
        UPDATE focowiki.source_revisions revision
        SET metadata_json = ${sql.json(input.metadata as never)}
        FROM focowiki.source_files source
        WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
          AND source.id = ${input.sourceFileId}
          AND revision.id = CASE
            WHEN source.candidate_operation_id IS NULL THEN source.active_revision_id
            ELSE source.candidate_revision_id
          END
      `;
    },
    async updateSourceFileModelSuggestions(input) {
      await sql`
        UPDATE focowiki.source_files
        SET model_suggestions_json = CASE
              WHEN candidate_operation_id IS NULL
              THEN ${input.suggestions ? sql.json(input.suggestions as never) : null}
              ELSE model_suggestions_json
            END,
            candidate_model_suggestions_json = CASE
              WHEN candidate_operation_id IS NULL THEN candidate_model_suggestions_json
              ELSE ${input.suggestions ? sql.json(input.suggestions as never) : null}
            END
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND id = ${input.sourceFileId}
          AND deleted_at IS NULL
          AND task_deleted_at IS NULL
      `;
    },
    async createSourceFileEvent(input) {
      const rows = await sql<SourceFileEventRow[]>`
        INSERT INTO focowiki.source_file_events (
          id, knowledge_base_id, source_file_id, stage_key, message_key,
          started_at, ended_at, severity
        )
        SELECT
          ${`source-file-event-${randomUUID()}`}, ${input.knowledgeBaseId}, ${input.sourceFileId},
          ${input.stageKey}, ${input.messageKey}, ${input.startedAt}, ${input.endedAt}, ${input.severity}
        FROM focowiki.source_files source
        WHERE source.id = ${input.sourceFileId}
          AND source.knowledge_base_id = ${input.knowledgeBaseId}
          AND source.deleted_at IS NULL
          AND source.deletion_intent_id IS NULL
        RETURNING id, knowledge_base_id, source_file_id, stage_key, message_key,
                  started_at, ended_at, severity, created_at
      `;
      const row = rows[0];
      if (!row) throw new Error("Source file event creation did not return a row");
      return mapSourceFileEventRow(row);
    },
    async listSourceFileEvents(input) {
      const cursor = input.cursor ? parseTimedCursor(input.cursor) : null;
      const rows = cursor
        ? await sql<Array<SourceFileEventRow & { cursor_timestamp: string }>>`
            SELECT id, knowledge_base_id, source_file_id, stage_key, message_key,
                   started_at, ended_at, severity, created_at,
                   floor(extract(epoch FROM created_at) * 1000000)::bigint::text AS cursor_timestamp
            FROM focowiki.source_file_events
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
              AND source_file_id = ${input.sourceFileId}
              AND (created_at > to_timestamp(${cursor.createdAt}::double precision / 1000000)
                OR (created_at = to_timestamp(${cursor.createdAt}::double precision / 1000000)
                  AND id > ${cursor.id}))
            ORDER BY created_at ASC, id ASC
            LIMIT ${input.limit + 1}
          `
        : await sql<Array<SourceFileEventRow & { cursor_timestamp: string }>>`
            SELECT id, knowledge_base_id, source_file_id, stage_key, message_key,
                   started_at, ended_at, severity, created_at,
                   floor(extract(epoch FROM created_at) * 1000000)::bigint::text AS cursor_timestamp
            FROM focowiki.source_file_events
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
              AND source_file_id = ${input.sourceFileId}
            ORDER BY created_at ASC, id ASC
            LIMIT ${input.limit + 1}
          `;
      return pageTimedRows(rows, input.limit, mapSourceFileEventRow);
    },
    async getSourceFile(input) {
      return getSourceFile(sql, input, SOURCE_FILE_SELECT_COLUMNS);
    },
    async getSourceFileForProcessing(input) {
      return getSourceFile(sql, input, SOURCE_FILE_PROCESSING_SELECT_COLUMNS);
    },
    async listSourceFiles({ knowledgeBaseId, limit, cursor, ...filters }) {
      return listSourceFiles(sql, { knowledgeBaseId, limit, cursor, filters });
    }
  };
}

async function getSourceFile(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; sourceFileId: string },
  columns: string
): Promise<SourceFileRecord | null> {
  const rows = await sql<SourceFileRow[]>`
    SELECT ${sql.unsafe(columns)}
    FROM focowiki.source_files source
    WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
      AND source.id = ${input.sourceFileId}
      AND source.deleted_at IS NULL
      AND source.task_deleted_at IS NULL
    LIMIT 1
  `;
  return rows[0] ? mapSourceFileRow(rows[0]) : null;
}

async function listSourceFiles(
  sql: DatabaseClient,
  input: {
    knowledgeBaseId: string;
    limit: number;
    cursor: string | null;
    filters: SourceFileListFilters;
  }
): Promise<CursorPage<SourceFileRecord>> {
  const cursor = input.cursor ? parseTimedCursor(input.cursor) : null;
  const predicate = createSourceFileListFilterPredicate(sql, input.filters);
  const rows = cursor
    ? await sql<Array<SourceFileRow & { cursor_timestamp: string }>>`
        SELECT ${sql.unsafe(SOURCE_FILE_SELECT_COLUMNS)},
               floor(extract(epoch FROM source.created_at) * 1000000)::bigint::text AS cursor_timestamp
        FROM focowiki.source_files source
        WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
          AND source.deleted_at IS NULL
          AND source.task_deleted_at IS NULL
          ${predicate}
          AND (source.created_at < to_timestamp(${cursor.createdAt}::double precision / 1000000)
            OR (source.created_at = to_timestamp(${cursor.createdAt}::double precision / 1000000)
              AND source.id > ${cursor.id}))
        ORDER BY source.created_at DESC, source.id ASC
        LIMIT ${input.limit + 1}
      `
    : await sql<Array<SourceFileRow & { cursor_timestamp: string }>>`
        SELECT ${sql.unsafe(SOURCE_FILE_SELECT_COLUMNS)},
               floor(extract(epoch FROM source.created_at) * 1000000)::bigint::text AS cursor_timestamp
        FROM focowiki.source_files source
        WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
          AND source.deleted_at IS NULL
          AND source.task_deleted_at IS NULL
          ${predicate}
        ORDER BY source.created_at DESC, source.id ASC
        LIMIT ${input.limit + 1}
      `;
  return pageTimedRows(rows, input.limit, mapSourceFileRow);
}

function pageTimedRows<T extends { id: string; cursor_timestamp: string }, R>(
  rows: T[],
  limit: number,
  map: (row: T) => R
): CursorPage<R> {
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(map),
    nextCursor: rows.length > limit && last
      ? serializeTimedCursor({ createdAt: last.cursor_timestamp, id: last.id })
      : null
  };
}

function mapSourceFileRow(row: SourceFileRow): SourceFileRecord {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    sourceRevisionId: row.source_revision_id,
    name: row.relative_path.split("/").at(-1) ?? row.relative_path,
    relativePath: row.relative_path,
    resourceRevision: row.resource_revision,
    objectKey: row.object_key,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    checksumSha256: row.checksum_sha256,
    metadata: readRecord(row.metadata_json) as SourceMetadataDefaults,
    modelSuggestions: readOptionalRecord(row.model_suggestions_json) as SourceModelSuggestions | null,
    processingStatus: row.processing_status,
    processingStage: row.processing_stage,
    processingStartedAt: row.processing_started_at?.toISOString() ?? null,
    processingEndedAt: row.processing_ended_at?.toISOString() ?? null,
    generatedOutputStatus: row.generated_output_status,
    terminalFailure: mapTerminalFailure(row),
    retryCount: Number(row.retry_count),
    modelInvocationStatus: row.model_invocation_status ?? null,
    modelInvocationModelName: row.model_invocation_model_name ?? null,
    modelInvocationStartedAt: row.model_invocation_started_at?.toISOString() ?? null,
    modelInvocationEndedAt: row.model_invocation_ended_at?.toISOString() ?? null,
    modelInvocationWarningCount: row.model_invocation_warning_count == null
      ? null
      : Number(row.model_invocation_warning_count),
    modelInvocationErrorCode: row.model_invocation_error_code ?? null,
    candidateOperationId: row.candidate_operation_id,
    deletionIntentId: row.deletion_intent_id,
    createdAt: row.created_at.toISOString(),
    taskDeletedAt: row.task_deleted_at?.toISOString() ?? null,
    deletedAt: row.deleted_at?.toISOString() ?? null
  };
}

function mapTerminalFailure(row: SourceFileRow): SourceFileTerminalFailure | null {
  if (!row.terminal_failure_code) return null;
  if (!row.terminal_failure_stage || !row.terminal_failure_message || !row.terminal_failure_at
    || !row.terminal_failure_retry_kind || !row.terminal_failure_correlation_id) {
    throw new Error("Source file terminal failure record is incomplete");
  }
  return {
    stage: row.terminal_failure_stage,
    code: row.terminal_failure_code,
    message: row.terminal_failure_message,
    occurredAt: row.terminal_failure_at.toISOString(),
    retryKind: row.terminal_failure_retry_kind,
    correlationId: row.terminal_failure_correlation_id
  };
}

function mapSourceFileEventRow(row: SourceFileEventRow): SourceFileEventRecord {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    sourceFileId: row.source_file_id,
    stageKey: row.stage_key,
    messageKey: row.message_key,
    startedAt: row.started_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
    severity: row.severity,
    createdAt: row.created_at.toISOString()
  };
}

function serializeTimedCursor(cursor: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function parseTimedCursor(cursor: string): { createdAt: string; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid timed cursor");
  }
  if (!isRecord(parsed) || typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") {
    throw new Error("Invalid timed cursor");
  }
  return { createdAt: parsed.createdAt, id: parsed.id };
}

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readOptionalRecord(value: unknown): Record<string, unknown> | null {
  return value == null ? null : readRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
