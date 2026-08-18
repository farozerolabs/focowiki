import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import type { ClaimedDocumentArtifactWork } from
  "../application/document-work-port.js";
import { ensurePostgresDocumentCleanupIntent } from
  "./postgres-document-cleanup-intent.js";

export function createDocumentCleanupReceiptHandler(input: {
  sql: DatabaseClient;
  now?: () => string;
}) {
  const clock = input.now ?? (() => new Date().toISOString());
  return async (request: {
    claimed: ClaimedDocumentArtifactWork;
    signal: AbortSignal;
  }) => {
    request.signal.throwIfAborted();
    const jobs = await input.sql<Array<{ operation_public_id: string }>>`
      SELECT operation_public_id
      FROM focowiki.document_processing_jobs
      WHERE public_id = ${request.claimed.documentJobPublicId}
        AND knowledge_base_id = ${request.claimed.knowledgeBaseId}
    `;
    if (!jobs[0]) throw cleanupHandlerError("document_job_missing");
    const createdAt = clock();
    const actionPublicIds = await ensurePostgresDocumentCleanupIntent({
      transaction: input.sql,
      knowledgeBaseId: request.claimed.knowledgeBaseId,
      documentJobPublicId: request.claimed.documentJobPublicId,
      operationPublicId: jobs[0].operation_public_id,
      sourceFilePublicId: request.claimed.sourceFilePublicId,
      sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
      affectedSourceFilePublicIds: [request.claimed.sourceFilePublicId],
      createdAt
    });
    return {
      key: "obsolete",
      outputFingerprintSha256: createHash("sha256")
        .update(JSON.stringify(actionPublicIds))
        .digest("hex"),
      value: {
        schemaVersion: "document-cleanup-receipt-v1",
        sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
        actionPublicIds
      },
      serviceEndedAt: createdAt
    };
  };
}

function cleanupHandlerError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document cleanup handler error: ${code}`), {
    code
  });
}

export function waitForDocumentWork(
  milliseconds: number,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}
