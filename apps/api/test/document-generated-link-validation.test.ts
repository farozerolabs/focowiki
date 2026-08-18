import { describe, expect, it } from "vitest";
import {
  collectDocumentGeneratedLinkPaths,
  validateDocumentGeneratedLinks,
  validateDocumentProgressiveNavigation
} from
  "../src/document-indexing/application/document-generated-link-validation.js";

describe("document generated link validation", () => {
  it("collects only normalized local Markdown destinations", () => {
    expect(collectDocumentGeneratedLinkPaths([{
      logicalPath: "pages/a.md",
      contentType: "text/markdown; charset=utf-8",
      bytes: Buffer.from("[Local](/Pages/B.md?view=1) [Remote](https://example.com)")
    }])).toEqual(["pages/b.md"]);
  });

  it("accepts links to current and same-activation page heads", () => {
    expect(() => validateDocumentGeneratedLinks({
      pages: [{
        logicalPath: "pages/a.md",
        contentType: "text/markdown; charset=utf-8",
        bytes: Buffer.from("# A\n\n[Current](/pages/b.md) · [New](/_graph/index.md)")
      }, {
        logicalPath: "_graph/index.md",
        contentType: "text/markdown; charset=utf-8",
        bytes: Buffer.from("# Graph\n")
      }],
      activeLogicalPaths: ["pages/b.md"]
    })).not.toThrow();
  });

  it("rejects broken links and internal identities", () => {
    expect(() => validateDocumentGeneratedLinks({
      pages: [{
        logicalPath: "pages/a.md", contentType: "text/markdown",
        bytes: Buffer.from("[Missing](/pages/missing.md)")
      }], activeLogicalPaths: []
    })).toThrow(expect.objectContaining({
      code: "generated_link_unresolved",
      resourcePath: "pages/a.md"
    }));
    expect(() => validateDocumentGeneratedLinks({
      pages: [{
        logicalPath: "pages/a.md", contentType: "text/markdown",
        bytes: Buffer.from("[Internal](/_internal/document-job-a)")
      }], activeLogicalPaths: ["_internal/document-job-a"]
    })).toThrow(/internal_identity_leaked/u);
  });

  it("preserves unresolved source-authored references without weakening generated pages", () => {
    expect(() => validateDocumentGeneratedLinks({
      pages: [{
        logicalPath: "pages/dataset.md",
        bytes: Buffer.from("[Future table](/pages/tables/events.md)"),
        contentType: "text/markdown",
        allowUnresolved: true
      }],
      activeLogicalPaths: []
    })).not.toThrow();
    expect(() => validateDocumentGeneratedLinks({
      pages: [{
        logicalPath: "pages/dataset.md",
        bytes: Buffer.from("[Original relative path](../../tables/events.md)"),
        contentType: "text/markdown",
        allowUnresolved: true
      }],
      activeLogicalPaths: []
    })).not.toThrow();
    expect(collectDocumentGeneratedLinkPaths([{
      logicalPath: "pages/dataset.md",
      bytes: Buffer.from("[Original relative path](../../tables/events.md)"),
      contentType: "text/markdown",
      allowUnresolved: true
    }])).toEqual([]);
    expect(() => validateDocumentGeneratedLinks({
      pages: [{
        logicalPath: "pages/dataset.md",
        bytes: Buffer.from("[Internal](/document-job-secret.md)"),
        contentType: "text/markdown",
        allowUnresolved: true
      }],
      activeLogicalPaths: []
    })).toThrow(/internal_identity_leaked/u);
  });

  it("requires continuation navigation to reach its directory and bundle roots", () => {
    const roots = [
      "index.md", "pages/index.md", "_index/index.md", "_graph/index.md"
    ];
    expect(() => validateDocumentProgressiveNavigation({
      pages: [{
        logicalPath: "_graph/by-file/guides/index-leaf.md",
        bytes: Buffer.from([
          "[Directory index](index.md)",
          "[Knowledge base](../../../index.md)",
          "[Documents](../../../pages/index.md)",
          "[Machine-readable indexes](../../../_index/index.md)",
          "[Relationship graph](../../../_graph/index.md)",
          "[Install](install.json)"
        ].join("\n")),
        contentType: "text/markdown"
      }],
      activeLogicalPaths: [...roots, "_graph/by-file/guides/index.md",
        "_graph/by-file/guides/install.json"]
    })).not.toThrow();
    expect(() => validateDocumentProgressiveNavigation({
      pages: [{
        logicalPath: "_graph/by-file/guides/index-leaf.md",
        bytes: Buffer.from("[Install](install.json)"),
        contentType: "text/markdown"
      }],
      activeLogicalPaths: roots
    })).toThrow(expect.objectContaining({
      code: "progressive_navigation_incomplete",
      resourcePath: "_graph/by-file/guides/index-leaf.md"
    }));
  });
});
