import { describe, expect, it } from "vitest";
import { buildPublicFileUrl } from "../src/public-url.js";

describe("public URL builder", () => {
  it("builds knowledge base scoped public OpenAPI URLs", () => {
    expect(buildPublicFileUrl("https://kb.example.com/base/", "kb-001", "index.md")).toBe(
      "https://kb.example.com/base/openapi/v2/knowledge-bases/kb-001/files/content?path=index.md"
    );
    expect(
      buildPublicFileUrl("https://kb.example.com/base", "kb-001", "_index/search.json")
    ).toBe(
      "https://kb.example.com/base/openapi/v2/knowledge-bases/kb-001/files/content?path=_index%2Fsearch.json"
    );
    expect(
      buildPublicFileUrl("https://kb.example.com/base", "kb-001", "_index/search/000001.jsonl")
    ).toBe(
      "https://kb.example.com/base/openapi/v2/knowledge-bases/kb-001/files/content?path=_index%2Fsearch%2F000001.jsonl"
    );
  });

  it("does not expose internal storage identifiers", () => {
    const url = buildPublicFileUrl("https://kb.example.com", "kb-001", "pages/intro.md");

    expect(url).toBe(
      "https://kb.example.com/openapi/v2/knowledge-bases/kb-001/files/content?path=pages%2Fintro.md"
    );
    expect(url).not.toContain("S3_PREFIX");
    expect(url).not.toContain("tenant/demo");
    expect(url).not.toContain("release-");
    expect(url).not.toContain("task-");
    expect(url).not.toContain("object_key");
  });

  it("builds URLs for safe Unicode generated file paths", () => {
    const logicalPath = "pages/产品/客户支持/客户支持手册__2024-10-11__active__752a7652a90e.md";

    expect(
      buildPublicFileUrl(
        "https://kb.example.com",
        "kb-001",
        logicalPath
      )
    ).toBe(
      `https://kb.example.com/openapi/v2/knowledge-bases/kb-001/files/content?path=${encodeURIComponent(
        logicalPath
      )}`
    );
  });

  it("builds URLs for nested directory navigation files", () => {
    const logicalPath = "pages/产品/客户支持/index-000001.md";

    expect(buildPublicFileUrl("https://kb.example.com", "kb-001", logicalPath)).toBe(
      `https://kb.example.com/openapi/v2/knowledge-bases/kb-001/files/content?path=${encodeURIComponent(logicalPath)}`
    );
  });

  it("rejects unsafe public URL path segments", () => {
    expect(() => buildPublicFileUrl("https://kb.example.com", "kb-001", "../index.md")).toThrow(
      /path/
    );
    expect(() =>
      buildPublicFileUrl("https://kb.example.com", "kb-001", "%252e%252e/index.md")
    ).toThrow(/path/);
    expect(() =>
      buildPublicFileUrl("https://kb.example.com", "kb-001", "pages\\intro.md")
    ).toThrow(/path/);
    expect(() =>
      buildPublicFileUrl("https://kb.example.com", "kb-001", "pages/intro\u0000.md")
    ).toThrow(/path/);
    expect(() =>
      buildPublicFileUrl("https://kb.example.com", "kb-001", "sources/intro.md")
    ).toThrow(/path/);
    expect(() =>
      buildPublicFileUrl("https://kb.example.com", "../kb", "index.md")
    ).toThrow(/knowledgeBaseId/);
  });
});
