import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { FilePreviewPanel } from "../src/components/file-preview-panel";
import { initI18n } from "../src/i18n";
import { renderMarkdownPreview } from "../src/lib/markdown-preview";

beforeAll(async () => {
  await initI18n("en");
});

describe("generated Markdown preview links", () => {
  it("keeps long generated content inside a scrollable preview region", () => {
    const { container } = render(
      <FilePreviewPanel
        copiedUrl=""
        previewHtml={"<pre>" + "content\n".repeat(500) + "</pre>"}
        publicUrls={null}
        selectedFileTitle="0019.json"
        selectedFilePath="_index/search/v1/0019.json"
        onCopy={vi.fn()}
        onOpenPreviewPath={vi.fn()}
      />
    );

    const scrollRegion = container.querySelector('[data-slot="file-preview-scroll"]');
    const previewCard = container.querySelector('[data-slot="card"]');

    expect(previewCard?.className).toContain("flex-1");
    expect(scrollRegion?.className).toContain("overflow-y-auto");
    expect(scrollRegion?.className).toContain("min-h-0");
  });

  it.each([
    ["Relationship graph", "_graph/index.md"],
    ["Update history", "log.md"]
  ])("opens %s through the bundle preview callback", (label, expectedPath) => {
    const onOpenPreviewPath = vi.fn();
    const previewHtml = renderMarkdownPreview(
      [
        "# Knowledge base",
        "",
        "- [Relationship graph](_graph/index.md)",
        "- [Update history](log.md)"
      ].join("\n"),
      "index.md"
    );

    render(
      <FilePreviewPanel
        copiedUrl=""
        previewHtml={previewHtml}
        publicUrls={null}
        selectedFileTitle="Knowledge base"
        selectedFilePath="index.md"
        onCopy={vi.fn()}
        onOpenPreviewPath={onOpenPreviewPath}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: label }));

    expect(onOpenPreviewPath).toHaveBeenCalledWith(expectedPath, label);
  });
});
