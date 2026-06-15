import { describe, expect, it } from "vitest";
import { parseUploadedMarkdownSource, resolveSourceMetadata } from "../src/metadata.js";

describe("resolveSourceMetadata", () => {
  it("uses Markdown frontmatter metadata", () => {
    const result = resolveSourceMetadata({
      fileName: "intro.md",
      content: [
        "---",
        "type: guide",
        "title: Getting started",
        "description: Introductory material",
        "tags:",
        "  - onboarding",
        "---",
        "# Body"
      ].join("\n"),
      metadata: {}
    });

    expect(result.metadata).toMatchObject({
      type: "guide",
      title: "Getting started",
      description: "Introductory material",
      tags: ["onboarding"]
    });
    expect(result.body).toBe("# Body");
  });

  it("parses Markdown frontmatter without requiring domain-specific metadata", () => {
    const result = parseUploadedMarkdownSource({
      fileName: "custom.md",
      content: [
        "---",
        "owner: docs-team",
        "reviewed: true",
        "priority: 3",
        "---",
        "# Body"
      ].join("\n")
    });

    expect(result.metadata).toMatchObject({
      owner: "docs-team",
      reviewed: true,
      priority: 3
    });
    expect(result.body).toBe("# Body");
  });

  it("accepts Markdown without frontmatter and persists empty metadata", () => {
    const result = parseUploadedMarkdownSource({
      fileName: "plain.md",
      content: "# Plain document"
    });

    expect(result.metadata).toEqual({});
    expect(result.body).toBe("# Plain document");
  });

  it("rejects malformed YAML frontmatter with a bounded error", () => {
    expect(() =>
      parseUploadedMarkdownSource({
        fileName: "broken.md",
        content: "---\ntags: [one\n---\n# Broken"
      })
    ).toThrow(/frontmatter is invalid/i);
  });

  it("resolves generic metadata from Markdown and safe defaults", () => {
    const result = resolveSourceMetadata({
      fileName: "overview.md",
      content: "# Overview",
      metadata: {}
    });

    expect(result.metadata).toMatchObject({
      type: "document",
      title: "Overview"
    });
    expect(result.body).toBe("# Overview");
  });

  it("uses the original filename stem when Markdown has no H1 title", () => {
    const result = resolveSourceMetadata({
      fileName: "reference-notes.md",
      content: "Body without heading",
      metadata: {}
    });

    expect(result.metadata).toMatchObject({
      type: "document",
      title: "reference-notes"
    });
  });

  it("preserves unknown metadata keys", () => {
    const result = resolveSourceMetadata({
      fileName: "custom.md",
      content: [
        "---",
        "type: page",
        "title: Custom metadata",
        "owner: docs-team",
        "reviewed: true",
        "---",
        "Body"
      ].join("\n"),
      metadata: {}
    });

    expect(result.metadata.owner).toBe("docs-team");
    expect(result.metadata.reviewed).toBe(true);
  });

  it("rejects non-Markdown uploads without conversion", () => {
    expect(() =>
      resolveSourceMetadata({
        fileName: "notes.txt",
        content: "---\ntype: page\ntitle: Notes\n---\nBody",
        metadata: {}
      })
    ).toThrow(/\.md/);
  });

  it("uses schema-valid model suggestions only for missing generic fields", () => {
    const result = resolveSourceMetadata({
      fileName: "conflict.md",
      content: [
        "---",
        "type: guide",
        "title: User title",
        "resource: https://example.com/source",
        "status: approved",
        "---",
        "# Markdown title"
      ].join("\n"),
      metadata: {},
      suggestions: {
        title: "Model title",
        type: "model-type",
        description: "Suggested description",
        tags: ["model"],
        related_links: [],
        keywords: []
      }
    });

    expect(result.metadata).toMatchObject({
      type: "guide",
      title: "User title",
      resource: "https://example.com/source",
      status: "approved",
      description: "Suggested description",
      tags: ["model"]
    });
  });
});
