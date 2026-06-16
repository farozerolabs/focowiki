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

  it("rejects unsafe public URL path segments", () => {
    expect(() => buildPublicFileUrl("https://kb.example.com", "kb-001", "../index.md")).toThrow(
      /path/
    );
    expect(() =>
      buildPublicFileUrl("https://kb.example.com", "../kb", "index.md")
    ).toThrow(/knowledgeBaseId/);
  });
});
