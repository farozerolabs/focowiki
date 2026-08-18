import type { TransactionSql } from "postgres";

export type DocumentWorkTerminalState = "cancelled" | "superseded";

export async function terminalizePostgresDocumentWork(input: {
  sql: TransactionSql;
  documentJobPublicIds: readonly string[];
  state: DocumentWorkTerminalState;
  terminalAt: string;
}): Promise<void> {
  if (input.documentJobPublicIds.length === 0) return;
  await input.sql`
    UPDATE focowiki.document_artifact_work
    SET state = ${input.state}, lease_owner = NULL, lease_expires_at = NULL,
        retryable = false, ended_at = coalesce(ended_at, ${input.terminalAt}),
        updated_at = ${input.terminalAt}
    WHERE document_job_public_id = ANY(${input.documentJobPublicIds}::text[])
      AND state IN ('waiting', 'running', 'error')
  `;
}
