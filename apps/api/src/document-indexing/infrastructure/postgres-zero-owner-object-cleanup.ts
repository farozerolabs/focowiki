import type { DatabaseClient } from "../../db/client.js";

export function createPostgresZeroOwnerObjectCleanup(sql: DatabaseClient) {
  return {
    async recoverStale(input: {
      expiredBefore: string;
      notBefore: string;
      safeErrorCode: string;
      limit: number;
    }): Promise<number> {
      const rows = await sql<Array<{ public_id: string }>>`
        WITH stale AS (
          SELECT public_id FROM focowiki.cleanup_actions
          WHERE action_kind = 'zero_owner_object'
            AND cleanup_plane = 'object_storage'
            AND state = 'running' AND lease_expires_at <= ${input.expiredBefore}
          ORDER BY lease_expires_at, public_id COLLATE "C"
          FOR UPDATE SKIP LOCKED LIMIT ${input.limit}
        )
        UPDATE focowiki.cleanup_actions action
        SET state = 'retry', lease_owner = NULL, lease_expires_at = NULL,
            not_before = ${input.notBefore},
            safe_error_code = ${input.safeErrorCode}, updated_at = now()
        FROM stale WHERE action.public_id = stale.public_id
        RETURNING action.public_id
      `;
      return rows.length;
    },

    async claim(input: {
      owner: string;
      limit: number;
      leaseExpiresAt: string;
    }) {
      const rows = await sql<Array<{
        public_id: string;
        resource_public_id: string;
        attempt_count: number | string;
        maximum_attempts: number | string;
      }>>`
        WITH candidates AS (
          SELECT public_id FROM focowiki.cleanup_actions
          WHERE action_kind = 'zero_owner_object'
            AND cleanup_plane = 'object_storage'
            AND state IN ('queued', 'retry') AND not_before <= now()
          ORDER BY priority, not_before, sequence_number, public_id COLLATE "C"
          FOR UPDATE SKIP LOCKED
          LIMIT ${input.limit}
        )
        UPDATE focowiki.cleanup_actions action
        SET state = 'running', attempt_count = action.attempt_count + 1,
            lease_owner = ${input.owner},
            lease_expires_at = ${input.leaseExpiresAt},
            safe_error_code = NULL, updated_at = now()
        FROM candidates
        WHERE action.public_id = candidates.public_id
        RETURNING action.public_id, action.resource_public_id,
                  action.attempt_count, action.maximum_attempts
      `;
      return rows.map((row) => ({
        publicId: row.public_id,
        objectId: row.resource_public_id,
        attempt: Number(row.attempt_count),
        maximumAttempts: Number(row.maximum_attempts)
      }));
    },

    complete(input: { publicId: string; owner: string; completedAt: string }) {
      return transition(sql, input, "completed", null, input.completedAt);
    },

    retry(input: {
      publicId: string;
      owner: string;
      notBefore: string;
      safeErrorCode: string;
    }) {
      return transition(sql, input, "retry", input.safeErrorCode,
        input.notBefore);
    },

    fail(input: {
      publicId: string;
      owner: string;
      failedAt: string;
      safeErrorCode: string;
    }) {
      return transition(sql, input, "failed", input.safeErrorCode,
        input.failedAt);
    }
  };
}

async function transition(
  sql: DatabaseClient,
  input: { publicId: string; owner: string },
  state: "completed" | "retry" | "failed",
  safeErrorCode: string | null,
  timestamp: string
): Promise<boolean> {
  const rows = await sql<Array<{ public_id: string }>>`
    UPDATE focowiki.cleanup_actions
    SET state = ${state}, lease_owner = NULL, lease_expires_at = NULL,
        safe_error_code = ${safeErrorCode},
        not_before = CASE WHEN ${state} = 'retry' THEN ${timestamp}
                          ELSE not_before END,
        completed_at = CASE WHEN ${state} IN ('completed', 'failed')
                            THEN ${timestamp} ELSE completed_at END,
        updated_at = ${timestamp}
    WHERE public_id = ${input.publicId}
      AND action_kind = 'zero_owner_object'
      AND state = 'running' AND lease_owner = ${input.owner}
    RETURNING public_id
  `;
  return rows.length === 1;
}
