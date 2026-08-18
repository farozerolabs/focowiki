import { createHash } from "node:crypto";
import type { TransactionSql } from "postgres";

export type DirectoryMoveCheckpoint = {
  version: 1;
  sourceDirectoryPublicId: string;
  sourceLogicalPath: string;
  sourceNormalizedPath: string;
  destinationParentPublicId: string | null;
  destinationLogicalPath: string;
  destinationNormalizedPath: string;
  directoriesMoved: boolean;
  schedulingComplete: boolean;
  cursorSourceFilePublicId: string | null;
  maximumAttempts: number;
  resultExpiresAt: string;
};

export type DirectoryMoveClaim = {
  operationPublicId: string;
  knowledgeBaseId: string;
  operationRevision: number;
  attemptCount: number;
  checkpoint: DirectoryMoveCheckpoint;
};

export async function assertDestinationParent(sql: TransactionSql, input: {
  knowledgeBaseId: string;
  destinationParentPublicId: string | null;
  destinationLogicalPath: string;
}): Promise<void> {
  const expectedParent = input.destinationLogicalPath
    .split("/").slice(0, -1).join("/");
  if (!input.destinationParentPublicId) {
    if (expectedParent) throw directoryMoveError("path_conflict");
    return;
  }
  const rows = await sql<Array<{ logical_path: string }>>`
    SELECT logical_path FROM focowiki.source_directories
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND public_id = ${input.destinationParentPublicId}
      AND deleted_at IS NULL
    FOR UPDATE
  `;
  if (rows[0]?.logical_path !== expectedParent) {
    throw directoryMoveError("path_conflict");
  }
}

export async function assertDestinationAvailable(sql: TransactionSql, input: {
  knowledgeBaseId: string;
  sourceDirectoryPublicId: string;
  sourceNormalizedPath: string;
  destinationNormalizedPath: string;
  operationPublicId: string;
}): Promise<void> {
  const rows = await sql<Array<{ present: boolean }>>`
    WITH RECURSIVE moving_directories AS (
      SELECT public_id, normalized_path
      FROM focowiki.source_directories
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND public_id = ${input.sourceDirectoryPublicId}
        AND deleted_at IS NULL
      UNION ALL
      SELECT child.public_id, child.normalized_path
      FROM focowiki.source_directories child
      JOIN moving_directories parent
        ON child.parent_public_id = parent.public_id
      WHERE child.knowledge_base_id = ${input.knowledgeBaseId}
        AND child.deleted_at IS NULL
    ), moving_files AS (
      SELECT source.public_id, source.normalized_path
      FROM focowiki.source_files source
      JOIN moving_directories directory
        ON directory.public_id = source.directory_public_id
      WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
        AND source.deleted_at IS NULL
    ), mapped_directories AS (
      SELECT public_id,
             ${input.destinationNormalizedPath}
               || substr(normalized_path, ${input.sourceNormalizedPath.length + 1})
               AS normalized_path
      FROM moving_directories
    ), mapped_files AS (
      SELECT public_id,
             ${input.destinationNormalizedPath}
               || substr(normalized_path, ${input.sourceNormalizedPath.length + 1})
               AS normalized_path
      FROM moving_files
    ), mapped_paths AS (
      SELECT normalized_path FROM mapped_directories
      UNION ALL
      SELECT normalized_path FROM mapped_files
    )
    SELECT EXISTS (
      SELECT 1
      FROM mapped_paths mapped
      WHERE EXISTS (
        SELECT 1 FROM focowiki.source_directories outside_directory
        WHERE outside_directory.knowledge_base_id = ${input.knowledgeBaseId}
          AND outside_directory.deleted_at IS NULL
          AND outside_directory.normalized_path = mapped.normalized_path
          AND NOT EXISTS (
            SELECT 1 FROM moving_directories moving
            WHERE moving.public_id = outside_directory.public_id
          )
      ) OR EXISTS (
        SELECT 1 FROM focowiki.source_files outside_source
        WHERE outside_source.knowledge_base_id = ${input.knowledgeBaseId}
          AND outside_source.deleted_at IS NULL
          AND outside_source.normalized_path = mapped.normalized_path
          AND NOT EXISTS (
            SELECT 1 FROM moving_files moving
            WHERE moving.public_id = outside_source.public_id
          )
      ) OR EXISTS (
        SELECT 1 FROM focowiki.mutation_path_reservations reservation
        WHERE reservation.knowledge_base_id = ${input.knowledgeBaseId}
          AND reservation.normalized_path = mapped.normalized_path
          AND reservation.operation_public_id <> ${input.operationPublicId}
          AND reservation.expires_at > now()
      )
    ) AS present
  `;
  if (rows[0]?.present) throw directoryMoveError("path_conflict");
}

export function validateAcceptance(input: {
  knowledgeBaseId: string;
  sourceDirectoryPublicId: string;
  operationPublicId: string;
  idempotencyKey: string;
  settingsRevisionPublicId: string;
  expectedResourceRevision: number;
  maximumAttempts: number;
  acceptedAt: string;
  expiresAt: string;
}): void {
  for (const value of [
    input.knowledgeBaseId, input.sourceDirectoryPublicId,
    input.operationPublicId, input.idempotencyKey,
    input.settingsRevisionPublicId
  ]) {
    if (!value || Buffer.byteLength(value) > 255) {
      throw directoryMoveError("invalid_input");
    }
  }
  if (!Number.isSafeInteger(input.expectedResourceRevision)
    || input.expectedResourceRevision < 0
    || !Number.isSafeInteger(input.maximumAttempts)
    || input.maximumAttempts < 1 || input.maximumAttempts > 100
    || !Number.isFinite(Date.parse(input.acceptedAt))
    || Date.parse(input.expiresAt) <= Date.parse(input.acceptedAt)) {
    throw directoryMoveError("invalid_input");
  }
}

export function validateRun(input: {
  workerId: string;
  now: string;
  leaseExpiresAt: string;
  retryAt: string;
  pageSize: number;
}): void {
  if (!input.workerId
    || !Number.isSafeInteger(input.pageSize)
    || input.pageSize < 1 || input.pageSize > 1_000
    || !Number.isFinite(Date.parse(input.now))
    || Date.parse(input.leaseExpiresAt) <= Date.parse(input.now)
    || Date.parse(input.retryAt) <= Date.parse(input.now)) {
    throw directoryMoveError("invalid_input");
  }
}

export function assertCheckpoint(value: DirectoryMoveCheckpoint): void {
  if (!value || value.version !== 1
    || !value.sourceDirectoryPublicId
    || !value.sourceLogicalPath || !value.sourceNormalizedPath
    || !value.destinationLogicalPath || !value.destinationNormalizedPath
    || typeof value.directoriesMoved !== "boolean"
    || typeof value.schedulingComplete !== "boolean"
    || !Number.isSafeInteger(value.maximumAttempts)
    || !Number.isFinite(Date.parse(value.resultExpiresAt))) {
    throw directoryMoveError("checkpoint_invalid");
  }
}

export function directoryMoveRequestHash(input: {
  knowledgeBaseId: string;
  sourceDirectoryPublicId: string;
  destinationLogicalPath: string;
  destinationNormalizedPath: string;
  expectedResourceRevision: number;
}): string {
  return createHash("sha256").update(JSON.stringify([
    input.knowledgeBaseId,
    input.sourceDirectoryPublicId,
    input.destinationLogicalPath,
    input.destinationNormalizedPath,
    input.expectedResourceRevision
  ])).digest("hex");
}

export function safeErrorCode(error: unknown): string {
  const value = error && typeof error === "object" && "code" in error
    ? error.code : null;
  return typeof value === "string" && value ? value.slice(0, 128)
    : "DIRECTORY_MOVE_FAILED";
}

export function directoryMoveError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document directory move error: ${code}`), { code });
}
