import type { DocumentRetryOutcome } from
  "../../document-indexing/infrastructure/postgres-document-retry.js";
import type { DocumentTaskRemovalOutcome } from
  "../../document-indexing/infrastructure/postgres-document-task-removal.js";
import type { StorageVnextAdminSourceApplication } from "./admin-source-application.js";

const SOURCE_RESULT_RETENTION_MS = 24 * 60 * 60 * 1_000;

export function createPostgresStorageVnextAdminSource(input: {
  retryCurrentDocument(input: {
    knowledgeBaseId: string;
    sourceFilePublicId: string;
    retriedAt: string;
  }): Promise<DocumentRetryOutcome>;
  removeDocumentTasks(input: {
    knowledgeBaseId: string;
    sourceFilePublicIds: readonly string[];
    removedAt: string;
    resultExpiresAt: string;
  }): Promise<readonly DocumentTaskRemovalOutcome[]>;
}): StorageVnextAdminSourceApplication {
  return {
    async retrySourceFile(request) {
      const result = await input.retryCurrentDocument({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFilePublicId: request.sourceFileId,
        retriedAt: new Date().toISOString()
      });
      if (result.outcome === "not_found") return failure("NOT_FOUND");
      if (result.outcome === "already_running") {
        return failure("SOURCE_FILE_RETRY_ALREADY_RUNNING");
      }
      if (result.outcome === "not_allowed") {
        return failure("SOURCE_FILE_RETRY_NOT_ALLOWED");
      }
      if (result.outcome === "resource_conflict") {
        return failure("SOURCE_FILE_RETRY_RESOURCE_CONFLICT");
      }
      return success({
        file: toAdminRetryFile(result),
        retry: {
          kind: "document_processing",
          scope: "source_file",
          coalesced: false
        }
      });
    },

    async deleteSourceFileTasks(request) {
      const now = new Date();
      const results = await input.removeDocumentTasks({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFilePublicIds: request.sourceFileIds,
        removedAt: now.toISOString(),
        resultExpiresAt: new Date(now.getTime() + SOURCE_RESULT_RETENTION_MS).toISOString()
      });
      const mapped = results.map((result) => {
        if (result.outcome === "source_deletion_accepted") return {
          sourceFileId: result.sourceFilePublicId,
          status: "deleted",
          durableOutcome: result.outcome
        };
        if (result.outcome === "failed_attempt_removed") return {
          sourceFileId: result.sourceFilePublicId,
          status: "hidden",
          durableOutcome: result.outcome,
          activeSourceRevisionPublicId: result.activeSourceRevisionPublicId
        };
        return {
          sourceFileId: result.sourceFilePublicId,
          status: "skipped",
          durableOutcome: result.outcome,
          reason: result.reason
        };
      });
      return success({
        results: mapped,
        summary: {
          deleted: results.filter((result) =>
            result.outcome === "source_deletion_accepted").length,
          hidden: results.filter((result) =>
            result.outcome === "failed_attempt_removed").length,
          skipped: results.filter((result) => result.outcome === "skipped").length
        }
      });
    }
  };
}

function toAdminRetryFile(result: Extract<DocumentRetryOutcome, { outcome: "accepted" }>) {
  const hasPreviousOutput = result.activeSourceRevisionPublicId !== null
    && result.activeSourceRevisionPublicId !== result.sourceRevisionPublicId
    && result.activeGeneratedPath !== null;
  return {
    id: result.sourceFilePublicId,
    name: result.title,
    relativePath: result.logicalPath,
    resourceRevision: result.resourceRevision,
    contentType: result.contentType,
    sizeBytes: result.byteCount,
    metadata: result.metadata,
    processingStartedAt: null,
    processingEndedAt: null,
    retryCount: result.retryCount,
    modelInvocationStatus: null,
    modelInvocationModelName: null,
    modelInvocationStartedAt: null,
    modelInvocationEndedAt: null,
    modelInvocationWarningCount: null,
    modelInvocationErrorCode: null,
    modelLayerExecutions: [],
    generatedOutputStatus: hasPreviousOutput ? "previous_available" : "unavailable",
    generatedFileAvailable: hasPreviousOutput,
    generatedFilePath: hasPreviousOutput ? result.activeGeneratedPath : null,
    generatedFileId: hasPreviousOutput ? result.sourceFilePublicId : null,
    state: "waiting",
    requiredWorkCount: 8,
    completedWorkCount: 0,
    activeWorkKinds: [],
    blockingWorkKind: "prepare",
    retryingWorkKind: null,
    failure: null,
    actions: [],
    createdAt: result.createdAt
  };
}

function success<T>(value: T) {
  return { ok: true as const, value };
}

function failure(code: Exclude<
  Awaited<ReturnType<StorageVnextAdminSourceApplication["retrySourceFile"]>>,
  { ok: true }
>["code"]) {
  return { ok: false as const, code };
}
