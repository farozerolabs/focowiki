import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import type { SourceFileFailureStage } from "../../domain/source-file-lifecycle.js";
import type {
  StorageVnextSourceEventRepository,
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
  sequence_number: number | string;
  stage_key: SourceFileFailureStage;
  message_key: string;
  started_at: Date | string | null;
  ended_at: Date | string | null;
  severity: StorageVnextSourceEventSeverity;
  created_at: Date | string;
  expires_at: Date | string;
};

type SourceEventCursor = {
  version: 1;
  knowledgeBaseId: string;
  sourceFileId: string;
  createdAt: string;
  sequence: number;
  publicId: string;
};

type ReadSql = DatabaseClient | TransactionSql;

const SOURCE_EVENT_STAGES: readonly SourceFileFailureStage[] = [
  "upload_storage",
  "metadata_resolution",
  "llm_suggestion",
  "graph_generation",
  "graphrag_processing",
  "semantic_reconciliation",
  "embedding_generation",
  "affected_projection",
  "search_publication",
  "semantic_maintenance_required",
  "projection_generation",
  "generation_validation",
  "generation_activation"
];
const SOURCE_EVENT_SEVERITIES: readonly StorageVnextSourceEventSeverity[] = [
  "info",
  "warning",
  "error"
];

export function createPostgresStorageVnextSourceEventRepository(
  sql: DatabaseClient
): StorageVnextSourceEventRepository {
  return {
    async record(event) {
      assertEvent(event);
      await sql.begin(async (transaction) => {
        await closeEarlierOpenEvents(transaction, event);
        const inserted = await transaction<Array<{ public_id: string }>>`
          INSERT INTO focowiki.source_event_summaries
            (public_id, knowledge_base_id, source_file_public_id,
             source_revision_public_id, sequence_number, stage_key, message_key,
             started_at, ended_at, severity, created_at, expires_at)
          VALUES
            (${event.publicId}, ${event.knowledgeBaseId}, ${event.sourceFilePublicId},
             ${event.sourceRevisionPublicId}, ${event.sequence}, ${event.stageKey},
             ${event.messageKey}, ${event.startedAt}, ${event.endedAt},
             ${event.severity}, ${event.createdAt}, ${event.expiresAt})
          ON CONFLICT (public_id) DO NOTHING
          RETURNING public_id
        `;
        if (inserted.length === 1) return;
        const existing = await readEvent(transaction, event.publicId);
        if (!existing || !sameRecordedEvent(existing, event)) {
          throw repositoryError("event_conflict");
        }
      });
    },

    async list(input) {
      assertIdentifier(input.knowledgeBaseId);
      assertIdentifier(input.sourceFileId);
      const limit = assertLimit(input.limit);
      const cursor = decodeCursor(input.cursor, input);
      const rows = await sql<SourceEventRow[]>`
        SELECT public_id, knowledge_base_id, source_file_public_id,
               source_revision_public_id, sequence_number, stage_key, message_key,
               started_at, ended_at, severity, created_at, expires_at
        FROM focowiki.source_event_summaries
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_file_public_id = ${input.sourceFileId}
          AND expires_at > now()
          AND (
            ${cursor?.createdAt ?? null}::timestamptz IS NULL
            OR (created_at, sequence_number, public_id) >
               (${cursor?.createdAt ?? null}::timestamptz,
                ${cursor?.sequence ?? null}::smallint,
                ${cursor?.publicId ?? null}::text)
          )
        ORDER BY created_at, sequence_number, public_id
        LIMIT ${limit + 1}
      `;
      const items = rows.slice(0, limit).map(mapEvent);
      const last = items.at(-1);
      return {
        items,
        nextCursor: rows.length > limit && last
          ? encodeCursor({
              version: 1,
              knowledgeBaseId: input.knowledgeBaseId,
              sourceFileId: input.sourceFileId,
              createdAt: last.createdAt,
              sequence: last.sequence,
              publicId: last.publicId
            })
          : null
      };
    }
  };
}

async function closeEarlierOpenEvents(
  sql: ReadSql,
  event: StorageVnextSourceEventSummary
): Promise<void> {
  await sql`
    UPDATE focowiki.source_event_summaries
    SET ended_at = ${event.createdAt}
    WHERE knowledge_base_id = ${event.knowledgeBaseId}
      AND source_file_public_id = ${event.sourceFilePublicId}
      AND ended_at IS NULL
      AND (created_at, sequence_number, public_id) <
          (${event.createdAt}::timestamptz, ${event.sequence}::smallint, ${event.publicId})
  `;
}

async function readEvent(sql: ReadSql, publicId: string) {
  const rows = await sql<SourceEventRow[]>`
    SELECT public_id, knowledge_base_id, source_file_public_id,
           source_revision_public_id, sequence_number, stage_key, message_key,
           started_at, ended_at, severity, created_at, expires_at
    FROM focowiki.source_event_summaries
    WHERE public_id = ${publicId}
    LIMIT 1
  `;
  return rows[0] ? mapEvent(rows[0]) : null;
}

function mapEvent(row: SourceEventRow): StorageVnextSourceEventSummary {
  if (!SOURCE_EVENT_STAGES.includes(row.stage_key)) throw repositoryError("event_conflict");
  if (!SOURCE_EVENT_SEVERITIES.includes(row.severity)) throw repositoryError("event_conflict");
  return {
    publicId: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    sourceFilePublicId: row.source_file_public_id,
    sourceRevisionPublicId: row.source_revision_public_id,
    sequence: safeInteger(row.sequence_number),
    stageKey: row.stage_key,
    messageKey: row.message_key,
    startedAt: nullableTimestamp(row.started_at),
    endedAt: nullableTimestamp(row.ended_at),
    severity: row.severity,
    createdAt: timestamp(row.created_at),
    expiresAt: timestamp(row.expires_at)
  };
}

function assertEvent(event: StorageVnextSourceEventSummary): void {
  assertIdentifier(event.publicId);
  assertIdentifier(event.knowledgeBaseId);
  assertIdentifier(event.sourceFilePublicId);
  assertIdentifier(event.sourceRevisionPublicId);
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || event.sequence > 100) {
    throw repositoryError("invalid_input");
  }
  if (!SOURCE_EVENT_STAGES.includes(event.stageKey)) throw repositoryError("invalid_input");
  if (!SOURCE_EVENT_SEVERITIES.includes(event.severity)) throw repositoryError("invalid_input");
  assertText(event.messageKey, 255);
  const createdAt = assertTimestamp(event.createdAt);
  const expiresAt = assertTimestamp(event.expiresAt);
  if (event.startedAt !== null) assertTimestamp(event.startedAt);
  if (event.endedAt !== null) assertTimestamp(event.endedAt);
  if (
    event.startedAt !== null
    && event.endedAt !== null
    && Date.parse(event.endedAt) < Date.parse(event.startedAt)
  ) {
    throw repositoryError("invalid_input");
  }
  if (expiresAt.getTime() <= createdAt.getTime()) throw repositoryError("invalid_input");
}

function sameRecordedEvent(
  stored: StorageVnextSourceEventSummary,
  requested: StorageVnextSourceEventSummary
): boolean {
  return stored.publicId === requested.publicId
    && stored.knowledgeBaseId === requested.knowledgeBaseId
    && stored.sourceFilePublicId === requested.sourceFilePublicId
    && stored.sourceRevisionPublicId === requested.sourceRevisionPublicId
    && stored.sequence === requested.sequence
    && stored.stageKey === requested.stageKey
    && stored.messageKey === requested.messageKey
    && stored.startedAt === requested.startedAt
    && (stored.endedAt === requested.endedAt || requested.endedAt === null)
    && stored.severity === requested.severity
    && stored.createdAt === requested.createdAt
    && stored.expiresAt === requested.expiresAt;
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
    if (
      parsed.version !== 1
      || parsed.knowledgeBaseId !== scope.knowledgeBaseId
      || parsed.sourceFileId !== scope.sourceFileId
      || typeof parsed.publicId !== "string"
      || !Number.isSafeInteger(parsed.sequence)
    ) {
      throw repositoryError("invalid_cursor");
    }
    assertIdentifier(parsed.publicId);
    assertTimestamp(parsed.createdAt);
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
  assertText(value, 255);
}

function assertText(value: string, maximumBytes: number): void {
  if (!value || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw repositoryError("invalid_input");
  }
}

function assertTimestamp(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw repositoryError("invalid_input");
  }
  return parsed;
}

function nullableTimestamp(value: Date | string | null): string | null {
  return value === null ? null : timestamp(value);
}

function timestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw repositoryError("event_conflict");
  return parsed.toISOString();
}

function safeInteger(value: number | string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw repositoryError("event_conflict");
  return number;
}

function repositoryError(
  code: StorageVnextSourceEventRepositoryErrorCode
): StorageVnextSourceEventRepositoryError {
  return new StorageVnextSourceEventRepositoryError(code);
}
