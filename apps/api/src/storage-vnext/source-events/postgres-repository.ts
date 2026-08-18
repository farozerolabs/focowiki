import type { DatabaseClient } from "../../db/client.js";
import type {
  StorageVnextSourceEventReadPort,
  StorageVnextSourceEventSeverity,
  StorageVnextSourceEventSummary
} from "./ports.js";

export type StorageVnextSourceEventRepositoryErrorCode =
  | "invalid_input"
  | "invalid_cursor"
  | "event_conflict";

export class StorageVnextSourceEventRepositoryError extends Error {
  public constructor(public readonly code: StorageVnextSourceEventRepositoryErrorCode) {
    super(`Storage vNext source event repository error: ${code}`);
    this.name = "StorageVnextSourceEventRepositoryError";
  }
}

type SourceEventRow = {
  public_id: string;
  knowledge_base_id: string;
  source_file_public_id: string;
  source_revision_public_id: string;
  state: string;
  blocking_work_kind: string | null;
  total_attempt_count: number | string;
  started_at: Date | string | null;
  terminal_at: Date | string | null;
  safe_error_code: string | null;
  accepted_at: Date | string;
  expires_at: Date | string;
};

type SourceEventCursor = {
  version: 2;
  knowledgeBaseId: string;
  sourceFileId: string;
  acceptedAt: string;
  publicId: string;
};

export function createPostgresStorageVnextSourceEventRepository(
  sql: DatabaseClient
): StorageVnextSourceEventReadPort {
  return {
    async list(input) {
      assertIdentifier(input.knowledgeBaseId);
      assertIdentifier(input.sourceFileId);
      const limit = assertLimit(input.limit);
      const cursor = decodeCursor(input.cursor, input);
      const rows = await sql<SourceEventRow[]>`
        SELECT job.public_id, job.knowledge_base_id,
               job.source_file_public_id, job.source_revision_public_id,
               job.state, job.blocking_work_kind, job.total_attempt_count,
               job.started_at, job.terminal_at, job.safe_error_code,
               job.accepted_at,
               coalesce(
                 (SELECT max(idempotency.expires_at)
                  FROM focowiki.operation_idempotency idempotency
                  WHERE idempotency.knowledge_base_id = job.knowledge_base_id
                    AND idempotency.operation_public_id = job.operation_public_id),
                 job.accepted_at + interval '30 days'
               ) AS expires_at
        FROM focowiki.document_processing_jobs job
        WHERE job.knowledge_base_id = ${input.knowledgeBaseId}
          AND job.source_file_public_id = ${input.sourceFileId}
          AND (
            ${cursor?.acceptedAt ?? null}::timestamptz IS NULL
            OR (job.accepted_at, job.public_id COLLATE "C") >
               (${cursor?.acceptedAt ?? null}::timestamptz,
                ${cursor?.publicId ?? null}::text COLLATE "C")
          )
        ORDER BY job.accepted_at, job.public_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      const items = rows.slice(0, limit).map(mapEvent);
      const lastRow = rows.slice(0, limit).at(-1);
      return {
        items,
        nextCursor: rows.length > limit && lastRow
          ? encodeCursor({
              version: 2,
              knowledgeBaseId: input.knowledgeBaseId,
              sourceFileId: input.sourceFileId,
              acceptedAt: timestamp(lastRow.accepted_at),
              publicId: lastRow.public_id
            })
          : null
      };
    }
  };
}

function mapEvent(row: SourceEventRow): StorageVnextSourceEventSummary {
  const stageKey = documentStage(row.state, row.blocking_work_kind);
  const severity: StorageVnextSourceEventSeverity = row.state === "error"
    ? "error" : "info";
  return {
    publicId: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    sourceFilePublicId: row.source_file_public_id,
    sourceRevisionPublicId: row.source_revision_public_id,
    sequence: boundedSequence(row.total_attempt_count),
    stageKey,
    messageKey: row.safe_error_code
      ? `sourceFiles.errors.${row.safe_error_code}`
      : `sourceFiles.document.${stageKey}`,
    startedAt: nullableTimestamp(row.started_at),
    endedAt: nullableTimestamp(row.terminal_at),
    severity,
    createdAt: timestamp(row.accepted_at),
    expiresAt: timestamp(row.expires_at)
  };
}

function documentStage(state: string, workKind: string | null): string {
  if (state === "processing") {
    if ([
      "prepare", "first_layer", "content_projection", "graphrag",
      "relation_reconcile", "knowledge_projection", "activate", "cleanup"
    ].includes(workKind ?? "")) {
      return workKind!;
    }
    throw repositoryError("event_conflict");
  }
  if ([
    "waiting", "available", "error", "deleting", "cancelled", "superseded"
  ].includes(state)) return state;
  throw repositoryError("event_conflict");
}

function boundedSequence(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw repositoryError("event_conflict");
  }
  return Math.min(parsed + 1, Number.MAX_SAFE_INTEGER);
}

function encodeCursor(cursor: SourceEventCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(
  value: string | null,
  scope: { knowledgeBaseId: string; sourceFileId: string }
): SourceEventCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as SourceEventCursor;
    if (parsed.version !== 2
      || parsed.knowledgeBaseId !== scope.knowledgeBaseId
      || parsed.sourceFileId !== scope.sourceFileId
      || typeof parsed.publicId !== "string") {
      throw repositoryError("invalid_cursor");
    }
    assertIdentifier(parsed.publicId);
    assertTimestamp(parsed.acceptedAt);
    return parsed;
  } catch (error) {
    if (error instanceof StorageVnextSourceEventRepositoryError) throw error;
    throw repositoryError("invalid_cursor");
  }
}

function assertLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw repositoryError("invalid_input");
  }
  return value;
}

function assertIdentifier(value: string): void {
  if (!value || Buffer.byteLength(value, "utf8") > 255) {
    throw repositoryError("invalid_input");
  }
}

function assertTimestamp(value: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw repositoryError("invalid_input");
  }
}

function nullableTimestamp(value: Date | string | null): string | null {
  return value === null ? null : timestamp(value);
}

function timestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw repositoryError("event_conflict");
  return parsed.toISOString();
}

function repositoryError(
  code: StorageVnextSourceEventRepositoryErrorCode
): StorageVnextSourceEventRepositoryError {
  return new StorageVnextSourceEventRepositoryError(code);
}
