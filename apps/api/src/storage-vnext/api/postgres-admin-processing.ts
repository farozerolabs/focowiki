import type { DatabaseClient } from "../../db/client.js";
import type { StorageVnextCatalogReadPort } from "../catalog/ports.js";
import type {
  StorageVnextAdminProcessingApplication,
  StorageVnextAdminProcessingSummary
} from "./admin-processing-application.js";

type ProcessingSummaryRow = {
  waiting_count: number | string;
  processing_count: number | string;
  available_count: number | string;
  error_count: number | string;
  oldest_waiting_at: Date | null;
};

export function createPostgresStorageVnextAdminProcessing(input: {
  sql: DatabaseClient;
  catalog: StorageVnextCatalogReadPort;
}): StorageVnextAdminProcessingApplication {
  return {
    async getProcessingSummary(request) {
      const knowledgeBase = await input.catalog.getKnowledgeBase(request);
      if (!knowledgeBase) return { ok: false, code: "NOT_FOUND" };

      const rows = await input.sql<ProcessingSummaryRow[]>`
        SELECT count(*) FILTER (WHERE job.state = 'waiting') AS waiting_count,
               count(*) FILTER (WHERE job.state = 'processing') AS processing_count,
               count(*) FILTER (WHERE job.state = 'available') AS available_count,
               count(*) FILTER (WHERE job.state = 'error') AS error_count,
               min(job.accepted_at) FILTER (
                 WHERE job.state = 'waiting'
               ) AS oldest_waiting_at
        FROM focowiki.source_files source
        JOIN focowiki.source_file_active_revisions active
          ON active.knowledge_base_id = source.knowledge_base_id
         AND active.source_file_public_id = source.public_id
        JOIN focowiki.document_processing_jobs job
          ON job.knowledge_base_id = active.knowledge_base_id
         AND job.source_file_public_id = active.source_file_public_id
         AND job.source_revision_public_id = active.current_source_revision_public_id
        WHERE source.knowledge_base_id = ${request.knowledgeBaseId}
          AND source.deleted_at IS NULL
      `;
      const row = rows[0];
      const summary: StorageVnextAdminProcessingSummary = {
        waitingCount: count(row?.waiting_count),
        processingCount: count(row?.processing_count),
        availableCount: count(row?.available_count),
        errorCount: count(row?.error_count),
        oldestWaitingAt: row?.oldest_waiting_at?.toISOString() ?? null
      };
      return { ok: true, value: summary };
    }
  };
}

function count(value: number | string | undefined): number {
  const result = Number(value ?? 0);
  return Number.isSafeInteger(result) && result >= 0 ? result : 0;
}
