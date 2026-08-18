import { describe, expect, it, vi } from "vitest";
import { createStorageVnextAdminMutationApplication } from
  "../src/storage-vnext/api/admin-mutation-application.js";
import { createStorageVnextAdminSourceApplication } from
  "../src/storage-vnext/api/admin-source-application.js";
import { createStorageVnextAdminUploadApplication } from
  "../src/storage-vnext/api/admin-upload-application.js";

describe("worker wakeup application adapters", () => {
  it("notifies after durable upload finalization and retry acceptance", async () => {
    const notifyDocument = vi.fn().mockResolvedValue(undefined);
    const upload = createStorageVnextAdminUploadApplication({
      backend: {
        finalizeUploadSession: vi.fn().mockResolvedValue({ publicId: "upload-a" })
      } as never,
      onWorkAccepted: notifyDocument
    });
    const source = createStorageVnextAdminSourceApplication({
      backend: {
        retrySourceFile: vi.fn().mockResolvedValue({
          ok: true, value: { file: { id: "source-a" }, retry: {} }
        })
      } as never,
      onDocumentWorkAccepted: notifyDocument
    });

    await upload.finalizeUploadSession({
      knowledgeBaseId: "kb-a", sessionId: "upload-a"
    });
    await source.retrySourceFile({
      knowledgeBaseId: "kb-a", sourceFileId: "source-a"
    });
    expect(notifyDocument).toHaveBeenCalledTimes(2);
  });

  it("uses document and deletion wakeup classes for mutations", async () => {
    const notifyDocument = vi.fn().mockResolvedValue(undefined);
    const notifyDeletion = vi.fn().mockResolvedValue(undefined);
    const mutation = createStorageVnextAdminMutationApplication({
      backend: {
        replaceSourceFileContent: vi.fn().mockResolvedValue({ operation: {} }),
        deleteSourceFile: vi.fn().mockResolvedValue({ operation: {} })
      } as never,
      onDocumentWorkAccepted: notifyDocument,
      onDeletionWorkAccepted: notifyDeletion
    });

    await mutation.replaceSourceFileContent({
      knowledgeBaseId: "kb-a", sourceFileId: "source-a",
      expectedResourceRevision: 1, idempotencyKey: "replace-a",
      bytes: new Uint8Array([1])
    });
    await mutation.deleteSourceFile({
      knowledgeBaseId: "kb-a", sourceFileId: "source-a",
      expectedResourceRevision: 2, idempotencyKey: "delete-a"
    });
    expect(notifyDocument).toHaveBeenCalledOnce();
    expect(notifyDeletion).toHaveBeenCalledOnce();
  });

  it("does not notify after a rejected retry", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const source = createStorageVnextAdminSourceApplication({
      backend: {
        retrySourceFile: vi.fn().mockResolvedValue({
          ok: false, code: "SOURCE_FILE_RETRY_NOT_ALLOWED"
        })
      } as never,
      onDocumentWorkAccepted: notify
    });
    await source.retrySourceFile({
      knowledgeBaseId: "kb-a", sourceFileId: "source-a"
    });
    expect(notify).not.toHaveBeenCalled();
  });
});
