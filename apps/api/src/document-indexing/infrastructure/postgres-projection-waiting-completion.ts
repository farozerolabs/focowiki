import type { DatabaseClient } from "../../db/client.js";
import { artifactWorkTransaction } from "./document-artifact-work-validation.js";
import { failPostgresDocumentsBlockedByProjectionScopes } from
  "./postgres-projection-scope-failure.js";

export async function completeReadyPostgresProjectionWaiters(input: {
  sql: DatabaseClient;
  now: string;
  limit: number;
  documentJobPublicIds?: readonly string[];
  detectFailures?: boolean;
  webhookRetentionMilliseconds?: number;
  complete(publicId: string): Promise<boolean>;
}): Promise<number> {
  if (input.detectFailures === true) {
    await artifactWorkTransaction(input.sql, (transaction) =>
      failPostgresDocumentsBlockedByProjectionScopes({
        transaction,
        now: input.now,
        limit: input.limit,
        webhookRetentionMilliseconds: input.webhookRetentionMilliseconds
      }));
  }
  const documentJobPublicIds = input.documentJobPublicIds === undefined
    ? null
    : [...new Set(input.documentJobPublicIds)].slice(0, 256);
  if (documentJobPublicIds?.length === 0) return 0;
  const ready = await input.sql<Array<{ work_public_id: string }>>`
    SELECT pending.work_public_id
    FROM focowiki.document_projection_waiting_completions pending
    JOIN focowiki.document_artifact_work work
      ON work.public_id = pending.work_public_id
     AND work.state = 'waiting_on_projection'
    WHERE (${documentJobPublicIds}::text[] IS NULL
      OR pending.document_job_public_id = ANY(${documentJobPublicIds}::text[]))
      AND NOT EXISTS (
      SELECT 1
      FROM focowiki.projection_scope_contributions contribution
      WHERE contribution.document_job_public_id = pending.document_job_public_id
        AND contribution.state = 'waiting'
    )
    ORDER BY pending.created_at, pending.work_public_id
    LIMIT ${input.limit}
  `;
  let completed = 0;
  for (let offset = 0; offset < ready.length; offset += 8) {
    const page = await Promise.all(ready.slice(offset, offset + 8).map((row) =>
      input.complete(row.work_public_id)));
    completed += page.filter(Boolean).length;
  }
  return completed;
}
