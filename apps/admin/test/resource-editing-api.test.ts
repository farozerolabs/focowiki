import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminFetch } from "../src/lib/admin-api";
import { replaceSourceFileContent } from "../src/lib/resource-editing-api";

vi.mock("../src/lib/admin-api", () => ({
  adminFetch: vi.fn()
}));

describe("resource editing API", () => {
  beforeEach(() => {
    vi.mocked(adminFetch).mockReset();
    vi.mocked(adminFetch).mockResolvedValue(new Response(JSON.stringify({
      operation: { operationId: "resource-operation-test" }
    }), {
      status: 202,
      headers: { "content-type": "application/json" }
    }));
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
});
