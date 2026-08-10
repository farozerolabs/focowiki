import { describe, expect, it, vi } from "vitest";
import { createPostgresStorageVnextAdminSource } from
  "../src/storage-vnext/api/postgres-admin-source.js";
import type { StorageVnextWorkflowOutcome } from
  "../src/storage-vnext/workflow/ports.js";
import type { StorageVnextModelInvocationFact } from
  "../src/storage-vnext/catalog/ports.js";

describe("storage vNext source retry", () => {
  it("rejects a ready source before consulting historical idempotency", async () => {
    const fixture = createFixture("ready");
    const application = createPostgresStorageVnextAdminSource(fixture.input);

    await expect(application.retrySourceFile({
      knowledgeBaseId: "knowledge-base-retry",
      sourceFileId: "source-file-retry"
    })).resolves.toEqual({ ok: false, code: "SOURCE_FILE_RETRY_NOT_ALLOWED" });

    expect(fixture.workflow.findIdempotent).not.toHaveBeenCalled();
    expect(fixture.workflow.enqueue).not.toHaveBeenCalled();
    expect(fixture.catalog.updateSourceFileState).not.toHaveBeenCalled();
  });

  it("coalesces a historical retry only while the source remains failed", async () => {
    const fixture = createFixture("failed");
    fixture.workflow.findIdempotent.mockResolvedValueOnce({
      type: "result",
      result: {
        publicId: "source-retry-existing",
        knowledgeBaseId: "knowledge-base-retry",
        kind: "source",
        state: "failed",
        resultCode: "SOURCE_MODEL_FAILED",
        safeMessage: null,
        summary: {},
        correlationPublicId: "source-revision-retry",
        completedAt: "2026-08-02T00:00:00.000Z",
        expiresAt: "2026-08-03T00:00:00.000Z"
      }
    });
    const application = createPostgresStorageVnextAdminSource(fixture.input);

    const result = await application.retrySourceFile({
      knowledgeBaseId: "knowledge-base-retry",
      sourceFileId: "source-file-retry"
    });

    expect(result).toMatchObject({
      ok: true,
      value: { retry: { coalesced: true } }
    });
    expect(fixture.workflow.enqueue).not.toHaveBeenCalled();
  });

  it("keys retry idempotency to the failed source resource revision", async () => {
    const fixture = createFixture("failed");
    const application = createPostgresStorageVnextAdminSource(fixture.input);

    await application.retrySourceFile({
      knowledgeBaseId: "knowledge-base-retry",
      sourceFileId: "source-file-retry"
    });

    expect(fixture.workflow.findIdempotent).toHaveBeenCalledWith({
      knowledgeBaseId: "knowledge-base-retry",
      key: "source-retry:source-file-retry:source-revision-retry:2",
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(fixture.workflow.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      idempotency: expect.objectContaining({
        key: "source-retry:source-file-retry:source-revision-retry:2"
      })
    }));
  });

  it("retries a publication failure without clearing the completed model invocation", async () => {
    const fixture = createFixture("failed");
    fixture.sourceFile.safeErrorCode = "PUBLICATION_FAILED";
    fixture.sourceFile.modelInvocation = {
      sourceRevisionPublicId: fixture.revision.publicId,
      status: "completed",
      modelName: "generation-model",
      startedAt: "2026-08-01T00:00:00.000Z",
      endedAt: "2026-08-01T00:01:00.000Z",
      warningCount: 0,
      errorCode: null
    };
    const application = createPostgresStorageVnextAdminSource(fixture.input);

    await expect(application.retrySourceFile({
      knowledgeBaseId: "knowledge-base-retry",
      sourceFileId: "source-file-retry"
    })).resolves.toMatchObject({
      ok: true,
      value: {
        retry: { kind: "publication", scope: "source_file", coalesced: false }
      }
    });

    expect(fixture.workflow.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      checkpoint: expect.objectContaining({ semanticResumeStage: "publication" })
    }));
    expect(fixture.catalog.updateSourceFileState).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
        modelInvocation: fixture.sourceFile.modelInvocation
      })
    );
  });

  it("does not treat a provider-adoption block as reusable publication work", async () => {
    const fixture = createFixture("failed");
    fixture.sourceFile.safeErrorCode = "semantic_search_provider_adoption_required";
    fixture.sourceFile.modelInvocation = completedModelInvocation(fixture.revision.publicId);
    const application = createPostgresStorageVnextAdminSource(fixture.input);

    await expect(application.retrySourceFile({
      knowledgeBaseId: "knowledge-base-retry",
      sourceFileId: "source-file-retry"
    })).resolves.toMatchObject({
      ok: true,
      value: { retry: { kind: "source_processing" } }
    });

    expect(fixture.workflow.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      checkpoint: {
        sourceFilePublicId: fixture.sourceFile.publicId,
        sourceRevisionPublicId: fixture.revision.publicId
      }
    }));
  });
});

function completedModelInvocation(
  sourceRevisionPublicId: string
): StorageVnextModelInvocationFact {
  return {
    sourceRevisionPublicId,
    status: "completed",
    modelName: "generation-model",
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: "2026-08-01T00:01:00.000Z",
    warningCount: 0,
    errorCode: null
  };
}

function createFixture(status: "ready" | "failed") {
  const sourceFile = {
    publicId: "source-file-retry",
    knowledgeBaseId: "knowledge-base-retry",
    directoryPublicId: null,
    logicalPath: "guide.md",
    normalizedPath: "guide.md",
    title: "Guide",
    metadata: {},
    status,
    revision: 2,
    safeErrorCode: status === "failed" ? "SOURCE_MODEL_FAILED" : null,
    safeErrorMessage: null,
    modelInvocation: null as StorageVnextModelInvocationFact | null,
    currentRevisionPublicId: "source-revision-retry",
    visibility: "visible" as const,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z"
  };
  const revision = {
    publicId: "source-revision-retry",
    knowledgeBaseId: "knowledge-base-retry",
    sourceFilePublicId: "source-file-retry",
    objectId: "object-retry",
    checksum: "a".repeat(64),
    byteCount: 16,
    contentType: "text/markdown; charset=utf-8",
    role: "current" as const,
    expiresAt: null,
    createdAt: "2026-08-01T00:00:00.000Z"
  };
  const catalog = {
    getKnowledgeBase: vi.fn(async () => ({
      publicId: "knowledge-base-retry",
      name: "Retry",
      description: null,
      revision: 1,
      visibility: "visible" as const,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z"
    })),
    getSourceFile: vi.fn(async () => sourceFile),
    getCurrentSourceRevision: vi.fn(async () => revision),
    updateSourceFileState: vi.fn(async () => sourceFile)
  };
  const workflow = {
    findIdempotent: vi.fn(async (): Promise<StorageVnextWorkflowOutcome | null> => null),
    enqueue: vi.fn(async () => ({ type: "live" as const, work: {} }))
  };
  return {
    sourceFile,
    revision,
    catalog,
    workflow,
    input: {
      catalog,
      workflow,
      deletion: {} as never,
      runtimeSettings: {
        getCurrentRevision: vi.fn(async () => ({ publicId: "settings-retry" }))
      } as never
    } as unknown as Parameters<typeof createPostgresStorageVnextAdminSource>[0]
  };
}
