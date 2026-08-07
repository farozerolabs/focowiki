import { describe, expect, it } from "vitest";
import {
  extensionLeafPath,
  renderExtensionLandingMarkdown,
  renderExtensionFamilyMarkdown,
  renderExtensionLeafMarkdown,
  renderExtensionResourceRootMarkdown
} from "../src/storage-vnext/publication/extension-navigation-renderer.js";

describe("storage vNext extension navigation renderer", () => {
  it("preserves bounded catalog access and reciprocal links on extension roots", () => {
    const index = renderExtensionLandingMarkdown({
      rootPath: "_index",
      families: []
    });
    const graph = renderExtensionLandingMarkdown({
      rootPath: "_graph",
      families: []
    });

    expect(index).toContain("[Projection catalog](/_index/catalog.json)");
    expect(index).toContain("[Relationship graph](/_graph/index.md)");
    expect(graph).toContain("[Machine-readable graph catalog](/_index/catalog.json)");
    expect(graph).toContain("[Machine-readable indexes](/_index/index.md)");
    expect(index).not.toContain("[Machine-readable indexes](/_index/index.md)");
    expect(graph).not.toContain("[Relationship graph](/_graph/index.md)");
  });

  it("renders one bounded typed family chain with reciprocal global links", () => {
    const family = renderExtensionFamilyMarkdown({
      directoryPath: "_index/search",
      versionPath: "_index/search/v1"
    });
    const root = renderExtensionResourceRootMarkdown({
      directoryPath: "_index/search/v1",
      entryCount: 2,
      firstLeafId: "extension-leaf-a"
    });
    const leaf = renderExtensionLeafMarkdown({
      directoryPath: "_index/search/v1",
      leaf: {
        id: "extension-leaf-a",
        previousLeafId: null,
        nextLeafId: "extension-leaf-b",
        revision: 1,
        entries: [{
          id: "_index/search/v1/0001.json",
          sortKey: "_index/search/v1/0001.json",
          name: "0001.json",
          targetPath: "_index/search/v1/0001.json",
          kind: "file"
        }]
      }
    });

    expect(family).toContain("[Version 1](/_index/search/v1/index.md)");
    expect(root).toContain("[Browse entries](/_index/search/v1/index-extension-leaf-a.md)");
    expect(leaf).toContain("[0001.json](/_index/search/v1/0001.json)");
    expect(leaf).toContain("[Next](/_index/search/v1/index-extension-leaf-b.md)");
    for (const markdown of [family, root, leaf]) {
      expect(markdown).toContain("[Knowledge base](/index.md)");
      expect(markdown).toContain("[Documents](/pages/index.md)");
      expect(markdown).toContain("[Machine-readable indexes](/_index/index.md)");
      expect(markdown).toContain("[Relationship graph](/_graph/index.md)");
    }
    expect(extensionLeafPath("_index/search/v1", "extension-leaf-a"))
      .toBe("_index/search/v1/index-extension-leaf-a.md");
  });

  it("links every by-file resource to its current source evidence", () => {
    const leaf = renderExtensionLeafMarkdown({
      directoryPath: "_graph/by-file",
      leaf: {
        id: "extension-leaf-a",
        previousLeafId: null,
        nextLeafId: null,
        revision: 1,
        entries: [{
          id: "source-1",
          sortKey: "source-1",
          name: "Setup",
          targetPath: "_graph/by-file/source-1.json",
          evidencePath: "pages/guides/setup.md",
          kind: "file"
        }]
      }
    });

    expect(leaf).toContain("[Setup](/_graph/by-file/source-1.json)");
    expect(leaf).toContain("[Source](/pages/guides/setup.md)");
  });

  it("renders duplicate Unicode labels deterministically with Markdown escaping", () => {
    const input = {
      directoryPath: "_graph/by-file",
      leaf: {
        id: "extension-leaf-unicode",
        previousLeafId: null,
        nextLeafId: null,
        revision: 1,
        entries: ["a", "b"].map((id) => ({
          id,
          sortKey: id,
          name: "重复 [标题] *证据*\n导航",
          targetPath: `_graph/by-file/${id}.json`,
          evidencePath: `pages/${id}.md`,
          kind: "file" as const
        }))
      }
    };

    const first = renderExtensionLeafMarkdown(input);
    const second = renderExtensionLeafMarkdown(input);

    expect(first).toBe(second);
    expect(first.split("重复 \\[标题\\] \\*证据\\* 导航")).toHaveLength(3);
    expect(first).toContain("[Source]");
    expect(first).not.toMatch(/legal|law|case/iu);
  });
});
