import type { DatabaseClient } from "../../db/client.js";
import { artifactWorkTransaction } from "./document-artifact-work-validation.js";
import { failPostgresDocumentsBlockedByProjectionScopes } from
  "./postgres-projection-scope-failure.js";

export async function completeReadyPostgresProjectionWaiters(input: {
  sql: DatabaseClient;
  now: string;
  limit: number;
  webhookRetentionMilliseconds?: number;
  complete(publicId: string): Promise<boolean>;
}): Promise<number> {
  await artifactWorkTransaction(input.sql, (transaction) =>
    failPostgresDocumentsBlockedByProjectionScopes({
      transaction,
      now: input.now,
      limit: input.limit,
      webhookRetentionMilliseconds: input.webhookRetentionMilliseconds
    }));
  const ready = await input.sql<Array<{ work_public_id: string }>>`
    SELECT pending.work_public_id
    FROM focowiki.document_projection_waiting_completions pending
    JOIN focowiki.document_artifact_work work
      ON work.public_id = pending.work_public_id
     AND work.state = 'waiting_on_projection'
    WHERE NOT EXISTS (
      SELECT 1
      FROM focowiki.projection_scope_contributions contribution
      WHERE contribution.document_job_public_id = pending.document_job_public_id
        AND contribution.state = 'waiting'
    )
    ORDER BY pending.created_at, pending.work_public_id
    LIMIT ${input.limit}
  `;
  let completed = 0;
  for (const row of ready) {
    if (await input.complete(row.work_public_id)) completed += 1;
  }
  return completed;
}
