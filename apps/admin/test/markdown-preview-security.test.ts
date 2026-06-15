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
    expect(html).toContain("https://example.com/docs");
    expect(html).toContain("title: Unsafe");
  });
});
