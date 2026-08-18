import type { DatabaseClient } from "../../db/client.js";
import type {
  ResourceOperationKind,
  ResourceOperationRecord,
  ResourceOperationState
} from "../../domain/source-resource.js";
import { SourceResourceError } from "../../domain/source-resource.js";

type OperationRow = {
  public_id: string;
  knowledge_base_id: string;
  operation_kind: string;
  state: string;
  expected_resource_revision: number | string | null;
  target_kind: "source_file" | "source_directory" | "knowledge_base" | null;
  target_public_id: string | null;
  candidate_relative_path: string | null;
  result_summary: unknown;
  result_code: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  document_total_count: number | string;
  document_waiting_count: number | string;
  document_processing_count: number | string;
  document_available_count: number | string;
  document_error_count: number | string;
  document_deleting_count: number | string;
  document_cancelled_count: number | string;
  document_superseded_count: number | string;
};

type OperationCursor = { version: 1; createdAt: string; publicId: string };

export type StorageVnextOperationRead = {
  list(input: {
    knowledgeBaseId: string;
    states?: ResourceOperationState[];
    limit: number;
    cursor: string | null;
  }): Promise<{ items: ResourceOperationRecord[]; nextCursor: string | null }>;
  get(input: {
    knowledgeBaseId: string;
    operationId: string;
  }): Promise<ResourceOperationRecord | null>;
};

export function createPostgresStorageVnextOperationRead(
  sql: DatabaseClient
): StorageVnextOperationRead {
  return {
    async list(input) {
      const limit = assertLimit(input.limit);
      const cursor = decodeCursor(input.cursor);
      const providerStates = input.states?.flatMap(toProviderStates) ?? null;
      const rows = await sql<OperationRow[]>`
        SELECT operation.public_id, operation.knowledge_base_id,
               operation.operation_kind, operation.state,
               operation.expected_resource_revision, operation.target_kind,
               operation.target_public_id, operation.candidate_relative_path,
               result.result_summary, result.result_code,
               operation.created_at, operation.updated_at, operation.completed_at,
               coalesce(progress.total_count, 0) AS document_total_count,
               coalesce(progress.waiting_count, 0) AS document_waiting_count,
               coalesce(progress.processing_count, 0) AS document_processing_count,
               coalesce(progress.available_count, 0) AS document_available_count,
               coalesce(progress.error_count, 0) AS document_error_count,
               coalesce(progress.deleting_count, 0) AS document_deleting_count,
               coalesce(progress.cancelled_count, 0) AS document_cancelled_count,
               coalesce(progress.superseded_count, 0) AS document_superseded_count
        FROM focowiki.operations operation
        LEFT JOIN focowiki.operation_results result
          ON result.knowledge_base_id = operation.knowledge_base_id
         AND result.public_id = operation.public_id
        LEFT JOIN LATERAL (
          SELECT count(*) AS total_count,
                 count(*) FILTER (WHERE job.state = 'waiting') AS waiting_count,
                 count(*) FILTER (WHERE job.state = 'processing') AS processing_count,
                 count(*) FILTER (WHERE job.state = 'available') AS available_count,
                 count(*) FILTER (WHERE job.state = 'error') AS error_count,
                 count(*) FILTER (WHERE job.state = 'deleting') AS deleting_count,
                 count(*) FILTER (WHERE job.state = 'cancelled') AS cancelled_count,
                 count(*) FILTER (WHERE job.state = 'superseded') AS superseded_count
          FROM focowiki.document_processing_jobs job
          WHERE job.knowledge_base_id = operation.knowledge_base_id
            AND job.operation_public_id = operation.public_id
        ) progress ON operation.operation_kind IN ('upload', 'source_directory_move')
        WHERE operation.knowledge_base_id = ${input.knowledgeBaseId}
          AND operation.operation_kind IN (
            'upload', 'knowledge_base_metadata', 'source_file_metadata', 'source_replace',
            'source_file_move', 'source_directory_move', 'deletion'
          )
          AND (${providerStates}::text[] IS NULL OR operation.state = ANY(${providerStates}))
          AND (
            ${cursor?.createdAt ?? null}::timestamptz IS NULL
            OR (operation.created_at, operation.public_id) <
               (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.publicId ?? null}::text)
          )
        ORDER BY operation.created_at DESC, operation.public_id DESC
        LIMIT ${limit + 1}
      `;
      const pageRows = rows.slice(0, limit);
      const last = pageRows.at(-1);
      return {
        items: pageRows.map(mapOperation),
        nextCursor: rows.length > limit && last
          ? encodeCursor({
              version: 1,
              createdAt: last.created_at.toISOString(),
              publicId: last.public_id
            })
          : null
      };
    },

    async get(input) {
      const rows = await sql<OperationRow[]>`
        SELECT operation.public_id, operation.knowledge_base_id,
               operation.operation_kind, operation.state,
               operation.expected_resource_revision, operation.target_kind,
               operation.target_public_id, operation.candidate_relative_path,
               result.result_summary, result.result_code,
               operation.created_at, operation.updated_at, operation.completed_at,
               coalesce(progress.total_count, 0) AS document_total_count,
               coalesce(progress.waiting_count, 0) AS document_waiting_count,
               coalesce(progress.processing_count, 0) AS document_processing_count,
               coalesce(progress.available_count, 0) AS document_available_count,
               coalesce(progress.error_count, 0) AS document_error_count,
               coalesce(progress.deleting_count, 0) AS document_deleting_count,
               coalesce(progress.cancelled_count, 0) AS document_cancelled_count,
               coalesce(progress.superseded_count, 0) AS document_superseded_count
        FROM focowiki.operations operation
        LEFT JOIN focowiki.operation_results result
          ON result.knowledge_base_id = operation.knowledge_base_id
         AND result.public_id = operation.public_id
        LEFT JOIN LATERAL (
          SELECT count(*) AS total_count,
                 count(*) FILTER (WHERE job.state = 'waiting') AS waiting_count,
                 count(*) FILTER (WHERE job.state = 'processing') AS processing_count,
                 count(*) FILTER (WHERE job.state = 'available') AS available_count,
                 count(*) FILTER (WHERE job.state = 'error') AS error_count,
                 count(*) FILTER (WHERE job.state = 'deleting') AS deleting_count,
                 count(*) FILTER (WHERE job.state = 'cancelled') AS cancelled_count,
                 count(*) FILTER (WHERE job.state = 'superseded') AS superseded_count
          FROM focowiki.document_processing_jobs job
          WHERE job.knowledge_base_id = operation.knowledge_base_id
            AND job.operation_public_id = operation.public_id
        ) progress ON operation.operation_kind IN ('upload', 'source_directory_move')
        WHERE operation.knowledge_base_id = ${input.knowledgeBaseId}
          AND operation.public_id = ${input.operationId}
          AND operation.operation_kind IN (
            'upload', 'knowledge_base_metadata', 'source_file_metadata', 'source_replace',
            'source_file_move', 'source_directory_move', 'deletion'
          )
        LIMIT 1
      `;
      if (rows[0]) return mapOperation(rows[0]);
      const tombstones = await sql<OperationRow[]>`
        SELECT tombstone.public_id, tombstone.knowledge_base_id,
               tombstone.operation_kind, tombstone.state,
               tombstone.expected_resource_revision, tombstone.target_kind,
               tombstone.target_public_id, tombstone.candidate_relative_path,
               tombstone.result_summary, tombstone.result_code,
               tombstone.created_at, tombstone.updated_at,
               tombstone.completed_at,
               0::bigint AS document_total_count,
               0::bigint AS document_waiting_count,
               0::bigint AS document_processing_count,
               0::bigint AS document_available_count,
               0::bigint AS document_error_count,
               0::bigint AS document_deleting_count,
               0::bigint AS document_cancelled_count,
               0::bigint AS document_superseded_count
        FROM focowiki.operation_tombstones tombstone
        WHERE tombstone.knowledge_base_id = ${input.knowledgeBaseId}
          AND tombstone.public_id = ${input.operationId}
          AND tombstone.expires_at > now()
        LIMIT 1
      `;
      return tombstones[0] ? mapOperation(tombstones[0]) : null;
    }
  };
}

function mapOperation(row: OperationRow): ResourceOperationRecord {
  const state = publicState(row.state);
  return {
    id: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    kind: publicKind(row),
    state,
    expectedResourceRevision: row.expected_resource_revision === null
      ? null
      : Number(row.expected_resource_revision),
    result: operationResult(row),
    errorCode: state === "failed" ? row.result_code : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: ["completed", "failed", "cancelled", "superseded"].includes(state)
      ? row.completed_at?.toISOString() ?? null
      : null,
    targetKind: row.target_kind,
    targetId: row.target_public_id,
    candidateRelativePath: row.candidate_relative_path
  };
}

function publicKind(row: OperationRow): ResourceOperationKind {
  if (row.operation_kind === "upload") return "upload";
  if (row.operation_kind === "knowledge_base_metadata") return "knowledge_base_metadata";
  if (row.operation_kind === "source_file_metadata") return "source_file_metadata";
  if (row.operation_kind === "source_replace") return "source_file_replace";
  if (row.operation_kind === "source_file_move") return "source_file_move";
  if (row.operation_kind === "source_directory_move") return "source_directory_move";
  if (row.operation_kind === "deletion") {
    if (row.target_kind === "knowledge_base") return "knowledge_base_delete";
    if (row.target_kind === "source_directory") return "source_directory_delete";
    return "source_file_delete";
  }
  throw new Error("Unsupported public resource operation kind");
}

function operationResult(row: OperationRow): Record<string, unknown> | null {
  const result = record(row.result_summary);
  if (!["upload", "source_directory_move"].includes(row.operation_kind)) {
    return result;
  }
  const persistedUploadProgress = row.operation_kind === "upload"
    && ["completed", "failed", "cancelled", "superseded"].includes(row.state)
    && result !== null
    && [
      "totalCount", "waitingCount", "processingCount", "availableCount",
      "failedCount", "deletingCount", "cancelledCount", "supersededCount"
    ].every((field) => Object.hasOwn(result, field));
  return {
    ...(result ?? {}),
    totalCount: count(persistedUploadProgress
      ? result.totalCount : row.document_total_count),
    waitingCount: count(persistedUploadProgress
      ? result.waitingCount : row.document_waiting_count),
    processingCount: count(persistedUploadProgress
      ? result.processingCount : row.document_processing_count),
    availableCount: count(persistedUploadProgress
      ? result.availableCount : row.document_available_count),
    failedCount: count(persistedUploadProgress
      ? result.failedCount : row.document_error_count),
    deletingCount: count(persistedUploadProgress
      ? result.deletingCount : row.document_deleting_count),
    cancelledCount: count(persistedUploadProgress
      ? result.cancelledCount : row.document_cancelled_count),
    supersededCount: count(persistedUploadProgress
      ? result.supersededCount : row.document_superseded_count)
  };
}

function count(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Invalid document operation progress count");
  }
  return parsed;
}

function publicState(state: string): ResourceOperationState {
  if (state === "timed_out") return "failed";
  if (state === "deleted") return "cancelled";
  if (["accepted", "validating", "processing"].includes(state)) {
    return "processing";
  }
  if ([
    "completed", "failed", "cancelled", "superseded"
  ].includes(state)) return state as ResourceOperationState;
  throw new Error("Invalid storage vNext operation state");
}

function toProviderStates(state: ResourceOperationState): string[] {
  if (state === "processing") return ["accepted", "validating", "processing"];
  if (state === "failed") return ["failed", "timed_out"];
  if (state === "cancelled") return ["cancelled", "deleted"];
  return [state];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function assertLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Invalid storage vNext operation page limit");
  }
  return limit;
}

function encodeCursor(cursor: OperationCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(cursor: string | null): OperationCursor | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<OperationCursor>;
    if (
      value.version !== 1
      || typeof value.createdAt !== "string"
      || !Number.isFinite(Date.parse(value.createdAt))
      || typeof value.publicId !== "string"
      || !value.publicId
    ) throw new Error("invalid");
    return value as OperationCursor;
  } catch {
    throw new SourceResourceError("INVALID_PAGINATION");
  }
}
