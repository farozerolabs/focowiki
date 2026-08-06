import { createHash } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import {
  emptyUploadSessionCounts,
  UploadSessionError,
  type UploadSessionEntryRecord,
  type UploadSessionRecord
} from "../../domain/upload-session.js";

export type StorageVnextUploadSessionRow = {
  public_id: string;
  knowledge_base_id: string;
  operation_public_id: string;
  idempotency_key: string;
  state: "draft" | "uploading" | "finalizing";
  expected_entry_count: number | string;
  expected_byte_count: number | string;
  received_entry_count: number | string;
  received_byte_count: number | string;
  entry_count: number | string;
  upload_required_count: number | string;
  skipped_existing_count: number | string;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
};

export type StorageVnextUploadEntryRow = {
  upload_session_public_id: string;
  entry_public_id: string;
  source_file_public_id: string;
  logical_path: string;
  normalized_path: string;
  checksum_sha256: string | null;
  byte_count: number | string;
  object_id: string | null;
  state: "pending" | "uploaded" | "verified";
  existing_resource_revision: number | string | null;
};

type StorageVnextUploadTerminalRow = {
  public_id: string;
  knowledge_base_id: string;
  correlation_public_id: string;
  terminal_state: "completed" | "failed" | "cancelled" | "superseded" | "timed_out" | "deleted";
  result_code: string;
  result_summary: unknown;
  completed_at: Date;
  expires_at: Date;
};

export async function findIdempotentUploadSession(
  sql: TransactionSql,
  input: { knowledgeBaseId: string; idempotencyKey: string; requestHash: string }
) {
  const rows = await sql<Array<{ request_hash: string; session_public_id: string | null }>>`
    SELECT idempotency.request_hash, session.public_id AS session_public_id
    FROM focowiki.operation_idempotency idempotency
    LEFT JOIN focowiki.upload_sessions session
      ON session.operation_public_id = idempotency.operation_public_id
    WHERE idempotency.knowledge_base_id = ${input.knowledgeBaseId}
      AND idempotency.idempotency_key = ${input.idempotencyKey}
    FOR UPDATE OF idempotency
  `;
  if (!rows[0]) return null;
  if (rows[0].request_hash !== input.requestHash) {
    throw new UploadSessionError("UPLOAD_IDEMPOTENCY_CONFLICT");
  }
  return rows[0].session_public_id;
}

export async function lockUploadSession(
  sql: TransactionSql,
  knowledgeBaseId: string,
  sessionId: string
) {
  const rows = await sql<StorageVnextUploadSessionRow[]>`
    SELECT session.public_id, session.knowledge_base_id, session.operation_public_id,
           idempotency.idempotency_key, session.state, session.expected_entry_count,
           session.expected_byte_count, session.received_entry_count,
           session.received_byte_count, session.expires_at, session.created_at,
           session.updated_at,
           (SELECT count(*) FROM focowiki.upload_entries entry
            WHERE entry.upload_session_public_id = session.public_id) AS entry_count,
           (SELECT count(*) FROM focowiki.upload_entries entry
            WHERE entry.upload_session_public_id = session.public_id
              AND NOT EXISTS (
                SELECT 1 FROM focowiki.source_files source
                WHERE source.knowledge_base_id = entry.knowledge_base_id
                  AND source.public_id = entry.source_file_public_id
                  AND source.normalized_path = entry.normalized_path
                  AND source.deleted_at IS NULL
              )) AS upload_required_count,
           (SELECT count(*) FROM focowiki.upload_entries entry
            WHERE entry.upload_session_public_id = session.public_id
              AND EXISTS (
                SELECT 1 FROM focowiki.source_files source
                WHERE source.knowledge_base_id = entry.knowledge_base_id
                  AND source.public_id = entry.source_file_public_id
                  AND source.normalized_path = entry.normalized_path
                  AND source.deleted_at IS NULL
              )) AS skipped_existing_count
    FROM focowiki.upload_sessions session
    JOIN focowiki.operation_idempotency idempotency
      ON idempotency.operation_public_id = session.operation_public_id
     AND idempotency.knowledge_base_id = session.knowledge_base_id
    WHERE session.knowledge_base_id = ${knowledgeBaseId}
      AND session.public_id = ${sessionId}
    FOR UPDATE OF session
  `;
  if (!rows[0]) throw new UploadSessionError("UPLOAD_SESSION_NOT_FOUND");
  return rows[0];
}

export async function requireUploadSession(
  sql: DatabaseClient,
  knowledgeBaseId: string,
  identity: string
) {
  const rows = await sql<StorageVnextUploadSessionRow[]>`
    SELECT session.public_id, session.knowledge_base_id, session.operation_public_id,
           idempotency.idempotency_key, session.state, session.expected_entry_count,
           session.expected_byte_count, session.received_entry_count,
           session.received_byte_count, session.expires_at, session.created_at,
           session.updated_at,
           (SELECT count(*) FROM focowiki.upload_entries entry
            WHERE entry.upload_session_public_id = session.public_id) AS entry_count,
           (SELECT count(*) FROM focowiki.upload_entries entry
            WHERE entry.upload_session_public_id = session.public_id
              AND NOT EXISTS (
                SELECT 1 FROM focowiki.source_files source
                WHERE source.knowledge_base_id = entry.knowledge_base_id
                  AND source.public_id = entry.source_file_public_id
                  AND source.normalized_path = entry.normalized_path
                  AND source.deleted_at IS NULL
              )) AS upload_required_count,
           (SELECT count(*) FROM focowiki.upload_entries entry
            WHERE entry.upload_session_public_id = session.public_id
              AND EXISTS (
                SELECT 1 FROM focowiki.source_files source
                WHERE source.knowledge_base_id = entry.knowledge_base_id
                  AND source.public_id = entry.source_file_public_id
                  AND source.normalized_path = entry.normalized_path
                  AND source.deleted_at IS NULL
              )) AS skipped_existing_count
    FROM focowiki.upload_sessions session
    JOIN focowiki.operation_idempotency idempotency
      ON idempotency.operation_public_id = session.operation_public_id
     AND idempotency.knowledge_base_id = session.knowledge_base_id
    WHERE session.knowledge_base_id = ${knowledgeBaseId}
      AND (session.public_id = ${identity} OR idempotency.idempotency_key = ${identity})
    LIMIT 1
  `;
  if (rows[0]) return mapUploadSession(rows[0]);
  const terminal = await readUploadTerminal(sql, knowledgeBaseId, identity);
  if (terminal) return mapTerminalUploadSession(terminal);
  throw new UploadSessionError("UPLOAD_SESSION_NOT_FOUND");
}

export async function requireUploadEntry(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; sessionId: string; entryId: string }
) {
  const rows = await sql<StorageVnextUploadEntryRow[]>`
    SELECT entry.upload_session_public_id, entry.entry_public_id,
           entry.source_file_public_id, entry.logical_path,
           entry.normalized_path, entry.checksum_sha256, entry.byte_count,
           entry.object_id, entry.state, source.revision AS existing_resource_revision
    FROM focowiki.upload_entries entry
    JOIN focowiki.upload_sessions session
      ON session.public_id = entry.upload_session_public_id
     AND session.knowledge_base_id = entry.knowledge_base_id
    LEFT JOIN focowiki.source_files source
      ON source.knowledge_base_id = entry.knowledge_base_id
     AND source.public_id = entry.source_file_public_id
     AND source.normalized_path = entry.normalized_path
     AND source.deleted_at IS NULL
    WHERE entry.knowledge_base_id = ${input.knowledgeBaseId}
      AND entry.upload_session_public_id = ${input.sessionId}
      AND entry.entry_public_id = ${input.entryId}
      AND session.state = 'uploading'
  `;
  if (!rows[0]) throw new UploadSessionError("UPLOAD_ENTRY_NOT_FOUND");
  return rows[0];
}

export async function listUploadEntries(
  sql: DatabaseClient,
  input: {
    knowledgeBaseId: string;
    sessionId: string;
    transferState?: "missing" | "failed" | "uploaded";
    limit: number;
    cursor: string | null;
  }
) {
  return readUploadEntries(
    sql,
    input.sessionId,
    input.transferState ?? null,
    input.limit,
    input.cursor
  );
}

export async function readUploadEntries(
  sql: DatabaseClient | TransactionSql,
  sessionId: string,
  transferState: "missing" | "failed" | "uploaded" | null,
  limit: number,
  cursor: string | null
) {
  const state = transferState === "uploaded" ? "verified"
    : transferState === "missing" ? "pending" : null;
  const rows = await sql<StorageVnextUploadEntryRow[]>`
    SELECT entry.upload_session_public_id, entry.entry_public_id,
           entry.source_file_public_id, entry.logical_path, entry.normalized_path,
           entry.checksum_sha256, entry.byte_count, entry.object_id, entry.state,
           source.revision AS existing_resource_revision
    FROM focowiki.upload_entries entry
    LEFT JOIN focowiki.source_files source
      ON source.knowledge_base_id = entry.knowledge_base_id
     AND source.public_id = entry.source_file_public_id
     AND source.normalized_path = entry.normalized_path
     AND source.deleted_at IS NULL
    WHERE entry.upload_session_public_id = ${sessionId}
      AND (${state}::text IS NULL OR entry.state = ${state})
      AND (${cursor}::text IS NULL OR entry.entry_public_id COLLATE "C" > ${cursor} COLLATE "C")
    ORDER BY entry.entry_public_id COLLATE "C"
    LIMIT ${limit + 1}
  `;
  const pageRows = rows.slice(0, limit);
  return {
    items: pageRows.map(mapUploadEntry),
    nextCursor: rows.length > limit ? pageRows.at(-1)?.entry_public_id ?? null : null
  };
}

export async function assertUploadPathsAvailable(
  sql: TransactionSql,
  knowledgeBaseId: string,
  normalizedPaths: string[]
) {
  const rows = await sql<Array<{ conflict: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM focowiki.source_files
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND normalized_path = ANY(${normalizedPaths}) AND deleted_at IS NULL
    ) OR EXISTS (
      SELECT 1 FROM focowiki.upload_path_reservations
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND normalized_path = ANY(${normalizedPaths})
    ) AS conflict
  `;
  if (rows[0]?.conflict) throw new UploadSessionError("UPLOAD_MANIFEST_DUPLICATE_PATH");
}

export function mapUploadEntry(row: StorageVnextUploadEntryRow): UploadSessionEntryRecord {
  const directoryPath = row.logical_path.includes("/")
    ? row.logical_path.slice(0, row.logical_path.lastIndexOf("/"))
    : "";
  const skippedExisting = row.existing_resource_revision !== null;
  return {
    id: row.entry_public_id,
    sessionId: row.upload_session_public_id,
    relativePath: row.logical_path,
    pathKey: row.normalized_path,
    directoryPath,
    name: row.logical_path.split("/").at(-1) ?? row.logical_path,
    declaredSize: uploadCount(row.byte_count),
    receivedSize: row.object_id && !skippedExisting ? uploadCount(row.byte_count) : null,
    checksumSha256: row.checksum_sha256,
    receivedChecksumSha256: row.object_id && !skippedExisting
      ? row.checksum_sha256
      : null,
    disposition: skippedExisting ? "skipped_existing" : "upload_required",
    transferState: skippedExisting
      ? "skipped"
      : row.state === "pending" ? "missing" : "uploaded",
    stagingObjectKey: null,
    sourceDirectoryId: null,
    sourceFileId: row.source_file_public_id,
    existingResourceRevision: skippedExisting
      ? uploadCount(row.existing_resource_revision!)
      : null,
    generatedPath: row.logical_path,
    errorCode: null
  };
}

export function normalizeUploadChecksum(value: string | null): string | null {
  if (value === null) return null;
  const checksum = value.trim().toLocaleLowerCase("en-US");
  if (!/^[0-9a-f]{64}$/u.test(checksum)) {
    throw new UploadSessionError("UPLOAD_ENTRY_CHECKSUM_MISMATCH");
  }
  return checksum;
}

export function uploadChecksumJson(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function uploadCount(value: number | string) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid upload count");
  return count;
}

async function readUploadTerminal(
  sql: DatabaseClient,
  knowledgeBaseId: string,
  identity: string
) {
  const rows = await sql<StorageVnextUploadTerminalRow[]>`
    SELECT result.public_id, result.knowledge_base_id, result.correlation_public_id,
           result.terminal_state, result.result_code, result.result_summary,
           result.completed_at, result.expires_at
    FROM focowiki.operation_results result
    WHERE result.knowledge_base_id = ${knowledgeBaseId}
      AND result.operation_kind = 'upload'
      AND (result.correlation_public_id = ${identity} OR result.public_id = (
        SELECT operation_public_id FROM focowiki.operation_idempotency
        WHERE knowledge_base_id = ${knowledgeBaseId} AND idempotency_key = ${identity}
        LIMIT 1
      ))
    LIMIT 1
  `;
  return rows[0] ?? null;
}

function mapUploadSession(row: StorageVnextUploadSessionRow): UploadSessionRecord {
  const counts = emptyUploadSessionCounts();
  counts.selected = uploadCount(row.entry_count);
  counts.uploadRequired = uploadCount(row.upload_required_count);
  counts.skippedExisting = uploadCount(row.skipped_existing_count);
  counts.uploaded = uploadCount(row.received_entry_count);
  return {
    id: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    state: row.state === "draft" && counts.selected > 0 ? "manifest_building" : row.state,
    idempotencyKey: row.idempotency_key,
    manifestFingerprint: null,
    declaredFileCount: uploadCount(row.expected_entry_count),
    declaredByteCount: uploadCount(row.expected_byte_count),
    counts,
    errorCode: null,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: null
  };
}

function mapTerminalUploadSession(row: StorageVnextUploadTerminalRow): UploadSessionRecord {
  const summary = readRecord(row.result_summary);
  const counts = emptyUploadSessionCounts();
  counts.selected = readCount(summary, "expectedEntryCount");
  counts.skippedExisting = readCount(summary, "skippedExistingCount");
  counts.uploadRequired = counts.selected - counts.skippedExisting;
  counts.uploaded = readCount(summary, "receivedEntryCount");
  counts.finalized = row.terminal_state === "completed" ? counts.uploaded : 0;
  return {
    id: row.correlation_public_id,
    knowledgeBaseId: row.knowledge_base_id,
    state: mapTerminalState(row.terminal_state),
    idempotencyKey: "",
    manifestFingerprint: null,
    declaredFileCount: counts.selected,
    declaredByteCount: readCount(summary, "expectedByteCount"),
    counts,
    errorCode: row.terminal_state === "completed" ? null : row.result_code,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.completed_at.toISOString(),
    updatedAt: row.completed_at.toISOString(),
    completedAt: row.completed_at.toISOString()
  };
}

function mapTerminalState(
  state: StorageVnextUploadTerminalRow["terminal_state"]
): UploadSessionRecord["state"] {
  if (state === "timed_out") return "expired";
  if (state === "superseded" || state === "deleted") return "cancelled";
  return state;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readCount(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
