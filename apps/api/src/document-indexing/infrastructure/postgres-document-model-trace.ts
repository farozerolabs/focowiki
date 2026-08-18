import type { DatabaseClient } from "../../db/client.js";
import type { DocumentModelTrace } from "../domain/contracts.js";

export function createPostgresDocumentModelTraceRepository(sql: DatabaseClient) {
  return {
    async record(input: {
      documentJobPublicId: string;
      trace: DocumentModelTrace;
    }): Promise<void> {
      const updated = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.document_processing_jobs
        SET model_status = ${input.trace.status},
            model_name = ${input.trace.modelName},
            model_started_at = ${input.trace.startedAt},
            model_ended_at = ${input.trace.endedAt},
            model_warning_count = ${input.trace.warningCount},
            model_error_code = ${input.trace.errorCode},
            updated_at = now()
        WHERE public_id = ${input.documentJobPublicId}
          AND state = 'processing'
        RETURNING public_id
      `;
      if (updated.length !== 1) throw traceError("document_job_unavailable");
    }
  };
}

function traceError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document model trace error: ${code}`), { code });
}
