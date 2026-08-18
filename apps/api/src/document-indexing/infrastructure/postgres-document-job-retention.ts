import type { DatabaseClient } from "../../db/client.js";

export function createPostgresDocumentJobRetention(sql: DatabaseClient) {
  return {
    async deleteRetained(input: { terminalBefore: string; limit: number }) {
      validateTimestamp(input.terminalBefore);
      validateLimit(input.limit);
      const rows = await sql<Array<{ public_id: string }>>`
        WITH retained AS (
          SELECT public_id
          FROM focowiki.document_processing_jobs
          WHERE state IN ('available', 'cancelled', 'superseded')
            AND terminal_at < ${input.terminalBefore}
          ORDER BY terminal_at, public_id COLLATE "C"
          FOR UPDATE SKIP LOCKED
          LIMIT ${input.limit}
        )
        DELETE FROM focowiki.document_processing_jobs job
        USING retained
        WHERE job.public_id = retained.public_id
        RETURNING job.public_id
      `;
      return rows.length;
    }
  };
}

function validateTimestamp(value: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw retentionError("invalid_timestamp");
  }
}

function validateLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw retentionError("invalid_limit");
  }
}

function retentionError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document job retention error: ${code}`), { code });
}
