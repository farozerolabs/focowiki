import { describe, expect, it } from "vitest";
import { renderMarkdownPreview } from "../src/lib/markdown-preview";

describe("Markdown preview security", () => {
  it("renders script-like Markdown as inert preview HTML", () => {
    const html = renderMarkdownPreview(
      [
        "---",
        "title: Unsafe",
        "---",
        "# Unsafe",
        "<script>window.evil = true</script>",
        "<img src=x onerror=alert(1)>",
        "[bad](javascript:alert(1))",
        "[data](data:text/html,evil)",
        "[safe](https://example.com/docs)"
      ].join("\n")
    );

    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="data:');
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("title: Unsafe");
  });

  it("renders generated root navigation as internal preview controls", () => {
    const html = renderMarkdownPreview(
      [
        "# Knowledge base",
        "",
        "- [Relationship graph](_graph/index.md)",
        "- [Update history](log.md)"
      ].join("\n"),
      "index.md"
    );

    expect(html).toContain('data-preview-path="_graph/index.md"');
    expect(html).toContain('data-preview-path="log.md"');
    expect(html).not.toContain('href=""');
  });

  it("resolves nested generated links without allowing paths outside the bundle", () => {
    const html = renderMarkdownPreview(
      [
        "# File graph",
        "",
        "- [Manifest](manifest.json)",
        "- [Knowledge base](../index.md)",
        "- [Outside](../../outside.md)"
      ].join("\n"),
      "_graph/index.md"
    );

    expect(html).toContain('data-preview-path="_graph/manifest.json"');
    expect(html).toContain('data-preview-path="index.md"');
    expect(html).not.toContain('data-preview-path="outside.md"');
  });

  it.each([
    ["schema.md", "schema-frontmatter.md", "schema-frontmatter.md"],
    ["log.md", "log-000001.md", "log-000001.md"],
    ["log-000002.md", "log-000001.md", "log-000001.md"],
    ["_index/index.md", "manifest.json", "_index/manifest.json"],
    ["_graph/index.md", "nodes.jsonl", "_graph/nodes.jsonl"],
    ["_graph/index.md", "edges/0000.jsonl", "_graph/edges/0000.jsonl"],
    ["pages/team/index.md", "guide.md", "pages/team/guide.md"],
    ["pages/team/index-000002.md", "index-000001.md", "pages/team/index-000001.md"],
    ["pages/team/guide.md", "/pages/reference.md", "pages/reference.md"]
  ])("resolves generated link %s -> %s", (currentPath, href, expectedPath) => {
    const html = renderMarkdownPreview(`[Open](${href})`, currentPath);

    expect(html).toContain(`data-preview-path="${expectedPath}"`);
  });

  it("renders unsupported local and unsafe links without navigating to the current page", () => {
    const html = renderMarkdownPreview(
      ["[missing](missing.txt)", "[unsafe](javascript:alert(1))"].join("\n"),
      "index.md"
    );

    expect(html).not.toContain("<a");
    expect(html).not.toContain("<button");
    expect(html).not.toContain('href=""');
    expect(html).toContain("<span");
  });

  it.each([
    "%25252525252e%25252525252e/outside.md",
    "%25252525252f%25252525252fexample.com/outside.md",
    "%252525256a%2525252561%2525252576%2525252561%2525252573%2525252563%2525252572%2525252569%2525252570%2525252574%252525253aalert(1)"
  ])("rejects paths that remain encoded after bounded decoding: %s", (href) => {
    const html = renderMarkdownPreview(`[unsafe](${href})`, "pages/team/guide.md");

    expect(html).not.toContain("<a");
    expect(html).not.toContain("<button");
    expect(html).toContain("<span");
  });
});
