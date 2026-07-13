import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addUploadManifestEntries,
  createUploadSession,
  finalizeUploadSession,
  getUploadSession,
  reconcileUploadSession,
  sealUploadManifest,
  uploadSessionContent
} from "../src/lib/admin-api";
import { runUploadSession } from "../src/lib/upload-session-client";

vi.mock("../src/lib/admin-api", () => ({
  addUploadManifestEntries: vi.fn(),
  cancelUploadSession: vi.fn(),
  createUploadSession: vi.fn(),
  finalizeUploadSession: vi.fn(),
  getUploadSession: vi.fn(),
  reconcileUploadSession: vi.fn(),
  sealUploadManifest: vi.fn(),
  uploadSessionContent: vi.fn()
}));

describe("folder upload session client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createUploadSession).mockResolvedValue({
      session: uploadSession("draft", { selected: 0 }),
      limits: uploadLimits
    });
    vi.mocked(addUploadManifestEntries).mockResolvedValue({
      session: uploadSession("manifest_building", { selected: 2 })
    });
    vi.mocked(finalizeUploadSession).mockResolvedValue({
      session: uploadSession("completed", { selected: 2, finalized: 2 })
    });
  });

  it("finalizes an all-existing folder without transferring file bodies", async () => {
    vi.mocked(sealUploadManifest).mockResolvedValue({
      session: uploadSession("manifest_sealed", {
        selected: 2,
        skippedExisting: 2,
        finalized: 2
      }),
      sample: [],
      nextCursor: null
    });
    vi.mocked(getUploadSession).mockResolvedValue({
      session: uploadSession("manifest_sealed", {
        selected: 2,
        skippedExisting: 2,
        finalized: 2
      }),
      entries: { items: [], nextCursor: null }
    });

    const result = await runUploadSession({
      knowledgeBaseId: "kb-docs",
      files: [nestedFile("Existing A", "handbook/a.md"), nestedFile("Existing B", "handbook/b.md")],
      onProgress: vi.fn()
    });

    expect(result.ok).toBe(true);
    expect(uploadSessionContent).not.toHaveBeenCalled();
    expect(finalizeUploadSession).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-docs",
      sessionId: "upload-session-test"
    });
  });

  it("transfers only upload-required entries from a mixed existing and new folder", async () => {
    vi.mocked(sealUploadManifest).mockResolvedValue({
      session: uploadSession("manifest_sealed", {
        selected: 2,
        uploadRequired: 1,
        skippedExisting: 1
      }),
      sample: [],
      nextCursor: null
    });
    vi.mocked(getUploadSession).mockResolvedValue({
      session: uploadSession("uploading", {
        selected: 2,
        uploadRequired: 1,
        skippedExisting: 1
      }),
      entries: {
        items: [uploadEntry("upload-entry-new", "handbook/new.md")],
        nextCursor: null
      }
    });
    vi.mocked(uploadSessionContent).mockResolvedValue({
      entries: [uploadEntry("upload-entry-new", "handbook/new.md", "uploaded")]
    });

    const existing = nestedFile("Existing", "handbook/existing.md");
    const added = nestedFile("New", "handbook/new.md");
    const result = await runUploadSession({
      knowledgeBaseId: "kb-docs",
      files: [existing, added],
      onProgress: vi.fn()
    });

    expect(result.ok).toBe(true);
    expect(uploadSessionContent).toHaveBeenCalledTimes(1);
    expect(uploadSessionContent).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-docs",
      sessionId: "upload-session-test",
      entries: [{ entryId: "upload-entry-new", file: added }]
    });
  });

  it("reconciles a concurrent reservation before deciding that no body is required", async () => {
    vi.mocked(sealUploadManifest).mockResolvedValue({
      session: uploadSession("manifest_sealed", {
        selected: 1,
        waitingReservation: 1
      }),
      sample: [],
      nextCursor: null
    });
    vi.mocked(reconcileUploadSession).mockResolvedValue({
      session: uploadSession("manifest_sealed", {
        selected: 1,
        skippedExisting: 1,
        finalized: 1
      })
    });
    vi.mocked(getUploadSession).mockResolvedValue({
      session: uploadSession("manifest_sealed", {
        selected: 1,
        skippedExisting: 1,
        finalized: 1
      }),
      entries: { items: [], nextCursor: null }
    });

    const result = await runUploadSession({
      knowledgeBaseId: "kb-docs",
      files: [nestedFile("Shared", "handbook/shared.md")],
      onProgress: vi.fn()
    });

    expect(result.ok).toBe(true);
    expect(reconcileUploadSession).toHaveBeenCalledTimes(1);
    expect(uploadSessionContent).not.toHaveBeenCalled();
  });
});

const uploadLimits = {
  manifestPageSize: 500,
  contentBatchMaxFiles: 24,
  contentBatchMaxBytes: 16_777_216,
  maxFileBytes: 1_048_576
};

function uploadSession(
  state: "draft" | "manifest_building" | "manifest_sealed" | "uploading" | "completed",
  counts: Partial<{
    selected: number;
    uploadRequired: number;
    skippedExisting: number;
    waitingReservation: number;
    rejectedDeleting: number;
    uploaded: number;
    failed: number;
    finalized: number;
  }>
) {
  const now = "2026-07-10T00:00:00.000Z";
  return {
    id: "upload-session-test",
    knowledgeBaseId: "kb-docs",
    state,
    declaredFileCount: counts.selected ?? 2,
    declaredByteCount: 32,
    counts: {
      selected: 0,
      uploadRequired: 0,
      skippedExisting: 0,
      waitingReservation: 0,
      rejectedDeleting: 0,
      uploaded: 0,
      failed: 0,
      finalized: 0,
      ...counts
    },
    expiresAt: now
  };
}

function uploadEntry(id: string, relativePath: string, transferState: "missing" | "uploaded" = "missing") {
  return {
    id,
    relativePath,
    directoryPath: relativePath.split("/").slice(0, -1).join("/"),
    name: relativePath.split("/").at(-1) ?? relativePath,
    declaredSize: 3,
    receivedSize: transferState === "uploaded" ? 3 : 0,
    checksumSha256: "0".repeat(64),
    disposition: "upload_required" as const,
    transferState,
    sourceDirectoryId: "source-directory-handbook",
    sourceFileId: "source-file-new",
    existingResourceRevision: null,
    generatedPath: `pages/${relativePath}`,
    errorCode: null
  };
}

function nestedFile(content: string, relativePath: string): File {
  const file = new File([content], relativePath.split("/").at(-1) ?? relativePath, {
    type: "text/markdown"
  });
  Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
  return file;
}
