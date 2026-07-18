import { describe, expect, it } from "vitest";
import { buildLinkIndex, extractMarkdownLinkEntries } from "../src/indexes.js";

describe("Markdown link indexes", () => {
  it("resolves actual nested Markdown links to canonical bundle paths", () => {
    expect(extractMarkdownLinkEntries({
      path: "pages/guide/intro.md",
      content: [
        "[Sibling](setup.md)",
        "[Parent](../index.md#overview)",
        "[Unicode](%E4%B8%AD%E6%96%87.md)",
        "[Root](/schema.md)",
        "![Image](diagram.md)",
        "[External](https://example.com/doc.md)",
        "[Fragment](#local)",
        "[Escape](../../../outside.md)"
      ].join("\n")
    })).toEqual([
      { from: "pages/guide/intro.md", to: "pages/guide/setup.md", label: "Sibling" },
      { from: "pages/guide/intro.md", to: "pages/index.md", label: "Parent" },
      { from: "pages/guide/intro.md", to: "pages/guide/中文.md", label: "Unicode" },
      { from: "pages/guide/intro.md", to: "schema.md", label: "Root" }
    ]);
  });

  it("indexes only links whose canonical targets exist in the bundle", () => {
    const linkIndex = buildLinkIndex([
      {
        path: "pages/guide/index.md",
        content: "[Guide](guide.md)\n[Missing](missing.md)"
      },
      {
        path: "pages/guide/guide.md",
        content: "# Guide"
      }
    ], "2026-07-10T00:00:00.000Z");

    expect(linkIndex.links).toEqual([
      {
        from: "pages/guide/index.md",
        to: "pages/guide/guide.md",
        label: "Guide"
      }
    ]);
  });

  it("extracts generated links whose labels contain escaped Markdown characters", () => {
    expect(extractMarkdownLinkEntries({
      path: "pages/corpus/index-000008.md",
      content: "- [规则 \\[附录\\] (测试) \\*版本\\* \\\\ 路径](/pages/corpus/canonical-markdown-reserved.md) - Validation sample."
    })).toEqual([
      {
        from: "pages/corpus/index-000008.md",
        to: "pages/corpus/canonical-markdown-reserved.md",
        label: "规则 [附录] (测试) *版本* \\ 路径"
      }
    ]);
  });
});
