import { describe, expect, it } from "vitest";
import {
  resolveSourceMarkdownLinkDestination,
  rewriteSourceMarkdownLinks
} from "../src/markdown-links.js";

describe("rewriteSourceMarkdownLinks", () => {
  it("rewrites nested relative, root-relative, and reference Markdown targets", () => {
    const markdown = [
      "See [sibling](./sibling.md), [parent](../overview.md#scope), and [root](/policy.md).",
      "[reference]: ../reference.md?view=full",
      "![image](./image.png)"
    ].join("\n");
    expect(rewriteSourceMarkdownLinks(markdown, "team/guides/current.md")).toBe([
      "See [sibling](/pages/team/guides/sibling.md), [parent](/pages/team/overview.md#scope), and [root](/pages/policy.md).",
      "[reference]: /pages/team/reference.md?view=full",
      "![image](./image.png)"
    ].join("\n"));
  });

  it("keeps external links, code, fences, existing bundle paths, and escaping traversal unchanged", () => {
    const markdown = [
      "[external](https://example.com/a.md) [bundle](/pages/team/a.md) `code [x](./x.md)`",
      "```md",
      "[fenced](./fenced.md)",
      "```",
      "[escape](../../../outside.md)"
    ].join("\n");
    expect(rewriteSourceMarkdownLinks(markdown, "team/current.md")).toBe(markdown);
  });

  it("preserves Unicode display text while encoding the generated bundle target", () => {
    expect(rewriteSourceMarkdownLinks(
      "[相关](../法规/条例.md)",
      "地区/目录/当前.md"
    )).toBe("[相关](/pages/%E5%9C%B0%E5%8C%BA/%E6%B3%95%E8%A7%84/%E6%9D%A1%E4%BE%8B.md)");
  });

  it("resolves a source link destination for graph reference matching", () => {
    expect(
      resolveSourceMarkdownLinkDestination(
        "../reference/target.md#details",
        "guides/setup/current.md"
      )
    ).toBe("/pages/guides/reference/target.md#details");
  });
});
