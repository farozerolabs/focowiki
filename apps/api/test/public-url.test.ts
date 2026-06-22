import { describe, expect, it } from "vitest";
import { buildPublicFileUrl } from "../src/public-url.js";

describe("public URL builder", () => {
  it("builds knowledge base scoped public OpenAPI URLs", () => {
    expect(buildPublicFileUrl("https://kb.example.com/base/", "kb-001", "index.md")).toBe(
      "https://kb.example.com/base/openapi/v1/knowledge-bases/kb-001/files/content?path=index.md"
    );
    expect(
      buildPublicFileUrl("https://kb.example.com/base", "kb-001", "_index/search.json")
    ).toBe(
      "https://kb.example.com/base/openapi/v1/knowledge-bases/kb-001/files/content?path=_index%2Fsearch.json"
    );
    expect(
      buildPublicFileUrl("https://kb.example.com/base", "kb-001", "_index/search/000001.jsonl")
    ).toBe(
      "https://kb.example.com/base/openapi/v1/knowledge-bases/kb-001/files/content?path=_index%2Fsearch%2F000001.jsonl"
    );
  });

  it("does not expose internal storage identifiers", () => {
    const url = buildPublicFileUrl("https://kb.example.com", "kb-001", "pages/intro.md");

    expect(url).toBe(
      "https://kb.example.com/openapi/v1/knowledge-bases/kb-001/files/content?path=pages%2Fintro.md"
    );
    expect(url).not.toContain("S3_PREFIX");
    expect(url).not.toContain("tenant/demo");
    expect(url).not.toContain("release-");
    expect(url).not.toContain("task-");
    expect(url).not.toContain("object_key");
  });

  it("builds URLs for safe Unicode generated file paths", () => {
    expect(
      buildPublicFileUrl(
        "https://kb.example.com",
        "kb-001",
        "pages/遵义市城镇燃气安全管理条例__2024-10-11__有效__752a7652a90e.md"
      )
    ).toBe(
      "https://kb.example.com/openapi/v1/knowledge-bases/kb-001/files/content?path=pages%2F%E9%81%B5%E4%B9%89%E5%B8%82%E5%9F%8E%E9%95%87%E7%87%83%E6%B0%94%E5%AE%89%E5%85%A8%E7%AE%A1%E7%90%86%E6%9D%A1%E4%BE%8B__2024-10-11__%E6%9C%89%E6%95%88__752a7652a90e.md"
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
