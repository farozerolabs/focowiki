import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import type {
  SourceDirectoryRecord,
  SourceResourceFileFilters,
  SourceResourceFileRecord
} from "../../domain/source-resource.js";
import { SourceResourceError } from "../../domain/source-resource.js";
import type {
  SourceFileGeneratedOutputStatus,
  SourceFileLifecycleState,
  SourceFileWorkKind
} from "../../domain/source-file-lifecycle.js";

type DirectoryRow = {
  public_id: string;
  knowledge_base_id: string;
  parent_public_id: string | null;
  logical_path: string;
  revision: number | string;
  created_at: Date;
  updated_at: Date;
  direct_file_count: number | string;
  descendant_file_count: number | string;
};

type SourceRow = {
  public_id: string;
  knowledge_base_id: string;
  directory_public_id: string | null;
  logical_path: string;
  source_revision_public_id: string;
  active_source_revision_public_id: string | null;
  checksum_sha256: string;
  byte_count: number | string;
  content_type: string;
  resource_revision: number | string;
  content_revision: number | string;
  job_public_id: string;
  job_state: SourceFileLifecycleState;
  required_work_count: number | string;
  completed_work_count: number | string;
  active_work_kinds: unknown;
  blocking_work_kind: SourceFileWorkKind | null;
  retrying_work_kind: SourceFileWorkKind | null;
  safe_error_code: string | null;
  safe_error_message: string | null;
  retryable: boolean;
  retry_count: number | string;
  model_status: "not_required" | "running" | "completed" | "failed" | null;
  model_name: string | null;
  model_started_at: Date | null;
  model_ended_at: Date | null;
  model_warning_count: number | string | null;
  model_error_code: string | null;
  model_layer_executions: unknown;
  generated_path: string | null;
  generated_output_status: SourceFileGeneratedOutputStatus;
  processing_started_at: Date | null;
  processing_ended_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type ResourceCursor = {
  version: 1;
  scope: string;
  logicalPath: string;
  publicId: string;
};

export type StorageVnextAdminResourceRead = {
  listDirectories(input: {
    knowledgeBaseId: string;
    parentDirectoryId: string | null;
    limit: number;
    cursor: string | null;
  }): Promise<{ items: SourceDirectoryRecord[]; nextCursor: string | null }>;
  getDirectory(input: {
    knowledgeBaseId: string;
    directoryId: string;
  }): Promise<SourceDirectoryRecord | null>;
  listSourceFiles(input: {
    knowledgeBaseId: string;
    directoryId: string | null | undefined;
    filters: SourceResourceFileFilters;
    limit: number;
    cursor: string | null;
  }): Promise<{ items: SourceResourceFileRecord[]; nextCursor: string | null }>;
  getSourceFile(input: {
    knowledgeBaseId: string;
    sourceFileId: string;
  }): Promise<SourceResourceFileRecord | null>;
};

export function createPostgresStorageVnextAdminResourceRead(
  sql: DatabaseClient
): StorageVnextAdminResourceRead {
  return {
    async listDirectories(input) {
      const limit = assertLimit(input.limit);
      const scope = cursorScope("directories", input);
      const rows = await readDirectories(sql, {
        ...input,
        cursor: decodeCursor(input.cursor, scope),
        limit: limit + 1,
        directoryId: null
      });
      return page(rows, limit, scope, mapDirectory);
    },
    async getDirectory(input) {
      const rows = await readDirectories(sql, {
        ...input,
        parentDirectoryId: null,
        cursor: null,
        limit: 1,
        directoryId: input.directoryId
      });
      return rows[0] ? mapDirectory(rows[0]) : null;
    },
    async listSourceFiles(input) {
      const limit = assertLimit(input.limit);
      const scope = cursorScope("source-files", input);
      const rows = await readSourceFiles(sql, {
        ...input,
        cursor: decodeCursor(input.cursor, scope),
        limit: limit + 1,
        sourceFileId: null
      });
      return page(rows, limit, scope, mapSourceFile);
    },
    async getSourceFile(input) {
      const rows = await readSourceFiles(sql, {
        ...input,
        directoryId: undefined,
        filters: emptyFilters(),
        cursor: null,
        limit: 1,
        sourceFileId: input.sourceFileId
      });
      return rows[0] ? mapSourceFile(rows[0]) : null;
    }
  };
}

async function readDirectories(
  sql: DatabaseClient,
  input: {
    knowledgeBaseId: string;
    parentDirectoryId: string | null;
    directoryId: string | null;
    cursor: ResourceCursor | null;
    limit: number;
  }
) {
  return sql<DirectoryRow[]>`
    SELECT directory.public_id, directory.knowledge_base_id,
           directory.parent_public_id, directory.logical_path,
           directory.revision, directory.created_at, directory.updated_at,
           (SELECT count(*) FROM focowiki.source_files source
            WHERE source.knowledge_base_id = directory.knowledge_base_id
              AND source.directory_public_id = directory.public_id
              AND source.deleted_at IS NULL) AS direct_file_count,
           (SELECT count(*) FROM focowiki.source_files source
            WHERE source.knowledge_base_id = directory.knowledge_base_id
              AND source.deleted_at IS NULL
              AND source.normalized_path LIKE directory.normalized_path || '/%')
             AS descendant_file_count
    FROM focowiki.source_directories directory
    JOIN focowiki.knowledge_bases knowledge_base
      ON knowledge_base.public_id = directory.knowledge_base_id
     AND knowledge_base.deleted_at IS NULL
    WHERE directory.knowledge_base_id = ${input.knowledgeBaseId}
      AND directory.deleted_at IS NULL
      AND (${input.directoryId}::text IS NULL
        OR directory.public_id = ${input.directoryId})
      AND (${input.directoryId}::text IS NOT NULL
        OR directory.parent_public_id IS NOT DISTINCT FROM ${input.parentDirectoryId})
      AND (${input.cursor?.logicalPath ?? null}::text IS NULL OR
        (directory.logical_path, directory.public_id) >
        (${input.cursor?.logicalPath ?? null}::text,
         ${input.cursor?.publicId ?? null}::text))
    ORDER BY directory.logical_path COLLATE "C", directory.public_id COLLATE "C"
    LIMIT ${input.limit}
  `;
}

async function readSourceFiles(
  sql: DatabaseClient,
  input: {
    knowledgeBaseId: string;
    directoryId: string | null | undefined;
    filters: SourceResourceFileFilters;
    sourceFileId: string | null;
    cursor: ResourceCursor | null;
    limit: number;
  }
) {
  return sql<SourceRow[]>`
    SELECT source.public_id, source.knowledge_base_id,
           source.directory_public_id, source.logical_path,
           revision.public_id AS source_revision_public_id,
           active.active_source_revision_public_id,
           revision.checksum_sha256, revision.byte_count, revision.content_type,
           source.revision AS resource_revision,
           active.activation_sequence AS content_revision,
           job.public_id AS job_public_id, job.state AS job_state,
           job.required_work_count, job.completed_work_count,
           job.active_work_kinds, job.blocking_work_kind,
           job.retrying_work_kind,
           job.safe_error_code, job.safe_error_message, job.retryable,
           job.manual_retry_count AS retry_count,
           job.model_status, job.model_name, job.model_started_at,
           job.model_ended_at, job.model_warning_count, job.model_error_code,
           coalesce((
             SELECT jsonb_agg(jsonb_build_object(
               'layer', execution.layer,
               'status', execution.status,
               'modelName', execution.model_name,
               'selected', execution.selected,
               'reused', execution.reused,
               'providerRequestCount', execution.provider_request_count,
               'providerObservations', execution.provider_observations,
               'waitTimeMs', execution.wait_time_milliseconds,
               'serviceTimeMs', execution.service_time_milliseconds,
               'warningCount', execution.warning_count,
               'errorCode', execution.error_code,
               'startedAt', execution.started_at,
               'endedAt', execution.ended_at
             ) ORDER BY execution.created_at, execution.public_id COLLATE "C")
             FROM focowiki.document_model_layer_executions execution
             WHERE execution.knowledge_base_id = job.knowledge_base_id
               AND execution.document_job_public_id = job.public_id
           ), '[]'::jsonb) AS model_layer_executions,
           generated.logical_path AS generated_path,
           lifecycle.generated_output_status,
           job.started_at AS processing_started_at,
           job.terminal_at AS processing_ended_at,
           source.created_at,
           greatest(source.updated_at, job.updated_at,
             coalesce(generated.updated_at, source.updated_at)) AS updated_at
    FROM focowiki.source_files source
    JOIN focowiki.knowledge_bases knowledge_base
      ON knowledge_base.public_id = source.knowledge_base_id
     AND knowledge_base.deleted_at IS NULL
    JOIN focowiki.source_file_active_revisions active
      ON active.knowledge_base_id = source.knowledge_base_id
     AND active.source_file_public_id = source.public_id
    JOIN focowiki.source_revisions revision
      ON revision.knowledge_base_id = active.knowledge_base_id
     AND revision.source_file_public_id = active.source_file_public_id
     AND revision.public_id = active.current_source_revision_public_id
     AND revision.deleted_at IS NULL
    JOIN focowiki.document_processing_jobs job
      ON job.knowledge_base_id = source.knowledge_base_id
     AND job.source_file_public_id = source.public_id
     AND job.source_revision_public_id = active.current_source_revision_public_id
    LEFT JOIN focowiki.generated_page_heads generated
      ON generated.knowledge_base_id = source.knowledge_base_id
     AND generated.source_file_public_id = source.public_id
     AND generated.source_revision_public_id = active.active_source_revision_public_id
     AND generated.entry_kind = 'source'
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN job.state = 'available'
          AND active.active_source_revision_public_id = revision.public_id
          AND generated.logical_path IS NOT NULL THEN 'current_available'
        WHEN job.state = 'error'
          AND active.active_source_revision_public_id IS NOT NULL
          AND active.active_source_revision_public_id <> revision.public_id
          AND generated.logical_path IS NOT NULL THEN 'previous_available'
        ELSE 'unavailable'
      END::text AS generated_output_status
    ) lifecycle
    WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
      AND source.deleted_at IS NULL
      AND (${input.sourceFileId}::text IS NULL
        OR source.public_id = ${input.sourceFileId})
      AND (${input.directoryId === undefined} OR source.directory_public_id
        IS NOT DISTINCT FROM ${input.directoryId ?? null})
      AND (${input.filters.pathQuery ?? null}::text IS NULL OR strpos(
        lower(source.logical_path), lower(${input.filters.pathQuery ?? null})
      ) > 0)
      AND (${input.filters.sourceFileIdPrefix ?? null}::text IS NULL OR
        source.public_id LIKE ${`${input.filters.sourceFileIdPrefix ?? ""}%`})
      AND (${input.filters.state ?? null}::text IS NULL
        OR job.state = ${input.filters.state ?? null})
      AND (${input.filters.blockingWorkKind ?? null}::text IS NULL
        OR job.blocking_work_kind = ${input.filters.blockingWorkKind ?? null})
      AND (${input.filters.currentStage ?? null}::text IS NULL
        OR (job.state IN ('waiting', 'processing')
          AND job.blocking_work_kind = ${input.filters.currentStage ?? null})
        OR ((job.state NOT IN ('waiting', 'processing')
            OR job.blocking_work_kind IS NULL)
          AND job.state = ${input.filters.currentStage ?? null}))
      AND (${input.filters.modelInvocationStatus ?? null}::text IS NULL
        OR (${input.filters.modelInvocationStatus ?? null} = 'not_recorded'
          AND job.model_status IS NULL)
        OR job.model_status = ${input.filters.modelInvocationStatus ?? null})
      AND (${input.filters.generatedOutputStatus ?? null}::text IS NULL
        OR lifecycle.generated_output_status
          = ${input.filters.generatedOutputStatus ?? null})
      AND (${input.filters.startedFrom ?? null}::timestamptz IS NULL
        OR job.started_at >= ${input.filters.startedFrom ?? null})
      AND (${input.filters.startedTo ?? null}::timestamptz IS NULL
        OR job.started_at <= ${input.filters.startedTo ?? null})
      AND (${input.filters.endedFrom ?? null}::timestamptz IS NULL
        OR job.terminal_at >= ${input.filters.endedFrom ?? null})
      AND (${input.filters.endedTo ?? null}::timestamptz IS NULL
        OR job.terminal_at <= ${input.filters.endedTo ?? null})
      AND (${input.filters.errorState ?? null}::text IS NULL
        OR (${input.filters.errorState ?? null} = 'with_error'
          AND job.state = 'error')
        OR (${input.filters.errorState ?? null} = 'without_error'
          AND job.state <> 'error'))
      AND (${input.filters.errorCodeQuery ?? null}::text IS NULL OR strpos(
        lower(coalesce(job.safe_error_code, '')),
        lower(${input.filters.errorCodeQuery ?? null})
      ) > 0)
      AND (${input.filters.actionState ?? null}::text IS NULL
        OR (${input.filters.actionState ?? null} = 'openable'
          AND lifecycle.generated_output_status IN (
            'current_available', 'previous_available'
          ))
        OR (${input.filters.actionState ?? null} = 'retryable'
          AND job.state = 'error' AND job.retryable)
        OR (${input.filters.actionState ?? null} = 'correctable'
          AND job.state = 'error'
          AND job.safe_error_code IN (
            'semantic_source_body_empty',
            'semantic_source_metadata_invalid',
            'source_body_empty',
            'source_frontmatter_invalid'
          ))
        OR (${input.filters.actionState ?? null} = 'details_only'
          AND job.state = 'error' AND NOT job.retryable
          AND coalesce(job.safe_error_code, '') NOT IN (
            'semantic_source_body_empty',
            'semantic_source_metadata_invalid',
            'source_body_empty',
            'source_frontmatter_invalid'
          ))
        OR (${input.filters.actionState ?? null} = 'none'
          AND lifecycle.generated_output_status = 'unavailable'
          AND job.state <> 'error'))
      AND (${input.cursor?.logicalPath ?? null}::text IS NULL OR
        (source.logical_path, source.public_id) >
        (${input.cursor?.logicalPath ?? null}::text,
         ${input.cursor?.publicId ?? null}::text))
    ORDER BY source.logical_path COLLATE "C", source.public_id COLLATE "C"
    LIMIT ${input.limit}
  `;
}

function mapDirectory(row: DirectoryRow): SourceDirectoryRecord {
  return {
    id: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    parentDirectoryId: row.parent_public_id,
    name: nameOf(row.logical_path),
    relativePath: row.logical_path,
    depth: row.logical_path.split("/").length,
    resourceRevision: count(row.revision),
    directFileCount: count(row.direct_file_count),
    descendantFileCount: count(row.descendant_file_count),
    deleting: false,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapSourceFile(row: SourceRow): SourceResourceFileRecord {
  const state = documentState(row.job_state);
  const startedAt = row.processing_started_at?.toISOString() ?? null;
  const terminalAt = row.processing_ended_at?.toISOString() ?? null;
  const failure = row.job_state === "error" ? {
    workKind: row.blocking_work_kind ?? row.retrying_work_kind ?? "prepare",
    code: row.safe_error_code ?? "DOCUMENT_PROCESSING_FAILED",
    message: row.safe_error_message ?? "Document processing failed.",
    occurredAt: row.processing_ended_at?.toISOString()
      ?? row.updated_at.toISOString(),
    retryKind: row.retryable ? "document_processing" as const : "none" as const,
    correlationId: row.job_public_id
  } : null;
  return {
    id: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    directoryId: row.directory_public_id,
    name: nameOf(row.logical_path),
    relativePath: row.logical_path,
    contentType: row.content_type,
    sizeBytes: count(row.byte_count),
    checksumSha256: row.checksum_sha256,
    resourceRevision: count(row.resource_revision),
    contentRevision: count(row.content_revision),
    activeRevisionId: row.active_source_revision_public_id ?? "",
    retryCount: count(row.retry_count),
    processingStatus: state,
    requiredWorkCount: count(row.required_work_count),
    completedWorkCount: count(row.completed_work_count),
    activeWorkKinds: workKinds(row.active_work_kinds),
    blockingWorkKind: row.blocking_work_kind,
    retryingWorkKind: row.retrying_work_kind,
    terminalFailure: failure,
    generatedOutputStatus: row.generated_output_status,
    generatedPath: row.generated_path,
    modelInvocationStatus: row.model_status,
    modelInvocationModelName: row.model_name,
    modelInvocationStartedAt: row.model_started_at?.toISOString() ?? null,
    modelInvocationEndedAt: row.model_ended_at?.toISOString() ?? null,
    modelInvocationWarningCount: row.model_warning_count === null
      ? null : count(row.model_warning_count),
    modelInvocationErrorCode: row.model_error_code,
    modelLayerExecutions: modelLayerExecutions(row.model_layer_executions),
    processingStartedAt: startedAt,
    processingEndedAt: terminalAt,
    deleting: state === "deleting",
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function modelLayerExecutions(value: unknown): NonNullable<
  SourceResourceFileRecord["modelLayerExecutions"]
> {
  if (!Array.isArray(value)) throw new Error("Stored model layer executions are invalid");
  return value.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new Error("Stored model layer execution is invalid");
    }
    const row = item as Record<string, unknown>;
    const layer = row.layer;
    const status = row.status;
    if (!["first_layer", "candidate_delta", "graphrag"].includes(String(layer))
      || !["running", "completed", "failed"].includes(String(status))
      || typeof row.modelName !== "string"
      || typeof row.reused !== "boolean"
      || !(typeof row.selected === "boolean" || row.selected === null)
      || !Number.isSafeInteger(Number(row.providerRequestCount))
      || !Number.isSafeInteger(Number(row.waitTimeMs))
      || !Number.isSafeInteger(Number(row.serviceTimeMs))
      || !Number.isSafeInteger(Number(row.warningCount))
      || typeof row.startedAt !== "string"
      || !(typeof row.endedAt === "string" || row.endedAt === null)
      || !(typeof row.errorCode === "string" || row.errorCode === null)) {
      throw new Error("Stored model layer execution is invalid");
    }
    return {
      layer: layer as "first_layer" | "candidate_delta" | "graphrag",
      status: status as "running" | "completed" | "failed",
      modelName: row.modelName,
      selected: row.selected,
      reused: row.reused,
      providerRequestCount: Number(row.providerRequestCount),
      waitTimeMs: Number(row.waitTimeMs),
      serviceTimeMs: Number(row.serviceTimeMs),
      providerObservations: modelProviderObservations(row.providerObservations),
      warningCount: Number(row.warningCount),
      errorCode: row.errorCode,
      startedAt: row.startedAt,
      endedAt: row.endedAt
    };
  });
}

function modelProviderObservations(value: unknown): NonNullable<
  SourceResourceFileRecord["modelLayerExecutions"]
>[number]["providerObservations"] {
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error("Stored model provider observations are invalid");
  }
  return value.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new Error("Stored model provider observation is invalid");
    }
    const row = item as Record<string, unknown>;
    const apiMode = String(row.apiMode);
    const structuredOutputCapability = String(row.structuredOutputCapability);
    const errorClass = String(row.errorClass);
    if (!["responses", "chat_completions"].includes(apiMode)
      || !["native_json_schema", "json_object_compatibility", "unknown"]
        .includes(structuredOutputCapability)
      || !["none", "refusal", "incomplete", "schema_validation", "transient", "provider"]
        .includes(errorClass)
      || !Number.isSafeInteger(Number(row.attempt))
      || typeof row.repair !== "boolean"
      || !(typeof row.requestId === "string" || row.requestId === null)
      || !(typeof row.finishState === "string" || row.finishState === null)
      || ![row.inputTokens, row.outputTokens, row.cachedInputTokens]
        .every((count) => count === null || Number.isSafeInteger(Number(count)))
      || !Number.isSafeInteger(Number(row.serviceTimeMs))) {
      throw new Error("Stored model provider observation is invalid");
    }
    return {
      apiMode: apiMode as "responses" | "chat_completions",
      structuredOutputCapability: structuredOutputCapability as
        "native_json_schema" | "json_object_compatibility" | "unknown",
      attempt: Number(row.attempt),
      repair: row.repair,
      requestId: row.requestId as string | null,
      finishState: row.finishState as string | null,
      inputTokens: row.inputTokens === null ? null : Number(row.inputTokens),
      outputTokens: row.outputTokens === null ? null : Number(row.outputTokens),
      cachedInputTokens: row.cachedInputTokens === null
        ? null : Number(row.cachedInputTokens),
      serviceTimeMs: Number(row.serviceTimeMs),
      errorClass: errorClass as
        "none" | "refusal" | "incomplete" | "schema_validation" | "transient" | "provider"
    };
  });
}

function documentState(value: string): SourceFileLifecycleState {
  if ([
    "waiting", "processing", "available", "error", "deleting"
  ].includes(value)) return value as SourceFileLifecycleState;
  throw new Error("Stored document state is invalid");
}

function workKinds(value: unknown): SourceFileWorkKind[] {
  if (!Array.isArray(value) || !value.every(isSourceFileWorkKind)) {
    throw new Error("Stored active document work kinds are invalid");
  }
  return value;
}

function isSourceFileWorkKind(value: unknown): value is SourceFileWorkKind {
  return typeof value === "string" && [
    "prepare", "first_layer", "content_projection", "graphrag",
    "relation_reconcile", "knowledge_projection", "activate", "cleanup"
  ].includes(value);
}

function emptyFilters(): SourceResourceFileFilters {
  return {
    pathQuery: null,
    sourceFileIdPrefix: null,
    state: null,
    blockingWorkKind: null,
    generatedOutputStatus: null,
    modelInvocationStatus: null,
    startedFrom: null,
    startedTo: null,
    endedFrom: null,
    endedTo: null,
    errorState: null,
    errorCodeQuery: null,
    actionState: null
  };
}

function page<TRow extends { logical_path: string; public_id: string }, T>(
  rows: TRow[],
  limit: number,
  scope: string,
  map: (row: TRow) => T
) {
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(map),
    nextCursor: rows.length > limit && last ? encodeCursor({
      version: 1,
      scope,
      logicalPath: last.logical_path,
      publicId: last.public_id
    }) : null
  };
}

function cursorScope(kind: string, input: object): string {
  const queryIdentity = Object.fromEntries(Object.entries(input)
    .filter(([field]) => field !== "cursor" && field !== "limit"));
  return createHash("sha256")
    .update(JSON.stringify({ kind, ...queryIdentity })).digest("hex");
}

function encodeCursor(cursor: ResourceCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(cursor: string | null, scope: string): ResourceCursor | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8")
    ) as Partial<ResourceCursor>;
    if (value.version !== 1 || value.scope !== scope || !value.logicalPath
      || !value.publicId) throw new Error("invalid cursor");
    return value as ResourceCursor;
  } catch {
    throw new SourceResourceError("INVALID_PAGINATION");
  }
}

function assertLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 200) {
    throw new SourceResourceError("INVALID_PAGINATION");
  }
  return value;
}

function count(value: number | string): number {
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : 0;
}

function nameOf(path: string): string {
  return path.split("/").at(-1) ?? path;
}
