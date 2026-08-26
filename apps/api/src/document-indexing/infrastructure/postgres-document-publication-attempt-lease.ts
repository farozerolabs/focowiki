import type { DatabaseClient } from "../../db/client.js";
import {
  DOCUMENT_PUBLICATION_ATTEMPT_MILLISECONDS,
  DOCUMENT_PUBLICATION_MAXIMUM_ATTEMPTS
} from
  "../domain/document-publication-job.js";
import { failPostgresDocumentPublicationJob } from
  "./postgres-document-publication-job-failure.js";

export async function terminalizeExhaustedPostgresPublicationAttempts(
  sql: DatabaseClient,
  now: string
): Promise<void> {
  const exhausted = await sql<Array<{ public_id: string }>>`
    SELECT public_id FROM focowiki.publication_jobs
    WHERE outcome = 'pending'
      AND attempt_count >= ${DOCUMENT_PUBLICATION_MAXIMUM_ATTEMPTS}
      AND attempt_token IS NOT NULL AND attempt_deadline <= ${now}
    ORDER BY public_id COLLATE "C"
    FOR UPDATE SKIP LOCKED
  `;
  for (const job of exhausted) {
    await failPostgresDocumentPublicationJob({
      transaction: sql,
      jobPublicId: job.public_id,
      errorCode: "publication_attempt_limit_exceeded",
      failedAt: now
    });
  }
}

export async function renewPostgresDocumentPublicationAttempt(input: {
  sql: DatabaseClient;
  jobPublicId: string;
  attemptToken: string;
  renewedAt: string;
}): Promise<string | null> {
  const deadline = new Date(Date.parse(input.renewedAt)
    + DOCUMENT_PUBLICATION_ATTEMPT_MILLISECONDS).toISOString();
  const rows = await input.sql<Array<{ attempt_deadline: Date | string }>>`
    UPDATE focowiki.publication_jobs
    SET attempt_deadline = ${deadline}, updated_at = ${input.renewedAt}
    WHERE public_id = ${input.jobPublicId} AND outcome = 'pending'
      AND attempt_token = ${input.attemptToken}
      AND attempt_deadline > ${input.renewedAt}
    RETURNING attempt_deadline
  `;
  return rows[0] ? new Date(rows[0].attempt_deadline).toISOString() : null;
}

export async function releasePostgresDocumentPublicationAttempt(input: {
  sql: DatabaseClient;
  jobPublicId: string;
  attemptToken: string;
  releasedAt: string;
}): Promise<boolean> {
  const rows = await input.sql<Array<{ public_id: string }>>`
    UPDATE focowiki.publication_jobs
    SET attempt_owner = NULL, attempt_token = NULL,
        attempt_started_at = NULL, attempt_deadline = NULL,
        attempt_count = greatest(0, attempt_count - 1),
        manifest_fingerprint_sha256 = NULL,
        manifest_attempt_token = NULL,
        next_eligible_at = ${input.releasedAt}, safe_error_code = NULL,
        updated_at = ${input.releasedAt}
    WHERE public_id = ${input.jobPublicId} AND outcome = 'pending'
      AND attempt_token = ${input.attemptToken}
    RETURNING public_id
  `;
  return rows.length === 1;
}
