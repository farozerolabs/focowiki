import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import {
  assertRepositoryIdentity,
  assertRepositoryPositiveInteger,
  assertRepositoryTimestamp,
  repositoryContractError
} from "./document-repository-validation.js";

export type ProjectionCleanupReservation = Readonly<{
  objectId: string;
  writeAttemptPublicId: string;
}>;

export async function enqueueProjectionCleanupOutbox(input: Readonly<{
  transaction: DatabaseClient;
  knowledgeBaseId: string;
  scopePublicId: string;
  renderedSequence: number;
  reservations: readonly ProjectionCleanupReservation[];
  createdAt: string;
}>): Promise<void> {
  const unique = [...new Map(input.reservations.map((reservation) => [
    `${reservation.objectId}\0${reservation.writeAttemptPublicId}`,
    reservation
  ])).values()];
  if (unique.length > 256) {
    throw repositoryContractError("projection_cleanup_reservation_limit");
  }
  const createdAt = assertRepositoryTimestamp(input.createdAt, "created_at");
  for (const reservation of unique) {
    const publicId = `projection-cleanup-${createHash("sha256")
      .update(JSON.stringify([
        input.scopePublicId,
        input.renderedSequence,
        reservation.objectId,
        reservation.writeAttemptPublicId
      ])).digest("hex")}`;
    await input.transaction`
      INSERT INTO focowiki.projection_cleanup_outbox (
        public_id, knowledge_base_id, scope_public_id, rendered_sequence,
        object_id, write_attempt_public_id, next_eligible_at,
        created_at, updated_at
      ) VALUES (
        ${publicId},
        ${assertRepositoryIdentity(input.knowledgeBaseId, "knowledge_base_id")},
        ${assertRepositoryIdentity(input.scopePublicId, "scope_public_id")},
        ${assertRepositoryPositiveInteger(
          input.renderedSequence,
          "rendered_sequence"
        )},
        ${assertRepositoryIdentity(reservation.objectId, "object_id")},
        ${assertRepositoryIdentity(
          reservation.writeAttemptPublicId,
          "write_attempt_public_id"
        )},
        ${createdAt}, ${createdAt}, ${createdAt}
      ) ON CONFLICT ON CONSTRAINT projection_cleanup_outbox_holder_key
      DO NOTHING
    `;
  }
}

export function createPostgresProjectionCleanupOutbox(sql: DatabaseClient) {
  return {
    async claim(input: {
      workerId: string;
      now: string;
      leaseDurationMs: number;
      limit: number;
    }) {
      const now = assertRepositoryTimestamp(input.now, "now");
      const rows = await sql<Array<{
        public_id: string;
        object_id: string;
        write_attempt_public_id: string;
        lease_generation: number | string;
      }>>`
        WITH claimable AS (
          SELECT public_id
          FROM focowiki.projection_cleanup_outbox
          WHERE ((state = 'waiting' AND next_eligible_at <= ${now})
              OR (state = 'running' AND lease_expires_at <= ${now}))
            AND attempt_count < maximum_attempts
          ORDER BY created_at, public_id COLLATE "C"
          FOR UPDATE SKIP LOCKED
          LIMIT ${assertRepositoryPositiveInteger(input.limit, "limit", 256)}
        )
        UPDATE focowiki.projection_cleanup_outbox outbox
        SET state = 'running',
            lease_owner = ${assertRepositoryIdentity(input.workerId, "worker_id")},
            lease_generation = lease_generation + 1,
            lease_expires_at = ${new Date(Date.parse(now)
              + assertRepositoryPositiveInteger(
                input.leaseDurationMs,
                "lease_duration",
                300_000
              )).toISOString()},
            attempt_count = attempt_count + 1,
            updated_at = ${now}
        FROM claimable
        WHERE outbox.public_id = claimable.public_id
        RETURNING outbox.public_id, outbox.object_id,
                  outbox.write_attempt_public_id, outbox.lease_generation
      `;
      return rows.map((row) => ({
        publicId: row.public_id,
        objectId: row.object_id,
        writeAttemptPublicId: row.write_attempt_public_id,
        leaseGeneration: Number(row.lease_generation)
      }));
    },

    async complete(input: {
      publicId: string;
      workerId: string;
      leaseGeneration: number;
      now: string;
    }): Promise<boolean> {
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.projection_cleanup_outbox
        SET state = 'completed', lease_owner = NULL, lease_expires_at = NULL,
            completed_at = ${assertRepositoryTimestamp(input.now, "now")},
            safe_error_code = NULL, updated_at = ${input.now}
        WHERE public_id = ${assertRepositoryIdentity(input.publicId, "public_id")}
          AND state = 'running'
          AND lease_owner = ${assertRepositoryIdentity(input.workerId, "worker_id")}
          AND lease_generation = ${assertRepositoryPositiveInteger(
            input.leaseGeneration,
            "lease_generation"
          )}
          AND lease_expires_at > ${input.now}
        RETURNING public_id
      `;
      return rows.length === 1;
    },

    async fail(input: {
      publicId: string;
      workerId: string;
      leaseGeneration: number;
      now: string;
      retryAt: string;
      errorCode: string;
    }): Promise<boolean> {
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.projection_cleanup_outbox
        SET state = CASE WHEN attempt_count < maximum_attempts
              THEN 'waiting' ELSE 'error' END,
            next_eligible_at = ${assertRepositoryTimestamp(
              input.retryAt,
              "retry_at"
            )},
            lease_owner = NULL, lease_expires_at = NULL,
            safe_error_code = ${assertErrorCode(input.errorCode)},
            updated_at = ${assertRepositoryTimestamp(input.now, "now")}
        WHERE public_id = ${assertRepositoryIdentity(input.publicId, "public_id")}
          AND state = 'running'
          AND lease_owner = ${assertRepositoryIdentity(input.workerId, "worker_id")}
          AND lease_generation = ${assertRepositoryPositiveInteger(
            input.leaseGeneration,
            "lease_generation"
          )}
          AND lease_expires_at > ${input.now}
        RETURNING public_id
      `;
      return rows.length === 1;
    },

    async metrics(input: { now: string }) {
      const now = assertRepositoryTimestamp(input.now, "now");
      const rows = await sql<Array<{
        backlog_depth: number | string;
        oldest_age_milliseconds: number | string;
        verified_reservation_debt: number | string;
      }>>`
        SELECT count(*) FILTER (WHERE state <> 'completed') AS backlog_depth,
               greatest(0, coalesce(floor(extract(epoch FROM (
                 ${now}::timestamptz - min(created_at) FILTER (
                   WHERE state <> 'completed'
                 )
               )) * 1000), 0))::bigint AS oldest_age_milliseconds,
               count(*) FILTER (
                 WHERE state IN ('waiting', 'error') AND attempt_count > 0
               ) AS verified_reservation_debt
        FROM focowiki.projection_cleanup_outbox
      `;
      return {
        backlogDepth: Number(rows[0]?.backlog_depth ?? 0),
        oldestAgeMs: Number(rows[0]?.oldest_age_milliseconds ?? 0),
        verifiedReservationDebt: Number(
          rows[0]?.verified_reservation_debt ?? 0
        )
      };
    }
  };
}

function assertErrorCode(code: string): string {
  if (!/^[A-Za-z0-9_]{1,128}$/u.test(code)) {
    throw repositoryContractError("projection_cleanup_error_code_invalid");
  }
  return code;
}
