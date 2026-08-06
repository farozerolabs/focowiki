import { describe, expect, it, vi } from "vitest";
import { createPostgresStorageVnextAdminSource } from
  "../src/storage-vnext/api/postgres-admin-source.js";
import type { StorageVnextWorkflowOutcome } from
  "../src/storage-vnext/workflow/ports.js";

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
});

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
