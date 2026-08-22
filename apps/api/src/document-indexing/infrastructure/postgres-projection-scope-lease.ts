import type { DatabaseClient } from "../../db/client.js";
import {
  assertRepositoryIdentity,
  assertRepositoryPositiveInteger,
  assertRepositoryTimestamp,
  repositoryContractError
} from "./document-repository-validation.js";

export function createPostgresProjectionScopeLease(sql: DatabaseClient) {
  return {
    async heartbeat(input: {
      publicId: string;
      workerId: string;
      leaseGeneration: number;
      now: string;
      leaseDurationMs: number;
    }): Promise<boolean> {
      const now = assertRepositoryTimestamp(input.now, "now");
      const leaseDurationMs = assertRepositoryPositiveInteger(
        input.leaseDurationMs,
        "lease_duration",
        300_000
      );
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.projection_dirty_scopes
        SET lease_expires_at = ${new Date(Date.parse(now)
              + leaseDurationMs).toISOString()},
            heartbeat_at = ${now}, updated_at = ${now}
        WHERE public_id = ${assertRepositoryIdentity(input.publicId, "public_id")}
          AND state = 'running'
          AND lease_owner = ${assertRepositoryIdentity(input.workerId, "worker_id")}
          AND lease_generation = ${assertRepositoryPositiveInteger(
            input.leaseGeneration,
            "lease_generation"
          )}
          AND lease_expires_at > ${now}
        RETURNING public_id
      `;
      return rows.length === 1;
    },

    async complete(input: {
      publicId: string;
      workerId: string;
      leaseGeneration?: number;
      renderedSequence: number;
      now: string;
    }): Promise<"completed" | "waiting" | null> {
      const now = assertRepositoryTimestamp(input.now, "now");
      const rows = await sql<Array<{ state: "completed" | "waiting" }>>`
        UPDATE focowiki.projection_dirty_scopes
        SET completed_sequence = greatest(
              completed_sequence,
              least(required_sequence, ${assertRepositoryPositiveInteger(
                input.renderedSequence,
                "rendered_sequence"
              )})
            ),
            state = CASE
              WHEN greatest(
                completed_sequence,
                least(required_sequence, ${input.renderedSequence})
              ) >= required_sequence
              THEN 'completed' ELSE 'waiting'
            END,
            attempt_count = 0,
            lease_owner = NULL, lease_expires_at = NULL,
            heartbeat_at = NULL,
            next_eligible_at = ${now}, coalesce_until = ${now},
            safe_error_code = NULL, safe_error_message = NULL,
            retryable = false, updated_at = ${now}
        WHERE public_id = ${assertRepositoryIdentity(input.publicId, "public_id")}
          AND state = 'running'
          AND lease_owner = ${assertRepositoryIdentity(input.workerId, "worker_id")}
          AND (${input.leaseGeneration ?? null}::bigint IS NULL OR (
            lease_generation = ${input.leaseGeneration ?? null}
            AND lease_expires_at > ${now}
          ))
        RETURNING state
      `;
      return rows[0]?.state ?? null;
    },

    async fail(input: {
      publicId: string;
      workerId: string;
      leaseGeneration?: number;
      now: string;
      errorCode: string;
      retryable: boolean;
      nextEligibleAt: string | null;
    }): Promise<"waiting" | "error" | null> {
      const now = assertRepositoryTimestamp(input.now, "now");
      if (!input.errorCode
        || Buffer.byteLength(input.errorCode, "utf8") > 128) {
        throw repositoryContractError("invalid_scope_error_code");
      }
      if (input.nextEligibleAt !== null) {
        assertRepositoryTimestamp(input.nextEligibleAt, "next_eligible_at");
      }
      const rows = await sql<Array<{ state: "waiting" | "error" }>>`
        UPDATE focowiki.projection_dirty_scopes
        SET state = CASE
              WHEN ${input.retryable}
                AND ${input.nextEligibleAt}::timestamptz IS NOT NULL
                AND attempt_count < maximum_attempts
              THEN 'waiting' ELSE 'error' END,
            next_eligible_at = coalesce(
              ${input.nextEligibleAt}::timestamptz, ${now}::timestamptz
            ),
            coalesce_until = coalesce(
              ${input.nextEligibleAt}::timestamptz, ${now}::timestamptz
            ),
            lease_owner = NULL, lease_expires_at = NULL,
            heartbeat_at = NULL,
            safe_error_code = ${input.errorCode},
            safe_error_message = NULL, retryable = ${input.retryable},
            updated_at = ${now}
        WHERE public_id = ${assertRepositoryIdentity(input.publicId, "public_id")}
          AND state = 'running'
          AND lease_owner = ${assertRepositoryIdentity(input.workerId, "worker_id")}
          AND (${input.leaseGeneration ?? null}::bigint IS NULL OR (
            lease_generation = ${input.leaseGeneration ?? null}
            AND lease_expires_at > ${now}
          ))
        RETURNING state
      `;
      return rows[0]?.state ?? null;
    },

    async recoverExpired(input: {
      now: string;
      retryAt: string;
      limit: number;
    }): Promise<number> {
      const now = assertRepositoryTimestamp(input.now, "now");
      const retryAt = assertRepositoryTimestamp(input.retryAt, "retry_at");
      const rows = await sql<Array<{ public_id: string }>>`
        WITH expired AS (
          SELECT public_id
          FROM focowiki.projection_dirty_scopes
          WHERE state = 'running' AND lease_expires_at <= ${now}
          ORDER BY lease_expires_at, public_id
          FOR UPDATE SKIP LOCKED
          LIMIT ${assertRepositoryPositiveInteger(input.limit, "limit", 256)}
        )
        UPDATE focowiki.projection_dirty_scopes scope
        SET state = CASE WHEN scope.attempt_count < scope.maximum_attempts
              THEN 'waiting' ELSE 'error' END,
            next_eligible_at = ${retryAt}, coalesce_until = ${retryAt},
            lease_owner = NULL, lease_expires_at = NULL,
            heartbeat_at = NULL,
            safe_error_code = 'PROJECTION_SCOPE_LEASE_EXPIRED',
            safe_error_message = NULL, retryable = true,
            updated_at = ${now}
        FROM expired
        WHERE scope.public_id = expired.public_id
        RETURNING scope.public_id
      `;
      return rows.length;
    }
  };
}
