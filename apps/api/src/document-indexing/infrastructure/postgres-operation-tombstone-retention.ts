import type { DatabaseClient } from "../../db/client.js";

export function createPostgresOperationTombstoneRetention(sql: DatabaseClient) {
  return {
    async deleteExpired(input: { expiredBefore: string; limit: number }) {
      validate(input);
      const rows = await sql<Array<{ public_id: string }>>`
        WITH expired AS (
          SELECT public_id
          FROM focowiki.operation_tombstones
          WHERE expires_at <= ${input.expiredBefore}
          ORDER BY expires_at, public_id COLLATE "C"
          FOR UPDATE SKIP LOCKED
          LIMIT ${input.limit}
        )
        DELETE FROM focowiki.operation_tombstones tombstone
        USING expired
        WHERE tombstone.public_id = expired.public_id
        RETURNING tombstone.public_id
      `;
      return rows.length;
    }
  };
}

function validate(input: { expiredBefore: string; limit: number }): void {
  const timestamp = new Date(input.expiredBefore);
  if (
    !Number.isFinite(timestamp.getTime())
    || timestamp.toISOString() !== input.expiredBefore
    || !Number.isSafeInteger(input.limit)
    || input.limit < 1
    || input.limit > 1_000
  ) throw new Error("Invalid operation tombstone retention request");
}
