import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminFetch, fetchSourceFile } from "../src/lib/admin-api";
import {
  deleteCurrentSourceFile,
  listSourceDirectories,
  replaceSourceFileContent,
  type ResourceOperation,
  updateKnowledgeBaseMetadata
} from "../src/lib/resource-editing-api";
import { resolveSettledResourceOperations } from "../src/hooks/use-resource-operations";
import { isMarkdownFileName } from "../src/components/source-resource-editor";

vi.mock("../src/lib/admin-api", () => ({
  adminFetch: vi.fn(),
  fetchSourceFile: vi.fn()
}));

describe("resource editing API", () => {
  beforeEach(() => {
    vi.mocked(adminFetch).mockReset();
    vi.mocked(fetchSourceFile).mockReset();
    vi.mocked(adminFetch).mockResolvedValue(new Response(JSON.stringify({
      operation: { operationId: "resource-operation-test" }
    }), {
      status: 202,
      headers: { "content-type": "application/json" }
    }));
  });

  it("preserves a source detail failure before delete", async () => {
    vi.mocked(fetchSourceFile).mockRejectedValueOnce(
      new Error("errors.serviceUnavailable")
    );

    await expect(deleteCurrentSourceFile({
      knowledgeBaseId: "kb-test",
      sourceFileId: "source-file-test"
    })).resolves.toEqual({ messageKey: "errors.serviceUnavailable" });
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("keeps non-ASCII source paths out of replacement request headers", async () => {
    await replaceSourceFileContent({
      knowledgeBaseId: "kb-test",
      sourceFileId: "source-file-test",
      resourceRevision: 2,
      content: "# Updated\n"
    });

    const request = vi.mocked(adminFetch).mock.calls[0]?.[1];
    expect(request?.headers).not.toHaveProperty("x-source-relative-path");
  });

  it("preserves the accepted metadata operation identifier", async () => {
    vi.mocked(adminFetch).mockResolvedValueOnce(new Response(JSON.stringify({
      knowledgeBase: { id: "kb-test", name: "Docs" },
      operationId: "operation-metadata"
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));

    await expect(updateKnowledgeBaseMetadata({
      knowledgeBaseId: "kb-test",
      resourceRevision: 2,
      name: "Docs",
      description: "Updated"
    })).resolves.toMatchObject({ operationId: "operation-metadata" });
    expect(vi.mocked(adminFetch).mock.calls[0]?.[1]?.headers).toMatchObject({
      "idempotency-key": expect.any(String)
    });
  });

  it("loads one bounded directory page and preserves its continuation", async () => {
    vi.mocked(adminFetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{ directoryId: "directory-a" }],
        nextCursor: "cursor-b"
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{ directoryId: "directory-b" }],
        nextCursor: null
      }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(listSourceDirectories({
      knowledgeBaseId: "kb-test",
      parentDirectoryId: null
    })).resolves.toMatchObject({
      items: [{ directoryId: "directory-a" }],
      nextCursor: "cursor-b"
    });
    expect(adminFetch).toHaveBeenCalledTimes(1);

    vi.mocked(adminFetch).mockReset();
    vi.mocked(adminFetch).mockResolvedValueOnce(new Response(JSON.stringify({
      error: { code: "DATABASE_ERROR", messageKey: "errors.loadDirectoriesFailed" }
    }), { status: 503, headers: { "content-type": "application/json" } }));
    await expect(listSourceDirectories({ knowledgeBaseId: "kb-test" }))
      .resolves.toEqual({
        code: "DATABASE_ERROR",
        messageKey: "errors.loadDirectoriesFailed"
      });
  });

  it("reads the terminal operation instead of treating the last active snapshot as settled", async () => {
    const accepted = operation({ state: "accepted" });
    const completed = operation({ state: "completed", completedAt: "2026-08-13T00:00:01.000Z" });
    await expect(resolveSettledResourceOperations({
      knowledgeBaseId: "kb-test",
      previous: [accepted],
      active: [],
      fetchOperation: vi.fn(async () => ({ operation: completed }))
    })).resolves.toEqual({ settled: [completed], unresolved: [] });
  });

  it("keeps an operation active when its terminal detail cannot be read", async () => {
    const accepted = operation({ state: "accepted" });
    await expect(resolveSettledResourceOperations({
      knowledgeBaseId: "kb-test",
      previous: [accepted],
      active: [],
      fetchOperation: vi.fn(async () => ({ messageKey: "errors.loadOperationFailed" }))
    })).resolves.toEqual({ settled: [], unresolved: [accepted] });
  });

  it("accepts Markdown extensions without changing filename case", () => {
    expect(isMarkdownFileName("GUIDE.MD")).toBe(true);
    expect(isMarkdownFileName("guide.txt")).toBe(false);
  });
});

function operation(overrides: Partial<ResourceOperation> = {}): ResourceOperation {
  return {
    operationId: "operation-test",
    knowledgeBaseId: "kb-test",
    kind: "source_file_replace" as const,
    state: "accepted",
    expectedResourceRevision: 1,
    targetKind: "source_file" as const,
    targetId: "source-file-test",
    candidateRelativePath: null,
    result: null,
    errorCode: null,
    retryGuidance: "retry_after_short_delay",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    completedAt: null,
    ...overrides
  };
}
