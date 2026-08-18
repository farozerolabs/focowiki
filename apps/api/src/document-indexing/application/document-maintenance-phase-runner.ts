import type {
  StorageVnextMaintenancePhaseRunner,
  StorageVnextMaintenancePhaseResult
} from "../../storage-vnext/maintenance/ports.js";

export type DocumentMaintenancePort = {
  prepare(input: MaintenanceContext): Promise<{ documentCount: number }>;
  schedulePage(input: MaintenanceContext & {
    cursor: string | null;
  }): Promise<{
    scheduledCount: number;
    processedBytes: number;
    nextCursor: string | null;
    documentCount: number;
  }>;
  readProgress(input: MaintenanceContext): Promise<{
    documentCount: number;
    availableCount: number;
    errorCount: number;
    pendingCount: number;
  }>;
  reconcile?(input: MaintenanceContext & { cursor: string | null }): Promise<{
    processedCount: number;
    nextCursor: string | null;
  }>;
  validate(input: MaintenanceContext): Promise<void>;
  activate(input: MaintenanceContext): Promise<void>;
  cleanup(input: MaintenanceContext): Promise<void>;
};

type MaintenanceContext = {
  knowledgeBaseId: string;
  operationPublicId: string;
  checkpoint: Parameters<StorageVnextMaintenancePhaseRunner["runPhase"]>[0]["checkpoint"];
  signal: AbortSignal;
};

export function createDocumentMaintenancePhaseRunner(input: {
  maintenance: DocumentMaintenancePort;
  isReconciliationEnabled?: () => Promise<boolean>;
}): StorageVnextMaintenancePhaseRunner {
  return {
    async runPhase(request) {
      const context: MaintenanceContext = {
        knowledgeBaseId: request.knowledgeBaseId,
        operationPublicId: request.operationPublicId,
        checkpoint: request.checkpoint,
        signal: request.signal
      };
      if (request.signal.aborted) throw request.signal.reason;
      switch (request.checkpoint.phase) {
        case "planning": {
          const result = await input.maintenance.prepare(context);
          return completed(0, result.documentCount, 0);
        }
        case "search_rebuild": {
          const page = await input.maintenance.schedulePage({
            ...context,
            cursor: request.checkpoint.cursor
          });
          return page.nextCursor
            ? progress(page.nextCursor, page.documentCount, page.processedBytes)
            : completed(0, page.documentCount, page.processedBytes);
        }
        case "projection_repair": {
          const status = await input.maintenance.readProgress(context);
          if (status.errorCount > 0) {
            throw maintenanceError("document_maintenance_source_failed");
          }
          const completedDelta = availableDelta(
            status.availableCount,
            request.checkpoint.completedCount
          );
          if (status.pendingCount > 0) {
            return progress(
              "awaiting-document-jobs",
              status.documentCount,
              0,
              completedDelta
            );
          }
          if (status.availableCount !== status.documentCount) {
            throw maintenanceError("document_maintenance_progress_invalid");
          }
          return completed(completedDelta, status.documentCount, 0);
        }
        case "object_reconciliation": {
          const reconciliationEnabled = await input.isReconciliationEnabled?.()
            ?? false;
          if (!reconciliationEnabled) {
            return completed(0, request.checkpoint.expectedCount, 0);
          }
          if (!input.maintenance.reconcile) {
            throw maintenanceError("document_reconciliation_unavailable");
          }
          const page = await input.maintenance.reconcile({
            ...context,
            cursor: request.checkpoint.cursor
          });
          return page.nextCursor
            ? progress(page.nextCursor, request.checkpoint.expectedCount, 0)
            : completed(0, request.checkpoint.expectedCount, 0);
        }
        case "catch_up":
          return completed(0, request.checkpoint.expectedCount, 0);
        case "validation":
          await input.maintenance.validate(context);
          return completed(0, request.checkpoint.expectedCount, 0);
        case "activation":
          await input.maintenance.activate(context);
          return completed(0, request.checkpoint.expectedCount, 0);
        case "cleanup":
          await input.maintenance.cleanup(context);
          return completed(0, request.checkpoint.expectedCount, 0);
      }
    }
  };
}

function completed(
  completedDelta: number,
  expectedCount: number,
  processedBytesDelta: number
): StorageVnextMaintenancePhaseResult {
  return {
    outcome: "phase_completed",
    completedDelta,
    expectedCount,
    processedBytesDelta
  };
}

function progress(
  cursor: string,
  expectedCount: number,
  processedBytesDelta: number,
  completedDelta = 0
): StorageVnextMaintenancePhaseResult {
  return {
    outcome: "progress",
    cursor,
    completedDelta,
    expectedCount,
    processedBytesDelta
  };
}

function availableDelta(availableCount: number, completedCount: number): number {
  if (availableCount < completedCount) {
    throw maintenanceError("document_maintenance_progress_invalid");
  }
  return availableCount - completedCount;
}

function maintenanceError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document maintenance error: ${code}`), { code });
}
