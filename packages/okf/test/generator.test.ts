import { readFileSync } from "node:fs";

import matter from "gray-matter";
import { describe, expect, it } from "vitest";
import { generateOkfBundle, type GeneratedOkfBundle } from "../src/generator.js";

function filesByPath(files: { path: string; content: string }[]): Record<string, string> {
  return Object.fromEntries(files.map((file) => [file.path, file.content]));
}

describe("generateOkfBundle", () => {
  it("generates reserved and concept Markdown files", () => {
    const bundle = generateOkfBundle({
      generatedAt: "2026-06-14T00:00:00.000Z",
      defaults: {
        type: "page"
      },
      sources: [
        {
          fileName: "intro.md",
          content: [
            "---",
            "title: Getting started",
            "description: Project introduction",
            "resource: https://example.com/source",
            "tags:",
            "  - onboarding",
            "---",
            "# Getting started",
            "",
            "Welcome to the knowledge base."
          ].join("\n")
        }
      ]
    });

    const files = filesByPath(bundle.files);

    expect(Object.keys(files).sort()).toEqual([
      "_index/links.json",
      "_index/manifest.json",
      "_index/search.json",
      "index.md",
      "pages/intro.md",
      "schema.md"
    ]);
    expect(files["index.md"]?.startsWith("---")).toBe(false);
    expect(files["index.md"]).toContain("[Getting started](/pages/intro.md)");
    expect(files["index.md"]).not.toContain("/sources/");

    const schema = matter(files["schema.md"] ?? "");
    expect(schema.data).toMatchObject({
      type: "schema",
      title: "Focowiki bundle schema"
    });
    expect(schema.content).toContain("type");
    expect(schema.content).toContain("title");

    const page = matter(files["pages/intro.md"] ?? "");
    expect(page.data).toMatchObject({
      type: "page",
      title: "Getting started",
      description: "Project introduction",
      tags: ["onboarding"]
    });
    expect(page.content).toContain("# Getting started");
    expect(page.content).toContain("Welcome to the knowledge base.");
    expect(page.content).not.toContain("/sources/");
    expect(page.content).toContain("# Citations");
    expect(page.content).toContain("- https://example.com/source");
  });

  it("generates manifest, search, and link indexes", () => {
    const bundle = generateOkfBundle({
      generatedAt: "2026-06-14T00:00:00.000Z",
      defaults: {
        type: "page"
      },
      sources: [
        {
          fileName: "intro.md",
          content: [
            "---",
            "title: Getting started",
            "description: Project introduction",
            "tags:",
            "  - onboarding",
            "---",
            "# Getting started",
            "",
            "Welcome to the knowledge base."
          ].join("\n")
        }
      ]
    });

    const files = filesByPath(bundle.files);
    const manifest = JSON.parse(files["_index/manifest.json"] ?? "{}") as {
      generated_at: string;
      files: Array<{ path: string; content_type: string; title?: string }>;
    };
    const search = JSON.parse(files["_index/search.json"] ?? "{}") as {
      items: Array<{
        path: string;
        title: string;
        description?: string;
        tags: string[];
        keywords: string[];
      }>;
    };
    const links = JSON.parse(files["_index/links.json"] ?? "{}") as {
      links: Array<{ from: string; to: string; label: string }>;
    };

    expect(manifest.generated_at).toBe("2026-06-14T00:00:00.000Z");
    expect(manifest.files.map((file) => file.path).sort()).toEqual([
      "_index/links.json",
      "_index/manifest.json",
      "_index/search.json",
      "index.md",
      "pages/intro.md",
      "schema.md"
    ]);
    expect(manifest.files).toContainEqual({
      path: "pages/intro.md",
      content_type: "text/markdown; charset=utf-8",
      title: "Getting started"
    });

    expect(search.items).toContainEqual({
      path: "pages/intro.md",
      title: "Getting started",
      description: "Project introduction",
      tags: ["onboarding"],
      keywords: ["getting", "started", "project", "introduction", "onboarding"]
    });

    expect(links.links).toContainEqual({
      from: "index.md",
      to: "pages/intro.md",
      label: "Getting started"
    });
    expect(links.links).not.toContainEqual(
      expect.objectContaining({
        to: "sources/intro.md"
      })
    );
  });

  it("generates OKF metadata from Markdown and generic fallbacks without form defaults", () => {
    const bundle = generateOkfBundle({
      generatedAt: "2026-06-14T00:00:00.000Z",
      defaults: {},
      sources: [
        {
          fileName: "plain-source.md",
          content: "# Plain source\n\nBody without frontmatter."
        }
      ]
    });
    const files = filesByPath(bundle.files);
    const page = matter(files["pages/plain-source.md"] ?? "");

    expect(page.data).toMatchObject({
      type: "document",
      title: "Plain source"
    });
    expect(page.content).toContain("Body without frontmatter.");
  });

  it("uses model type suggestions only when source type is missing", () => {
    const bundle = generateOkfBundle({
      generatedAt: "2026-06-14T00:00:00.000Z",
      defaults: {},
      sources: [
        {
          fileName: "typed-by-model.md",
          content: "# Deterministic title",
          suggestions: {
            title: "Model title",
            type: "guide",
            description: "",
            tags: [],
            related_links: [],
            keywords: []
          }
        }
      ]
    });
    const files = filesByPath(bundle.files);
    const page = matter(files["pages/typed-by-model.md"] ?? "");

    expect(page.data).toMatchObject({
      type: "guide",
      title: "Deterministic title"
    });
  });

  it("keeps original Markdown file names in generated page paths", () => {
    const bundle = generateOkfBundle({
      generatedAt: "2026-06-14T00:00:00.000Z",
      defaults: {
        type: "page"
      },
      sources: [
        {
          fileName: "外国企业常驻代表机构登记管理条例.md",
          content: "---\ntitle: 外国企业常驻代表机构登记管理条例\n---\n# First"
        },
        {
          fileName: "intro!.md",
          content: "---\ntitle: Second intro\n---\n# Second"
        }
      ]
    });

    expect(
      bundle.files
        .map((file) => file.path)
        .filter((path) => path.startsWith("pages/"))
        .sort()
    ).toEqual([
      "pages/intro!.md",
      "pages/外国企业常驻代表机构登记管理条例.md"
    ]);
  });

  it("uses model suggestions only for presentation fields", () => {
    const bundle = generateOkfBundle({
      generatedAt: "2026-06-14T00:00:00.000Z",
      defaults: {},
      sources: [
        {
          fileName: "intro.md",
          content: [
            "---",
            "type: page",
            "title: Intro",
            "resource: https://example.com/source",
            'timestamp: "2026-06-14T00:00:00.000Z"',
            "---",
            "# Intro"
          ].join("\n"),
          suggestions: {
            title: "",
            type: "",
            description: "Suggested description",
            related_links: [{ path: "/pages/related.md", title: "Related" }],
            tags: [],
            keywords: ["suggested", "agent"]
          }
        },
        {
          fileName: "related.md",
          content: "---\ntype: page\ntitle: Related\n---\n# Related"
        }
      ]
    });
    const files = filesByPath(bundle.files);
    const page = matter(files["pages/intro.md"] ?? "");
    const search = JSON.parse(files["_index/search.json"] ?? "{}") as {
      items: Array<{ path: string; description?: string; keywords: string[] }>;
    };

    expect(page.data).toMatchObject({
      type: "page",
      title: "Intro",
      resource: "https://example.com/source",
      timestamp: "2026-06-14T00:00:00.000Z",
      description: "Suggested description"
    });
    expect(page.content).toContain("## Related");
    expect(page.content).toContain("- [Related](/pages/related.md)");
    const links = JSON.parse(files["_index/links.json"] ?? "{}") as {
      links: Array<{ from: string; to: string; label: string }>;
    };
    expect(links.links).toContainEqual({
      from: "pages/intro.md",
      to: "pages/related.md",
      label: "Related"
    });
    expect(search.items.find((item) => item.path === "pages/intro.md")).toMatchObject({
      description: "Suggested description",
      keywords: ["intro", "suggested", "description", "agent"]
    });
  });

  it("does not duplicate existing citations sections", () => {
    const bundle = generateOkfBundle({
      generatedAt: "2026-06-14T00:00:00.000Z",
      defaults: {},
      sources: [
        {
          fileName: "cited.md",
          content: [
            "---",
            "type: page",
            "title: Cited",
            "resource: https://example.com/source",
            "---",
            "# Cited",
            "",
            "# Citations",
            "",
            "- Existing citation"
          ].join("\n")
        }
      ]
    });
    const page = matter(filesByPath(bundle.files)["pages/cited.md"] ?? "");

    expect(page.content.match(/^# Citations$/gm)).toHaveLength(1);
    expect(page.content).toContain("- Existing citation");
    expect(page.content).not.toContain("- https://example.com/source");
  });

  it("filters relationship graph suggestions to generated public bundle paths", () => {
    const bundle = generateOkfBundle({
      generatedAt: "2026-06-14T00:00:00.000Z",
      defaults: {},
      sources: [
        {
          fileName: "intro.md",
          content: "---\ntype: page\ntitle: Intro\n---\n# Intro",
          suggestions: {
            title: "",
            type: "",
            description: "",
            tags: [],
            keywords: [],
            related_links: [
              { path: "/pages/related.md", title: "Related" },
              { path: "/pages/missing.md", title: "Missing" },
              { path: "/sources/raw.md", title: "Raw source" },
              { path: "tenant/demo/object-key", title: "Object key" }
            ]
          }
        },
        {
          fileName: "related.md",
          content: "---\ntype: page\ntitle: Related\n---\n# Related"
        }
      ]
    });
    const files = filesByPath(bundle.files);
    const page = matter(files["pages/intro.md"] ?? "");
    const links = JSON.parse(files["_index/links.json"] ?? "{}") as {
      links: Array<{ from: string; to: string; label: string }>;
    };

    expect(page.content).toContain("- [Related](/pages/related.md)");
    expect(page.content).not.toContain("Missing");
    expect(page.content).not.toContain("Raw source");
    expect(page.content).not.toContain("Object key");
    expect(links.links).toContainEqual({
      from: "pages/intro.md",
      to: "pages/related.md",
      label: "Related"
    });
    expect(links.links).not.toContainEqual(expect.objectContaining({ to: "pages/missing.md" }));
    expect(links.links).not.toContainEqual(expect.objectContaining({ to: "sources/raw.md" }));
  });

  it("matches the repeatable cleaned Markdown fixture bundle", () => {
    const bundle = generateOkfBundle({
      generatedAt: "2026-06-14T01:00:00.000Z",
      defaults: {
        type: "page",
        title: "Default metadata",
        description: "Uploaded defaults description",
        tags: ["defaults", "metadata"]
      },
      sources: [
        {
          fileName: "frontend-routing.md",
          content: readFixture("cleaned/frontend-routing.md")
        },
        {
          fileName: "default-metadata.md",
          content: readFixture("cleaned/default-metadata.md")
        }
      ]
    });
    const expected = readJsonFixture<GeneratedOkfBundle>("expected/default-bundle.json");

    expect(bundle).toEqual(expected);
  });
});

function readFixture(path: string): string {
  return readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8");
}

function readJsonFixture<T>(path: string): T {
  return JSON.parse(readFixture(path)) as T;
}
