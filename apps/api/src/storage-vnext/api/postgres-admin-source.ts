import { createHash, randomUUID } from "node:crypto";
import type { RuntimeSettingsService } from "../../runtime-settings/service.js";
import type { StorageVnextCatalogRepository } from "../catalog/ports.js";
import type { createStorageVnextDeletionCoordinator } from "../deletion/deletion-coordinator.js";
import type { StorageVnextWorkflowRepository } from "../workflow/postgres-repository.js";
import type { StorageVnextAdminSourceApplication } from "./admin-source-application.js";

const SOURCE_RESULT_RETENTION_MS = 24 * 60 * 60 * 1_000;

export function createPostgresStorageVnextAdminSource(input: {
  catalog: StorageVnextCatalogRepository;
  workflow: StorageVnextWorkflowRepository;
  deletion: ReturnType<typeof createStorageVnextDeletionCoordinator>;
  runtimeSettings: RuntimeSettingsService;
}): StorageVnextAdminSourceApplication {
  return {
    async retrySourceFile(request) {
      const knowledgeBase = await input.catalog.getKnowledgeBase(request);
      if (!knowledgeBase) return failure("NOT_FOUND");
      const file = await input.catalog.getSourceFile({
        knowledgeBaseId: request.knowledgeBaseId,
        publicId: request.sourceFileId
      });
      if (!file) return failure("NOT_FOUND");
      if (file.status !== "failed") return failure("SOURCE_FILE_RETRY_NOT_ALLOWED");
      const revision = await input.catalog.getCurrentSourceRevision({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFilePublicId: request.sourceFileId
      });
      if (!revision) return failure("SOURCE_FILE_RETRY_RESOURCE_CONFLICT");
      const settingsRevision = await input.runtimeSettings.getCurrentRevision();
      const idempotencyKey = `source-retry:${file.publicId}:${revision.publicId}`;
      const requestHash = createHash("sha256")
        .update(`storage-vnext-source-retry-v1\0${request.knowledgeBaseId}\0${file.publicId}\0${revision.publicId}`)
        .digest("hex");
      const existing = await input.workflow.findIdempotent({
        knowledgeBaseId: request.knowledgeBaseId,
        key: idempotencyKey,
        requestHash
      });
      if (existing) {
        return success({
          file: toAdminFile(file, revision, existing.type === "live" ? existing.work.attempt : 0),
          retry: { kind: "source_processing", scope: "source_file", coalesced: true }
        });
      }
      const now = new Date();
      const operationPublicId = `source-retry-${randomUUID()}`;
      await input.workflow.enqueue({
        publicId: operationPublicId,
        knowledgeBaseId: request.knowledgeBaseId,
        kind: "source",
        searchProviderKind: null,
        state: "queued",
        operationRevision: 1,
        settingsRevisionPublicId: settingsRevision.publicId,
        attempt: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        safeErrorCode: null,
        checkpoint: {
          sourceFilePublicId: file.publicId,
          sourceRevisionPublicId: revision.publicId
        },
        idempotency: {
          key: idempotencyKey,
          requestHash,
          expiresAt: new Date(now.getTime() + SOURCE_RESULT_RETENTION_MS).toISOString()
        }
      });
      const updated = await input.catalog.updateSourceFileState({
        knowledgeBaseId: request.knowledgeBaseId,
        publicId: file.publicId,
        metadata: file.metadata,
        status: "pending",
        safeErrorCode: null,
        safeErrorMessage: null,
        revisionCheck: { expectedRevision: file.revision }
      });
      return success({
        file: toAdminFile(updated, revision, 0),
        retry: { kind: "source_processing", scope: "source_file", coalesced: false }
      });
    },

    async deleteSourceFileTasks(request) {
      const knowledgeBase = await input.catalog.getKnowledgeBase(request);
      if (!knowledgeBase) return failure("NOT_FOUND");
      const settingsRevision = await input.runtimeSettings.getCurrentRevision();
      const now = new Date();
      const results = await input.deletion.deleteSourceTasks({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFilePublicIds: request.sourceFileIds,
        deletedAt: now.toISOString(),
        settingsRevisionPublicId: settingsRevision.publicId,
        resultExpiresAt: new Date(now.getTime() + SOURCE_RESULT_RETENTION_MS).toISOString()
      });
      const mapped = results.map((result) => {
        const base = {
          sourceFileId: result.sourceFilePublicId,
          status: result.outcome
        };
        if (result.outcome === "skipped") {
          return { ...base, reason: result.reason };
        }
        if (result.outcome === "hidden") {
          return {
            ...base,
            ...(result.generatedFilePublicId
              ? { generatedFileId: result.generatedFilePublicId }
              : {}),
            ...(result.generatedFilePath
              ? { generatedFilePath: result.generatedFilePath }
              : {})
          };
        }
        return base;
      });
      return success({
        results: mapped,
        summary: {
          deleted: results.filter((result) => result.outcome === "deleted").length,
          hidden: results.filter((result) => result.outcome === "hidden").length,
          skipped: results.filter((result) => result.outcome === "skipped").length
        }
      });
    }
  };
}

function toAdminFile(
  file: Awaited<ReturnType<StorageVnextCatalogRepository["getSourceFile"]>> extends infer T
    ? Exclude<T, null>
    : never,
  revision: Awaited<ReturnType<StorageVnextCatalogRepository["getCurrentSourceRevision"]>> extends infer T
    ? Exclude<T, null>
    : never,
  retryCount: number
) {
  return {
    id: file.publicId,
    name: file.title,
    relativePath: file.logicalPath,
    resourceRevision: file.revision,
    contentType: revision.contentType,
    sizeBytes: revision.byteCount,
    metadata: file.metadata,
    modelSuggestions: null,
    processingStartedAt: null,
    processingEndedAt: null,
    retryCount,
    modelInvocationStatus: null,
    modelInvocationModelName: null,
    modelInvocationStartedAt: null,
    modelInvocationEndedAt: null,
    modelInvocationWarningCount: null,
    modelInvocationErrorCode: null,
    generatedOutputStatus: "pending",
    generatedFileAvailable: false,
    generatedFilePath: null,
    generatedFileId: null,
    graphSummary: null,
    state: file.status === "processing" ? "running" : file.status === "failed" ? "failed" : "queued",
    currentStage: "metadata_resolution",
    failure: file.status === "failed"
      ? {
          stage: "metadata_resolution",
          code: file.safeErrorCode ?? "SOURCE_PROCESSING_FAILED",
          message: file.safeErrorMessage ?? "Source processing failed.",
          occurredAt: new Date().toISOString(),
          retryKind: "source_processing",
          correlationId: file.publicId
        }
      : null,
    actions: [],
    createdAt: revision.createdAt
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
