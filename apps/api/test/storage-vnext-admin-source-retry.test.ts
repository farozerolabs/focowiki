import { describe, expect, it, vi } from "vitest";
import { createPostgresStorageVnextAdminSource } from
  "../src/storage-vnext/api/postgres-admin-source.js";
import type { DocumentRetryOutcome } from
  "../src/document-indexing/infrastructure/postgres-document-retry.js";

describe("document source retry Admin application", () => {
  it("returns a fresh waiting prepare presentation without stale terminal actions", async () => {
    const retryCurrentDocument = vi.fn(async (): Promise<DocumentRetryOutcome> => ({
      outcome: "accepted",
      documentJobPublicId: "document-job-retry",
      operationPublicId: "operation-retry",
      sourceFilePublicId: "source-file-retry",
      sourceRevisionPublicId: "source-revision-retry",
      activeSourceRevisionPublicId: "source-revision-previous",
      activeGeneratedPath: "pages/guide.md",
      logicalPath: "guide.md",
      title: "Guide",
      metadata: { topic: "general" },
      resourceRevision: 2,
      byteCount: 16,
      contentType: "text/markdown; charset=utf-8",
      createdAt: "2026-08-14T00:00:00.000Z",
      retryCount: 2,
      jobRevision: 8
    }));
    const application = createPostgresStorageVnextAdminSource(
      fixture(retryCurrentDocument)
    );

    await expect(application.retrySourceFile({
      knowledgeBaseId: "knowledge-base-retry",
      sourceFileId: "source-file-retry"
    })).resolves.toEqual({
      ok: true,
      value: {
        file: {
          id: "source-file-retry",
          name: "Guide",
          relativePath: "guide.md",
          resourceRevision: 2,
          contentType: "text/markdown; charset=utf-8",
          sizeBytes: 16,
          metadata: { topic: "general" },
          processingStartedAt: null,
          processingEndedAt: null,
          retryCount: 2,
          modelInvocationStatus: null,
          modelInvocationModelName: null,
          modelInvocationStartedAt: null,
          modelInvocationEndedAt: null,
          modelInvocationWarningCount: null,
          modelInvocationErrorCode: null,
          modelLayerExecutions: [],
          generatedOutputStatus: "previous_available",
          generatedFileAvailable: true,
          generatedFilePath: "pages/guide.md",
          generatedFileId: "source-file-retry",
          state: "waiting",
          requiredWorkCount: 8,
          completedWorkCount: 0,
          activeWorkKinds: [],
          blockingWorkKind: "prepare",
          retryingWorkKind: null,
          failure: null,
          actions: [],
          createdAt: "2026-08-14T00:00:00.000Z"
        },
        retry: {
          kind: "document_processing",
          scope: "source_file",
          coalesced: false
        }
      }
    });
    expect(retryCurrentDocument).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBaseId: "knowledge-base-retry",
      sourceFilePublicId: "source-file-retry",
      retriedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u)
    }));
  });

  it.each([
    ["not_found", "NOT_FOUND"],
    ["already_running", "SOURCE_FILE_RETRY_ALREADY_RUNNING"],
    ["not_allowed", "SOURCE_FILE_RETRY_NOT_ALLOWED"],
    ["resource_conflict", "SOURCE_FILE_RETRY_RESOURCE_CONFLICT"]
  ] as const)("maps %s to %s", async (outcome, code) => {
    const application = createPostgresStorageVnextAdminSource(
      fixture(vi.fn(async () => ({ outcome })))
    );
    await expect(application.retrySourceFile({
      knowledgeBaseId: "knowledge-base-retry",
      sourceFileId: "source-file-retry"
    })).resolves.toEqual({ ok: false, code });
  });
});

function fixture(
  retryCurrentDocument: Parameters<
    typeof createPostgresStorageVnextAdminSource
  >[0]["retryCurrentDocument"]
): Parameters<typeof createPostgresStorageVnextAdminSource>[0] {
  return {
    retryCurrentDocument,
    removeDocumentTasks: vi.fn(async () => [])
  };
}
