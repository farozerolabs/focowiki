import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import type {
  StorageVnextBoundedResult,
  StorageVnextWorkflowClaimPort,
  StorageVnextWorkflowOutcome,
  StorageVnextWorkflowWritePort,
  StorageVnextWorkKind
} from "./ports.js";
import {
  STORAGE_VNEXT_WORK_KINDS,
  assertStorageVnextBoundedResult,
  assertStorageVnextChecksum,
  assertStorageVnextIdentifier,
  assertStorageVnextLiveWork,
  assertStorageVnextMetadata,
  assertStorageVnextTimestamp,
  assertStorageVnextWorkflowLimit,
  decodeStorageVnextResultCursor,
  encodeStorageVnextResultCursor,
  mapStorageVnextLiveWork,
  mapStorageVnextResult,
  sameStorageVnextResult,
  storageVnextWorkflowRepositoryError,
  type StorageVnextLiveWorkRow,
  type StorageVnextResultRow
} from "./postgres-contract.js";

export {
  StorageVnextWorkflowRepositoryError,
  type StorageVnextWorkflowRepositoryErrorCode
} from "./postgres-contract.js";

export type StorageVnextWorkflowRepository =
  & StorageVnextWorkflowClaimPort
  & StorageVnextWorkflowWritePort;

type ReadSql = DatabaseClient | TransactionSql;

type IdempotencyRow = {
  operation_public_id: string;
  request_hash: string;
};

export function createPostgresStorageVnextWorkflowRepository(
  sql: DatabaseClient
): StorageVnextWorkflowRepository {
  return {
    async findIdempotent(input) {
      assertStorageVnextIdentifier(input.knowledgeBaseId, 255);
      assertStorageVnextIdentifier(input.key, 255);
      assertStorageVnextChecksum(input.requestHash);
      return findIdempotentOutcome(sql, input);
    },

    async enqueue(work) {
      assertStorageVnextLiveWork(work);
      return sql.begin(async (transaction) => {
        const existing = await findIdempotentOutcome(transaction, {
          knowledgeBaseId: work.knowledgeBaseId,
          key: work.idempotency.key,
          requestHash: work.idempotency.requestHash
        });
        if (existing) return existing;

        const insertedOperations = await transaction<Array<{ public_id: string }>>`
          INSERT INTO focowiki.operations
            (public_id, knowledge_base_id, operation_kind, state)
          VALUES
            (${work.publicId}, ${work.knowledgeBaseId}, ${work.kind},
             ${work.state === "running" ? "processing" : "accepted"})
          ON CONFLICT DO NOTHING
          RETURNING public_id
        `;
        const operationRows = await transaction<Array<{
          knowledge_base_id: string;
          operation_kind: string;
        }>>`
          SELECT knowledge_base_id, operation_kind
          FROM focowiki.operations
          WHERE public_id = ${work.publicId}
          LIMIT 1
        `;
        const operation = operationRows[0];
        if (
          !operation
          || operation.knowledge_base_id !== work.knowledgeBaseId
          || operation.operation_kind !== work.kind
        ) {
          throw storageVnextWorkflowRepositoryError("operation_conflict");
        }

        await transaction`
          INSERT INTO focowiki.operation_work_items
            (operation_public_id, knowledge_base_id, work_kind, state,
             operation_revision, settings_revision_public_id, attempt_count,
             lease_owner, lease_expires_at, next_attempt_at, safe_error_code,
             checkpoint)
          VALUES
            (${work.publicId}, ${work.knowledgeBaseId}, ${work.kind}, ${work.state},
              ${work.operationRevision}, ${work.settingsRevisionPublicId}, ${work.attempt},
              ${work.leaseOwner}, ${work.leaseExpiresAt}, ${work.nextAttemptAt},
              ${work.safeErrorCode},
              ${transaction.json(work.checkpoint)})
          ON CONFLICT (operation_public_id) DO NOTHING
        `;
        await transaction`
          INSERT INTO focowiki.operation_idempotency
            (public_id, knowledge_base_id, idempotency_key, request_hash,
             operation_public_id, expires_at)
          VALUES
            (${work.publicId}, ${work.knowledgeBaseId}, ${work.idempotency.key},
             ${work.idempotency.requestHash}, ${work.publicId},
             ${work.idempotency.expiresAt})
          ON CONFLICT (knowledge_base_id, idempotency_key) DO NOTHING
        `;

        const winnerRows = await transaction<IdempotencyRow[]>`
          SELECT operation_public_id, request_hash
          FROM focowiki.operation_idempotency
          WHERE knowledge_base_id = ${work.knowledgeBaseId}
            AND idempotency_key = ${work.idempotency.key}
          LIMIT 1
        `;
        const winner = winnerRows[0];
        if (!winner || winner.request_hash !== work.idempotency.requestHash) {
          throw storageVnextWorkflowRepositoryError("idempotency_conflict");
        }

        if (winner.operation_public_id !== work.publicId && insertedOperations.length > 0) {
          await transaction`
            DELETE FROM focowiki.operations
            WHERE public_id = ${work.publicId}
          `;
        }
        const outcome = await readOutcome(
          transaction,
          work.knowledgeBaseId,
          winner.operation_public_id
        );
        if (!outcome) throw storageVnextWorkflowRepositoryError("operation_conflict");
        return outcome;
      });
    },

    async claim(input) {
      const kinds = input.kinds.filter((kind, index) => input.kinds.indexOf(kind) === index);
      if (kinds.length === 0 || kinds.some((kind) => !STORAGE_VNEXT_WORK_KINDS.includes(kind))) {
        throw storageVnextWorkflowRepositoryError("invalid_input");
      }
      assertStorageVnextIdentifier(input.owner, 255);
      const limit = assertStorageVnextWorkflowLimit(input.limit);
      const leaseExpiresAt = assertStorageVnextTimestamp(input.leaseExpiresAt);
      if (leaseExpiresAt.getTime() <= Date.now()) throw storageVnextWorkflowRepositoryError("invalid_input");

      return sql.begin(async (transaction) => {
        const rows = await transaction<StorageVnextLiveWorkRow[]>`
          WITH eligible AS (
            SELECT work.operation_public_id,
                   work.next_attempt_at,
                   work.updated_at,
                   row_number() OVER (
                     PARTITION BY CASE
                       WHEN work.work_kind IN ('publication', 'mutation')
                         THEN work.knowledge_base_id
                       ELSE work.operation_public_id
                     END
                     ORDER BY work.next_attempt_at NULLS FIRST,
                              work.updated_at,
                              work.operation_public_id
                   ) AS scope_ordinal
            FROM focowiki.operation_work_items work
            WHERE work.work_kind = ANY(${kinds})
              AND work.state IN ('queued', 'retry')
              AND (work.next_attempt_at IS NULL OR work.next_attempt_at <= now())
              AND (
                work.work_kind <> 'publication'
                OR NOT EXISTS (
                  SELECT 1
                  FROM focowiki.operation_work_items source_work
                  WHERE source_work.knowledge_base_id = work.knowledge_base_id
                    AND source_work.work_kind = 'source'
                )
              )
              AND (
                work.work_kind NOT IN ('publication', 'mutation')
                OR NOT EXISTS (
                  SELECT 1
                  FROM focowiki.operation_work_items running
                  WHERE running.knowledge_base_id = work.knowledge_base_id
                    AND running.work_kind IN ('publication', 'mutation')
                    AND running.state = 'running'
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM focowiki.release_candidates candidate
                  WHERE candidate.knowledge_base_id = work.knowledge_base_id
                    AND candidate.operation_public_id <> work.operation_public_id
                )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM focowiki.operation_dependencies dependency
                JOIN focowiki.operations required
                  ON required.knowledge_base_id = dependency.knowledge_base_id
                 AND required.public_id = dependency.dependency_operation_public_id
                WHERE dependency.knowledge_base_id = work.knowledge_base_id
                  AND dependency.operation_public_id = work.operation_public_id
                  AND required.state NOT IN (
                    'completed', 'failed', 'cancelled', 'superseded', 'timed_out', 'deleted'
                  )
              )
          ), candidates AS (
            SELECT work.operation_public_id
            FROM focowiki.operation_work_items work
            JOIN eligible
              ON eligible.operation_public_id = work.operation_public_id
            WHERE eligible.scope_ordinal = 1
            ORDER BY eligible.next_attempt_at NULLS FIRST,
                     eligible.updated_at,
                     eligible.operation_public_id
            FOR UPDATE OF work SKIP LOCKED
            LIMIT ${limit}
          ), claimed AS (
            UPDATE focowiki.operation_work_items work
            SET state = 'running',
                attempt_count = work.attempt_count + 1,
                lease_owner = ${input.owner},
                lease_expires_at = ${input.leaseExpiresAt},
                next_attempt_at = NULL,
                safe_error_code = NULL,
                updated_at = now()
            FROM candidates
            WHERE work.operation_public_id = candidates.operation_public_id
              AND work.state IN ('queued', 'retry')
              AND (work.next_attempt_at IS NULL OR work.next_attempt_at <= now())
            RETURNING work.*
          )
          SELECT claimed.operation_public_id, claimed.knowledge_base_id,
                 claimed.work_kind, claimed.state, claimed.operation_revision,
                 claimed.settings_revision_public_id, claimed.attempt_count,
                 claimed.lease_owner, claimed.lease_expires_at,
                 claimed.next_attempt_at, claimed.safe_error_code, claimed.checkpoint,
                 idempotency.idempotency_key, idempotency.request_hash,
                 idempotency.expires_at AS idempotency_expires_at
          FROM claimed
          JOIN focowiki.operation_idempotency idempotency
            ON idempotency.knowledge_base_id = claimed.knowledge_base_id
           AND idempotency.operation_public_id = claimed.operation_public_id
          ORDER BY claimed.updated_at, claimed.operation_public_id
        `;
        const operationIds = rows.map((row) => row.operation_public_id);
        if (operationIds.length > 0) {
          await transaction`
            UPDATE focowiki.operations
            SET state = 'processing', updated_at = now()
            WHERE public_id = ANY(${operationIds})
          `;
        }
        return rows.map(mapStorageVnextLiveWork);
      });
    },

    async recoverStale(input) {
      const kinds = input.kinds.filter((kind, index) => input.kinds.indexOf(kind) === index);
      if (kinds.length === 0 || kinds.some((kind) => !STORAGE_VNEXT_WORK_KINDS.includes(kind))) {
        throw storageVnextWorkflowRepositoryError("invalid_input");
      }
      assertStorageVnextTimestamp(input.expiredBefore);
      assertStorageVnextTimestamp(input.retryAt);
      assertStorageVnextIdentifier(input.reasonCode, 128);
      const limit = assertStorageVnextWorkflowLimit(input.limit);
      return sql.begin(async (transaction) => {
        const rows = await transaction<Array<{ operation_public_id: string }>>`
          WITH stale AS (
            SELECT work.operation_public_id
            FROM focowiki.operation_work_items work
            JOIN focowiki.operations operation
              ON operation.knowledge_base_id = work.knowledge_base_id
             AND operation.public_id = work.operation_public_id
            WHERE work.work_kind = ANY(${kinds})
              AND work.state = 'running'
              AND lease_expires_at <= ${input.expiredBefore}
              AND operation.state NOT IN (
                'completed', 'failed', 'cancelled', 'superseded', 'timed_out', 'deleted'
              )
            ORDER BY work.lease_expires_at, work.operation_public_id
            FOR UPDATE OF work SKIP LOCKED
            LIMIT ${limit}
          )
          UPDATE focowiki.operation_work_items work
          SET state = 'retry', lease_owner = NULL, lease_expires_at = NULL,
              next_attempt_at = ${input.retryAt},
              safe_error_code = ${input.reasonCode}, updated_at = now()
          FROM stale
          WHERE work.operation_public_id = stale.operation_public_id
          RETURNING work.operation_public_id
        `;
        const operationIds = rows.map((row) => row.operation_public_id);
        if (operationIds.length > 0) {
          await transaction`
            UPDATE focowiki.operations
            SET state = 'accepted', updated_at = now()
            WHERE public_id = ANY(${operationIds})
          `;
        }
        return rows.length;
      });
    },

    async renew(input) {
      assertStorageVnextIdentifier(input.publicId, 255);
      assertStorageVnextIdentifier(input.owner, 255);
      const leaseExpiresAt = assertStorageVnextTimestamp(input.leaseExpiresAt);
      if (leaseExpiresAt.getTime() <= Date.now()) throw storageVnextWorkflowRepositoryError("invalid_input");
      const rows = await sql<Array<{ operation_public_id: string }>>`
        UPDATE focowiki.operation_work_items
        SET lease_expires_at = ${input.leaseExpiresAt}, updated_at = now()
        WHERE operation_public_id = ${input.publicId}
          AND state = 'running'
          AND lease_owner = ${input.owner}
          AND lease_expires_at > now()
        RETURNING operation_public_id
      `;
      return rows.length === 1;
    },

    async saveCheckpoint(input) {
      assertStorageVnextIdentifier(input.publicId, 255);
      assertStorageVnextIdentifier(input.owner, 255);
      assertStorageVnextMetadata(input.checkpoint, 32_768);
      const rows = await sql<Array<{ operation_public_id: string }>>`
        UPDATE focowiki.operation_work_items
        SET checkpoint = ${sql.json(input.checkpoint)}, updated_at = now()
        WHERE operation_public_id = ${input.publicId}
          AND state = 'running'
          AND lease_owner = ${input.owner}
          AND lease_expires_at > now()
        RETURNING operation_public_id
      `;
      if (rows.length !== 1) throw storageVnextWorkflowRepositoryError("lease_lost");
    },

    async releaseForRetry(input) {
      assertStorageVnextIdentifier(input.publicId, 255);
      assertStorageVnextIdentifier(input.owner, 255);
      assertStorageVnextIdentifier(input.reasonCode, 128);
      assertStorageVnextTimestamp(input.nextAttemptAt);
      const rows = await sql<Array<{ operation_public_id: string }>>`
        UPDATE focowiki.operation_work_items
        SET state = 'retry', lease_owner = NULL, lease_expires_at = NULL,
            next_attempt_at = ${input.nextAttemptAt},
            safe_error_code = ${input.reasonCode}, updated_at = now()
        WHERE operation_public_id = ${input.publicId}
          AND state = 'running'
          AND lease_owner = ${input.owner}
        RETURNING operation_public_id
      `;
      if (rows.length !== 1) throw storageVnextWorkflowRepositoryError("lease_lost");
    },

    async releaseForContinuation(input) {
      assertStorageVnextIdentifier(input.publicId, 255);
      assertStorageVnextIdentifier(input.owner, 255);
      assertStorageVnextTimestamp(input.nextAttemptAt);
      const rows = await sql<Array<{ operation_public_id: string }>>`
        UPDATE focowiki.operation_work_items
        SET state = 'queued', attempt_count = 0,
            lease_owner = NULL, lease_expires_at = NULL,
            next_attempt_at = ${input.nextAttemptAt},
            safe_error_code = NULL, updated_at = now()
        WHERE operation_public_id = ${input.publicId}
          AND state = 'running'
          AND lease_owner = ${input.owner}
          AND lease_expires_at > now()
        RETURNING operation_public_id
      `;
      if (rows.length !== 1) throw storageVnextWorkflowRepositoryError("lease_lost");
    },

    async complete(input) {
      assertStorageVnextIdentifier(input.publicId, 255);
      assertStorageVnextIdentifier(input.owner, 255);
      assertStorageVnextBoundedResult(input.result);
      if (input.result.publicId !== input.publicId) {
        throw storageVnextWorkflowRepositoryError("invalid_input");
      }

      await sql.begin(async (transaction) => {
        const existing = await readResult(transaction, input.publicId);
        if (existing) {
          if (!sameStorageVnextResult(existing, input.result)) throw storageVnextWorkflowRepositoryError("operation_conflict");
          return;
        }
        const workRows = await transaction<Array<{
          knowledge_base_id: string;
          work_kind: StorageVnextWorkKind;
        }>>`
          DELETE FROM focowiki.operation_work_items
          WHERE operation_public_id = ${input.publicId}
            AND state = 'running'
            AND lease_owner = ${input.owner}
            AND lease_expires_at > now()
          RETURNING knowledge_base_id, work_kind
        `;
        const work = workRows[0];
        if (!work) {
          const concurrent = await readResult(transaction, input.publicId);
          if (concurrent) {
            if (!sameStorageVnextResult(concurrent, input.result)) {
              throw storageVnextWorkflowRepositoryError("operation_conflict");
            }
            return;
          }
          throw storageVnextWorkflowRepositoryError("lease_lost");
        }
        if (
          work.knowledge_base_id !== input.result.knowledgeBaseId
          || work.work_kind !== input.result.kind
        ) {
          throw storageVnextWorkflowRepositoryError("lease_lost");
        }
        await transaction`
          UPDATE focowiki.operations
          SET state = ${input.result.state},
              completed_at = ${input.result.completedAt},
              updated_at = now()
          WHERE knowledge_base_id = ${input.result.knowledgeBaseId}
            AND public_id = ${input.publicId}
        `;
        await transaction`
          INSERT INTO focowiki.operation_results
            (public_id, knowledge_base_id, operation_kind, terminal_state,
             result_code, safe_message, result_summary, correlation_public_id,
             completed_at, expires_at)
          VALUES
            (${input.result.publicId}, ${input.result.knowledgeBaseId},
             ${input.result.kind}, ${input.result.state}, ${input.result.resultCode},
             ${input.result.safeMessage}, ${transaction.json(input.result.summary)},
             ${input.result.correlationPublicId}, ${input.result.completedAt},
             ${input.result.expiresAt})
        `;
      });
    },

    async listResults(input) {
      assertStorageVnextIdentifier(input.knowledgeBaseId, 255);
      const limit = assertStorageVnextWorkflowLimit(input.limit);
      const cursor = decodeStorageVnextResultCursor(input.cursor, input.knowledgeBaseId);
      const rows = await sql<StorageVnextResultRow[]>`
        SELECT public_id, knowledge_base_id, operation_kind, terminal_state,
               result_code, safe_message, result_summary, correlation_public_id,
               completed_at, expires_at
        FROM focowiki.operation_results
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND expires_at > now()
          AND (
            ${cursor?.completedAt ?? null}::timestamptz IS NULL
            OR (completed_at, public_id) <
               (${cursor?.completedAt ?? null}::timestamptz,
                ${cursor?.publicId ?? null}::text)
          )
        ORDER BY completed_at DESC, public_id DESC
        LIMIT ${limit + 1}
      `;
      const items = rows.slice(0, limit).map(mapStorageVnextResult);
      const last = items.at(-1);
      return {
        items,
        nextCursor: rows.length > limit && last
          ? encodeStorageVnextResultCursor({
              version: 1,
              knowledgeBaseId: input.knowledgeBaseId,
              completedAt: last.completedAt,
              publicId: last.publicId
            })
          : null
      };
    }
  };
}

async function findIdempotentOutcome(
  sql: ReadSql,
  input: { knowledgeBaseId: string; key: string; requestHash: string }
): Promise<StorageVnextWorkflowOutcome | null> {
  const rows = await sql<IdempotencyRow[]>`
    SELECT operation_public_id, request_hash
    FROM focowiki.operation_idempotency
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND idempotency_key = ${input.key}
      AND expires_at > now()
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  if (row.request_hash !== input.requestHash) {
    throw storageVnextWorkflowRepositoryError("idempotency_conflict");
  }
  const outcome = await readOutcome(sql, input.knowledgeBaseId, row.operation_public_id);
  if (!outcome) throw storageVnextWorkflowRepositoryError("operation_conflict");
  return outcome;
}

async function readOutcome(
  sql: ReadSql,
  knowledgeBaseId: string,
  operationPublicId: string
): Promise<StorageVnextWorkflowOutcome | null> {
  const liveRows = await sql<StorageVnextLiveWorkRow[]>`
    SELECT work.operation_public_id, work.knowledge_base_id, work.work_kind,
           work.state, work.operation_revision, work.settings_revision_public_id,
           work.attempt_count, work.lease_owner, work.lease_expires_at,
           work.next_attempt_at, work.safe_error_code, work.checkpoint,
           idempotency.idempotency_key,
           idempotency.request_hash,
           idempotency.expires_at AS idempotency_expires_at
    FROM focowiki.operation_work_items work
    JOIN focowiki.operation_idempotency idempotency
      ON idempotency.knowledge_base_id = work.knowledge_base_id
     AND idempotency.operation_public_id = work.operation_public_id
    WHERE work.knowledge_base_id = ${knowledgeBaseId}
      AND work.operation_public_id = ${operationPublicId}
    LIMIT 1
  `;
  if (liveRows[0]) return { type: "live", work: mapStorageVnextLiveWork(liveRows[0]) };
  const result = await readResult(sql, operationPublicId, knowledgeBaseId);
  return result ? { type: "result", result } : null;
}

async function readResult(
  sql: ReadSql,
  publicId: string,
  knowledgeBaseId?: string
): Promise<StorageVnextBoundedResult | null> {
  const rows = await sql<StorageVnextResultRow[]>`
    SELECT public_id, knowledge_base_id, operation_kind, terminal_state,
           result_code, safe_message, result_summary, correlation_public_id,
           completed_at, expires_at
    FROM focowiki.operation_results
    WHERE public_id = ${publicId}
      AND (${knowledgeBaseId ?? null}::text IS NULL OR knowledge_base_id = ${knowledgeBaseId ?? null})
    LIMIT 1
  `;
  return rows[0] ? mapStorageVnextResult(rows[0]) : null;
}
