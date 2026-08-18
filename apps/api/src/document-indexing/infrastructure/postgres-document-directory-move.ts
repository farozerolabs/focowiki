import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import { normalizeSourceDirectoryPath } from "../../domain/source-path.js";
import { createStorageVnextUploadIdentity } from
  "../../storage-vnext/upload/identity.js";
import { readSourcePage, stageSourcePage } from
  "./postgres-document-directory-move-staging.js";
import {
  assertCheckpoint,
  assertDestinationAvailable,
  assertDestinationParent,
  directoryMoveError,
  directoryMoveRequestHash,
  safeErrorCode,
  validateAcceptance,
  validateRun,
  type DirectoryMoveCheckpoint,
  type DirectoryMoveClaim
} from "./postgres-document-directory-move-support.js";

export function createPostgresDocumentDirectoryMove(sql: DatabaseClient) {
  return {
    async accept(input: {
      knowledgeBaseId: string;
      sourceDirectoryPublicId: string;
      destinationParentPublicId: string | null;
      destinationLogicalPath: string;
      expectedResourceRevision: number;
      operationPublicId: string;
      idempotencyKey: string;
      settingsRevisionPublicId: string;
      maximumAttempts: number;
      acceptedAt: string;
      expiresAt: string;
    }): Promise<{ operationPublicId: string; replayed: boolean }> {
      validateAcceptance(input);
      const destination = normalizeSourceDirectoryPath(input.destinationLogicalPath);
      const requestHash = directoryMoveRequestHash({
        knowledgeBaseId: input.knowledgeBaseId,
        sourceDirectoryPublicId: input.sourceDirectoryPublicId,
        destinationLogicalPath: destination.relativePath,
        destinationNormalizedPath: destination.pathKey,
        expectedResourceRevision: input.expectedResourceRevision
      });
      return sql.begin(async (transaction) => {
        const replay = await transaction<Array<{
          request_hash: string;
          operation_public_id: string;
        }>>`
          SELECT request_hash, operation_public_id
          FROM focowiki.operation_idempotency
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND idempotency_key = ${input.idempotencyKey}
          FOR UPDATE
        `;
        if (replay[0]) {
          if (replay[0].request_hash !== requestHash) {
            throw directoryMoveError("idempotency_conflict");
          }
          return {
            operationPublicId: replay[0].operation_public_id,
            replayed: true
          };
        }
        const directories = await transaction<Array<{
          logical_path: string;
          normalized_path: string;
          revision: number | string;
        }>>`
          SELECT logical_path, normalized_path, revision
          FROM focowiki.source_directories
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND public_id = ${input.sourceDirectoryPublicId}
            AND deleted_at IS NULL
          FOR UPDATE
        `;
        const directory = directories[0];
        if (!directory) throw directoryMoveError("resource_missing");
        if (Number(directory.revision) !== input.expectedResourceRevision) {
          throw directoryMoveError("revision_conflict");
        }
        if (directory.normalized_path === destination.pathKey) {
          throw directoryMoveError("destination_unchanged");
        }
        if (destination.pathKey.startsWith(`${directory.normalized_path}/`)) {
          throw directoryMoveError("scope_conflict");
        }
        await assertDestinationParent(transaction, {
          knowledgeBaseId: input.knowledgeBaseId,
          destinationParentPublicId: input.destinationParentPublicId,
          destinationLogicalPath: destination.relativePath
        });
        await assertDestinationAvailable(transaction, {
          knowledgeBaseId: input.knowledgeBaseId,
          sourceDirectoryPublicId: input.sourceDirectoryPublicId,
          sourceNormalizedPath: directory.normalized_path,
          destinationNormalizedPath: destination.pathKey,
          operationPublicId: input.operationPublicId
        });
        const live = await transaction<Array<{ public_id: string }>>`
          SELECT operation.public_id
          FROM focowiki.operations operation
          JOIN focowiki.operation_work_items work
            ON work.knowledge_base_id = operation.knowledge_base_id
           AND work.operation_public_id = operation.public_id
          WHERE operation.knowledge_base_id = ${input.knowledgeBaseId}
            AND operation.target_kind = 'source_directory'
            AND operation.target_public_id = ${input.sourceDirectoryPublicId}
            AND work.work_kind = 'mutation'
            AND work.state IN ('queued', 'running', 'retry')
          LIMIT 1
          FOR UPDATE OF operation, work
        `;
        if (live[0]) throw directoryMoveError("mutation_conflict");
        const checkpoint: DirectoryMoveCheckpoint = {
          version: 1,
          sourceDirectoryPublicId: input.sourceDirectoryPublicId,
          sourceLogicalPath: directory.logical_path,
          sourceNormalizedPath: directory.normalized_path,
          destinationParentPublicId: input.destinationParentPublicId,
          destinationLogicalPath: destination.relativePath,
          destinationNormalizedPath: destination.pathKey,
          directoriesMoved: false,
          schedulingComplete: false,
          cursorSourceFilePublicId: null,
          maximumAttempts: input.maximumAttempts,
          resultExpiresAt: input.expiresAt
        };
        await transaction`
          INSERT INTO focowiki.operations (
            public_id, knowledge_base_id, operation_kind, state,
            expected_resource_revision, target_kind, target_public_id,
            candidate_relative_path, created_at, updated_at
          ) VALUES (
            ${input.operationPublicId}, ${input.knowledgeBaseId},
            'source_directory_move', 'processing',
            ${input.expectedResourceRevision}, 'source_directory',
            ${input.sourceDirectoryPublicId}, ${destination.relativePath},
            ${input.acceptedAt}, ${input.acceptedAt}
          )
        `;
        await transaction`
          INSERT INTO focowiki.operation_idempotency (
            public_id, knowledge_base_id, idempotency_key, request_hash,
            operation_public_id, expires_at, created_at
          ) VALUES (
            ${createStorageVnextUploadIdentity(
              "idempotency", "directory-move", input.knowledgeBaseId,
              input.idempotencyKey
            )}, ${input.knowledgeBaseId}, ${input.idempotencyKey}, ${requestHash},
            ${input.operationPublicId}, ${input.expiresAt}, ${input.acceptedAt}
          )
        `;
        await transaction`
          INSERT INTO focowiki.operation_work_items (
            operation_public_id, knowledge_base_id, work_kind, state,
            operation_revision, settings_revision_public_id, attempt_count,
            next_attempt_at, checkpoint, updated_at
          ) VALUES (
            ${input.operationPublicId}, ${input.knowledgeBaseId}, 'mutation',
            'queued', 1, ${input.settingsRevisionPublicId}, 0,
            ${input.acceptedAt}, ${transaction.json(checkpoint as never)},
            ${input.acceptedAt}
          )
        `;
        await transaction`
          INSERT INTO focowiki.mutation_path_reservations (
            knowledge_base_id, normalized_path, operation_public_id,
            target_kind, target_public_id, expires_at, created_at
          ) VALUES (
            ${input.knowledgeBaseId}, ${destination.pathKey},
            ${input.operationPublicId}, 'source_directory',
            ${input.sourceDirectoryPublicId}, ${input.expiresAt}, ${input.acceptedAt}
          )
        `;
        return { operationPublicId: input.operationPublicId, replayed: false };
      });
    },

    async runPage(input: {
      workerId: string;
      now: string;
      leaseExpiresAt: string;
      retryAt: string;
      pageSize: number;
    }): Promise<"idle" | "progress" | "waiting"> {
      validateRun(input);
      const claimed = await sql.begin((transaction) =>
        claimDirectoryMove(transaction, input)
      );
      if (!claimed) return "idle";
      try {
        return await sql.begin(async (transaction) => {
          if (!claimed.checkpoint.directoriesMoved) {
            await moveDirectoryRows(transaction, claimed);
            await releaseDirectoryMove(transaction, claimed, {
              workerId: input.workerId,
              nextAt: input.now,
              now: input.now
            }, {
              ...claimed.checkpoint,
              directoriesMoved: true
            });
            return "progress";
          }
          if (!claimed.checkpoint.schedulingComplete) {
            const sources = await readSourcePage(
              transaction,
              claimed,
              input.pageSize
            );
            if (sources.length > 0) {
              await stageSourcePage(transaction, claimed, sources, input.now);
              await releaseDirectoryMove(transaction, claimed, {
                workerId: input.workerId,
                nextAt: input.now,
                now: input.now
              }, {
                ...claimed.checkpoint,
                cursorSourceFilePublicId: sources.at(-1)!.public_id
              });
              return "progress";
            }
            await releaseDirectoryMove(transaction, claimed, {
              workerId: input.workerId,
              nextAt: input.now,
              now: input.now
            }, {
              ...claimed.checkpoint,
              schedulingComplete: true
            });
            return "progress";
          }
          const terminal = await completeDirectoryMoveIfTerminal(
            transaction,
            claimed,
            input.now
          );
          if (!terminal) {
            await releaseDirectoryMove(
              transaction,
              claimed,
              {
                workerId: input.workerId,
                nextAt: input.retryAt,
                now: input.now
              },
              claimed.checkpoint
            );
            return "waiting";
          }
          return "progress";
        });
      } catch (error) {
        await sql.begin((transaction) =>
          retryDirectoryMove(transaction, claimed, input, error)
        );
        return "progress";
      }
    }
  };
}

async function claimDirectoryMove(
  sql: TransactionSql,
  input: { workerId: string; now: string; leaseExpiresAt: string }
): Promise<DirectoryMoveClaim | null> {
  const rows = await sql<Array<{
    operation_public_id: string;
    knowledge_base_id: string;
    operation_revision: number | string;
    attempt_count: number | string;
    checkpoint: DirectoryMoveCheckpoint;
  }>>`
    WITH candidate AS (
      SELECT work.operation_public_id
      FROM focowiki.operation_work_items work
      JOIN focowiki.operations operation
        ON operation.knowledge_base_id = work.knowledge_base_id
       AND operation.public_id = work.operation_public_id
      WHERE work.work_kind = 'mutation'
        AND operation.operation_kind = 'source_directory_move'
        AND operation.state = 'processing'
        AND (
          work.state IN ('queued', 'retry')
          AND (work.next_attempt_at IS NULL OR work.next_attempt_at <= ${input.now})
          OR work.state = 'running' AND work.lease_expires_at <= ${input.now}
        )
      ORDER BY work.updated_at, work.operation_public_id COLLATE "C"
      FOR UPDATE OF work SKIP LOCKED
      LIMIT 1
    )
    UPDATE focowiki.operation_work_items work
    SET state = 'running', lease_owner = ${input.workerId},
        lease_expires_at = ${input.leaseExpiresAt}, next_attempt_at = NULL,
        operation_revision = operation_revision + 1,
        updated_at = ${input.now}
    FROM candidate
    WHERE work.operation_public_id = candidate.operation_public_id
    RETURNING work.operation_public_id, work.knowledge_base_id,
              work.operation_revision, work.attempt_count, work.checkpoint
  `;
  const row = rows[0];
  if (!row) return null;
  assertCheckpoint(row.checkpoint);
  return {
    operationPublicId: row.operation_public_id,
    knowledgeBaseId: row.knowledge_base_id,
    operationRevision: Number(row.operation_revision),
    attemptCount: Number(row.attempt_count),
    checkpoint: row.checkpoint
  };
}

async function moveDirectoryRows(
  sql: TransactionSql,
  claimed: DirectoryMoveClaim
): Promise<void> {
  const checkpoint = claimed.checkpoint;
  await assertDestinationAvailable(sql, {
    knowledgeBaseId: claimed.knowledgeBaseId,
    sourceDirectoryPublicId: checkpoint.sourceDirectoryPublicId,
    sourceNormalizedPath: checkpoint.sourceNormalizedPath,
    destinationNormalizedPath: checkpoint.destinationNormalizedPath,
    operationPublicId: claimed.operationPublicId
  });
  const moved = await sql<Array<{ public_id: string }>>`
    UPDATE focowiki.source_directories directory
    SET logical_path = ${checkpoint.destinationLogicalPath}
          || substr(directory.logical_path, ${checkpoint.sourceLogicalPath.length + 1}),
        normalized_path = ${checkpoint.destinationNormalizedPath}
          || substr(directory.normalized_path, ${checkpoint.sourceNormalizedPath.length + 1}),
        parent_public_id = CASE
          WHEN directory.public_id = ${checkpoint.sourceDirectoryPublicId}
            THEN ${checkpoint.destinationParentPublicId}
          ELSE directory.parent_public_id END,
        title = CASE
          WHEN directory.public_id = ${checkpoint.sourceDirectoryPublicId}
            THEN ${checkpoint.destinationLogicalPath.split("/").at(-1)!}
          ELSE directory.title END,
        revision = revision + 1, updated_at = now()
    WHERE directory.knowledge_base_id = ${claimed.knowledgeBaseId}
      AND directory.deleted_at IS NULL
      AND (
        directory.public_id = ${checkpoint.sourceDirectoryPublicId}
        OR directory.normalized_path LIKE ${checkpoint.sourceNormalizedPath} || '/%'
      )
    RETURNING public_id
  `;
  if (moved.length < 1) throw directoryMoveError("resource_missing");
}

async function releaseDirectoryMove(
  sql: TransactionSql,
  claimed: DirectoryMoveClaim,
  input: { workerId: string; nextAt: string; now: string },
  checkpoint: DirectoryMoveCheckpoint
): Promise<void> {
  const updated = await sql<Array<{ operation_public_id: string }>>`
    UPDATE focowiki.operation_work_items
    SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL,
        next_attempt_at = ${input.nextAt}, checkpoint = ${sql.json(checkpoint as never)},
        safe_error_code = NULL, updated_at = ${input.now}
    WHERE operation_public_id = ${claimed.operationPublicId}
      AND work_kind = 'mutation' AND state = 'running'
      AND lease_owner = ${input.workerId}
      AND operation_revision = ${claimed.operationRevision}
    RETURNING operation_public_id
  `;
  if (updated.length !== 1) throw directoryMoveError("lease_lost");
}

async function completeDirectoryMoveIfTerminal(
  sql: TransactionSql,
  claimed: DirectoryMoveClaim,
  now: string
): Promise<boolean> {
  const counts = await sql<Array<{
    total_count: number | string;
    nonterminal_count: number | string;
    error_count: number | string;
  }>>`
    SELECT count(*) AS total_count,
           count(*) FILTER (WHERE state IN ('waiting', 'processing', 'deleting'))
             AS nonterminal_count,
           count(*) FILTER (WHERE state = 'error') AS error_count
    FROM focowiki.document_processing_jobs
    WHERE knowledge_base_id = ${claimed.knowledgeBaseId}
      AND operation_public_id = ${claimed.operationPublicId}
  `;
  if (Number(counts[0]?.nonterminal_count ?? 0) > 0) return false;
  const failed = Number(counts[0]?.error_count ?? 0) > 0;
  await sql`
    UPDATE focowiki.operations
    SET state = ${failed ? "failed" : "completed"},
        completed_at = ${now}, updated_at = ${now}
    WHERE knowledge_base_id = ${claimed.knowledgeBaseId}
      AND public_id = ${claimed.operationPublicId}
      AND state = 'processing'
  `;
  await sql`
    INSERT INTO focowiki.operation_results (
      public_id, knowledge_base_id, operation_kind, terminal_state,
      result_code, safe_message, result_summary, correlation_public_id,
      completed_at, expires_at
    ) VALUES (
      ${claimed.operationPublicId}, ${claimed.knowledgeBaseId},
      'source_directory_move', ${failed ? "failed" : "completed"},
      ${failed ? "DIRECTORY_MOVE_DOCUMENT_FAILED" : "DIRECTORY_MOVE_COMPLETED"},
      NULL, ${sql.json({
        totalCount: Number(counts[0]?.total_count ?? 0),
        failedCount: Number(counts[0]?.error_count ?? 0)
      })}, ${claimed.checkpoint.sourceDirectoryPublicId}, ${now},
      ${claimed.checkpoint.resultExpiresAt}
    )
    ON CONFLICT (public_id) DO NOTHING
  `;
  await sql`
    DELETE FROM focowiki.operation_work_items
    WHERE operation_public_id = ${claimed.operationPublicId}
      AND work_kind = 'mutation'
  `;
  await sql`
    DELETE FROM focowiki.mutation_path_reservations
    WHERE operation_public_id = ${claimed.operationPublicId}
  `;
  return true;
}

async function retryDirectoryMove(
  sql: TransactionSql,
  claimed: DirectoryMoveClaim,
  input: { workerId: string; now: string; retryAt: string },
  error: unknown
): Promise<void> {
  const code = safeErrorCode(error);
  const exhausted = claimed.attemptCount + 1 >= claimed.checkpoint.maximumAttempts;
  if (exhausted) {
    await sql`
      UPDATE focowiki.operations
      SET state = 'failed', completed_at = ${input.now}, updated_at = ${input.now}
      WHERE knowledge_base_id = ${claimed.knowledgeBaseId}
        AND public_id = ${claimed.operationPublicId}
        AND state = 'processing'
    `;
    await sql`
      INSERT INTO focowiki.operation_results (
        public_id, knowledge_base_id, operation_kind, terminal_state,
        result_code, safe_message, result_summary, correlation_public_id,
        completed_at, expires_at
      ) VALUES (
        ${claimed.operationPublicId}, ${claimed.knowledgeBaseId},
        'source_directory_move', 'failed', ${code}, NULL, '{}'::jsonb,
        ${claimed.checkpoint.sourceDirectoryPublicId}, ${input.now},
        ${claimed.checkpoint.resultExpiresAt}
      ) ON CONFLICT (public_id) DO NOTHING
    `;
    await sql`
      DELETE FROM focowiki.operation_work_items
      WHERE operation_public_id = ${claimed.operationPublicId}
        AND work_kind = 'mutation'
    `;
    await sql`
      DELETE FROM focowiki.mutation_path_reservations
      WHERE operation_public_id = ${claimed.operationPublicId}
    `;
    return;
  }
  await sql`
    UPDATE focowiki.operation_work_items
    SET state = 'retry', lease_owner = NULL, lease_expires_at = NULL,
        next_attempt_at = ${input.retryAt}, safe_error_code = ${code},
        attempt_count = attempt_count + 1,
        updated_at = ${input.now}
    WHERE operation_public_id = ${claimed.operationPublicId}
      AND work_kind = 'mutation' AND state = 'running'
      AND lease_owner = ${input.workerId}
      AND operation_revision = ${claimed.operationRevision}
  `;
}
