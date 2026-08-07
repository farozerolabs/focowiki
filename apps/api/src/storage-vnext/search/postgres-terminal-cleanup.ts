import type { DatabaseClient } from "../../db/client.js";

export function createPostgresStorageVnextSearchTerminalCleanup(
  sql: DatabaseClient
) {
  return {
    async abandonCandidate(input: {
      candidatePublicId: string;
      safeErrorCode: string;
    }): Promise<boolean> {
      assertId(input.candidatePublicId);
      assertId(input.safeErrorCode);
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.search_projections
        SET state = 'failed', safe_error_code = ${input.safeErrorCode},
            correlation_public_id = NULL, provider_operation_ref = NULL,
            revision = revision + CASE
              WHEN state = 'failed' AND safe_error_code = ${input.safeErrorCode}
                THEN 0 ELSE 1 END,
            updated_at = now()
        WHERE public_id = ${input.candidatePublicId}
          AND projection_role = 'candidate'
        RETURNING public_id
      `;
      return rows.length === 1;
    }
  };
}

function assertId(value: string): void {
  if (!value || Buffer.byteLength(value) > 255) {
    throw Object.assign(
      new Error("Storage vNext search terminal cleanup error: invalid_input"),
      { code: "invalid_input" }
    );
  }
}
