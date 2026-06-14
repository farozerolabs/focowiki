import { describe, expect, it } from "vitest";
import { resolveSourceMetadata } from "../src/metadata.js";

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
      defaults: {}
    });

    expect(result.metadata).toMatchObject({
      type: "guide",
      title: "Getting started",
      description: "Introductory material",
      tags: ["onboarding"]
    });
    expect(result.body).toBe("# Body");
  });

  it("uses form defaults when frontmatter omits fields", () => {
    const result = resolveSourceMetadata({
      fileName: "overview.md",
      content: "# Overview",
      defaults: {
        type: "page",
        title: "Overview",
        description: "Default description",
        tags: ["docs"]
      }
    });

    expect(result.metadata).toMatchObject({
      type: "page",
      title: "Overview",
      description: "Default description",
      tags: ["docs"]
    });
    expect(result.body).toBe("# Overview");
  });

  it("prefers frontmatter over form defaults", () => {
    const result = resolveSourceMetadata({
      fileName: "conflict.md",
      content: ["---", "type: article", "title: Frontmatter title", "---", "Body"].join(
        "\n"
      ),
      defaults: {
        type: "page",
        title: "Default title"
      }
    });

    expect(result.metadata.type).toBe("article");
    expect(result.metadata.title).toBe("Frontmatter title");
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
      defaults: {}
    });

    expect(result.metadata.owner).toBe("docs-team");
    expect(result.metadata.reviewed).toBe(true);
  });

  it("rejects non-Markdown uploads without conversion", () => {
    expect(() =>
      resolveSourceMetadata({
        fileName: "notes.txt",
        content: "---\ntype: page\ntitle: Notes\n---\nBody",
        defaults: {}
      })
    ).toThrow(/\.md/);
  });

  it("rejects missing type or title", () => {
    expect(() =>
      resolveSourceMetadata({
        fileName: "missing-type.md",
        content: "---\ntitle: Missing type\n---\nBody",
        defaults: {}
      })
    ).toThrow(/type/);

    expect(() =>
      resolveSourceMetadata({
        fileName: "missing-title.md",
        content: "---\ntype: page\n---\nBody",
        defaults: {}
      })
    ).toThrow(/title/);
  });
});
