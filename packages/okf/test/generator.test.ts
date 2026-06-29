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
      "log.md",
      "pages/intro.md",
      "schema.md"
    ]);
    expect(files["index.md"]?.startsWith("---")).toBe(false);
    expect(files["index.md"]).toContain("# Knowledge base");
    expect(files["index.md"]).toContain("## Pages");
    expect(files["index.md"]).toContain("[Getting started](/pages/intro.md)");
    expect(files["index.md"]).toContain("- [Getting started](/pages/intro.md) - Project introduction");
    expect(files["index.md"]).not.toContain("/sources/");
    expect(files["index.md"]).not.toContain("Focowiki knowledge base");
    expect(files["log.md"]?.startsWith("---")).toBe(false);
    expect(files["log.md"]).toContain("# Directory Update Log");
    expect(files["log.md"]).toContain("## 2026-06-14");
    expect(files["log.md"]).toContain("Published 1 Markdown pages");
    expect(files["log.md"]).toContain("[Getting started](/pages/intro.md)");
    expect(files["log.md"]).not.toContain("release-");
    expect(files["log.md"]).not.toContain("task-");
    expect(files["log.md"]).not.toContain("S3_PREFIX");

    const schema = matter(files["schema.md"] ?? "");
    expect(schema.data).toMatchObject({
      type: "schema",
      title: "Knowledge base schema"
    });
    expect(schema.content).toContain("# Knowledge base schema");
    expect(schema.content).not.toContain("Focowiki bundle schema");
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

  it("uses the supplied knowledge base title in reserved files", () => {
    const bundle = generateOkfBundle({
      title: "Developer docs",
      generatedAt: "2026-06-14T00:00:00.000Z",
      defaults: {
        type: "page"
      },
      sources: [
        {
          fileName: "intro.md",
          content: "# Intro"
        }
      ]
    });

    const files = filesByPath(bundle.files);
    const schema = matter(files["schema.md"] ?? "");

    expect(files["index.md"]).toContain("# Developer docs");
    expect(files["index.md"]).not.toContain("Focowiki knowledge base");
    expect(schema.data).toMatchObject({
      type: "schema",
      title: "Developer docs schema",
      description: "Schema reference for Developer docs"
    });
    expect(schema.content).toContain("# Developer docs schema");
    expect(schema.content).not.toContain("Focowiki bundle schema");
  });

  it("keeps duplicate original filenames by assigning unique public paths", () => {
    const bundle = generateOkfBundle({
      generatedAt: "2026-06-14T00:00:00.000Z",
      defaults: {
        type: "page"
      },
      sources: [
        {
          id: "source-file-alpha-001",
          fileName: "guide.md",
          content: "# First guide"
        },
        {
          id: "source-file-beta-002",
          fileName: "guide.md",
          content: "# Second guide"
        }
      ]
    });

    const files = filesByPath(bundle.files);
    expect(files["pages/guide.md"]).toContain("# First guide");
    expect(files["pages/guide--source-file-beta-002.md"]).toContain("# Second guide");
    expect(files["index.md"]).toContain("[First guide](/pages/guide.md)");
    expect(files["index.md"]).toContain("[Second guide](/pages/guide--source-file-beta-002.md)");
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
            "resource: https://example.com/source",
            "timestamp: \"2026-06-14T00:00:00.000Z\"",
            "tags:",
            "  - onboarding",
            "externalId: doc-001",
            "status: active",
            "review:",
            "  cycleDays: 30",
            "objectKey: tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/pages/intro.md",
            "releaseId: release-001",
            "taskId: task-001",
            "localPath: /private/tmp/source.md",
            "providerPayload:",
            "  id: provider-output",
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
      files: Array<{
        path: string;
        content_type: string;
        title?: string;
        metadata?: Record<string, unknown>;
      }>;
    };
    const search = JSON.parse(files["_index/search.json"] ?? "{}") as {
      items: Array<{
        path: string;
        type?: string;
        title: string;
        description?: string;
        resource?: string;
        timestamp?: string;
        tags: string[];
        keywords: string[];
        metadata?: Record<string, unknown>;
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
      "log.md",
      "pages/intro.md",
      "schema.md"
    ]);
    expect(manifest.files).toContainEqual({
      path: "log.md",
      content_type: "text/markdown; charset=utf-8"
    });
    expect(manifest.files).toContainEqual({
      path: "pages/intro.md",
      content_type: "text/markdown; charset=utf-8",
      title: "Getting started",
      metadata: expect.objectContaining({
        type: "page",
        title: "Getting started",
        description: "Project introduction",
        resource: "https://example.com/source",
        timestamp: "2026-06-14T00:00:00.000Z",
        tags: ["onboarding"],
        externalId: "doc-001",
        status: "active",
        review: {
          cycleDays: 30
        }
      })
    });
    const manifestPage = manifest.files.find((file) => file.path === "pages/intro.md");
    expect(manifestPage?.metadata).not.toHaveProperty("objectKey");
    expect(manifestPage?.metadata).not.toHaveProperty("releaseId");
    expect(manifestPage?.metadata).not.toHaveProperty("taskId");
    expect(manifestPage?.metadata).not.toHaveProperty("localPath");
    expect(manifestPage?.metadata).not.toHaveProperty("providerPayload");

    expect(search.items).toContainEqual({
      path: "pages/intro.md",
      type: "page",
      title: "Getting started",
      description: "Project introduction",
      resource: "https://example.com/source",
      timestamp: "2026-06-14T00:00:00.000Z",
      tags: ["onboarding"],
      keywords: ["getting", "started", "project", "introduction", "onboarding"],
      metadata: expect.objectContaining({
        type: "page",
        title: "Getting started",
        description: "Project introduction",
        resource: "https://example.com/source",
        timestamp: "2026-06-14T00:00:00.000Z",
        tags: ["onboarding"],
        externalId: "doc-001",
        status: "active",
        review: {
          cycleDays: 30
        }
      })
    });
    const searchPage = search.items.find((item) => item.path === "pages/intro.md");
    expect(search.items.map((item) => item.path)).not.toContain("index.md");
    expect(search.items.map((item) => item.path)).not.toContain("log.md");
    expect(searchPage?.metadata).not.toHaveProperty("objectKey");
    expect(searchPage?.metadata).not.toHaveProperty("releaseId");
    expect(searchPage?.metadata).not.toHaveProperty("taskId");
    expect(searchPage?.metadata).not.toHaveProperty("localPath");
    expect(searchPage?.metadata).not.toHaveProperty("providerPayload");

    expect(links.links).toContainEqual({
      from: "index.md",
      to: "pages/intro.md",
      label: "Getting started"
    });
    expect(links.links).toContainEqual({
      from: "log.md",
      to: "pages/intro.md",
      label: "Getting started"
    });
    expect(links.links).not.toContainEqual(
      expect.objectContaining({
        to: "sources/intro.md"
      })
    );
  });

  it("omits empty optional and placeholder metadata from JSON indexes", () => {
    const bundle = generateOkfBundle({
      generatedAt: "2026-06-14T00:00:00.000Z",
      defaults: {
        type: "page"
      },
      sources: [
        {
          fileName: "placeholder.md",
          content: [
            "---",
            "title: Placeholder metadata",
            "description: \"\"",
            "resource: \"\"",
            "timestamp: unknown",
            "tags: []",
            "reviewedBy: TBD",
            "domainStatus: n/a",
            "emptyNested:",
            "  value: \"\"",
            "---",
            "# Placeholder metadata",
            "",
            "Body."
          ].join("\n")
        }
      ]
    });
    const files = filesByPath(bundle.files);
    const manifest = JSON.parse(files["_index/manifest.json"] ?? "{}") as {
      files: Array<{ path: string; metadata?: Record<string, unknown> }>;
    };
    const search = JSON.parse(files["_index/search.json"] ?? "{}") as {
      items: Array<{
        path: string;
        description?: string;
        resource?: string;
        timestamp?: string;
        tags: string[];
        metadata?: Record<string, unknown>;
      }>;
    };

    const manifestPage = manifest.files.find((file) => file.path === "pages/placeholder.md");
    const searchPage = search.items.find((item) => item.path === "pages/placeholder.md");

    expect(manifestPage?.metadata).toEqual({
      type: "page",
      title: "Placeholder metadata"
    });
    expect(searchPage).toMatchObject({
      path: "pages/placeholder.md",
      title: "Placeholder metadata",
      tags: []
    });
    expect(searchPage).not.toHaveProperty("description");
    expect(searchPage).not.toHaveProperty("resource");
    expect(searchPage).not.toHaveProperty("timestamp");
    expect(searchPage?.metadata).toEqual({
      type: "page",
      title: "Placeholder metadata"
    });
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
          fileName: "客户支持手册.md",
          content: "---\ntitle: 客户支持手册\n---\n# First"
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
      "pages/客户支持手册.md"
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
    expect(page.content).not.toContain("## Related");
    expect(page.content).not.toContain("- [Related](/pages/related.md)");
    const links = JSON.parse(files["_index/links.json"] ?? "{}") as {
      links: Array<{ from: string; to: string; label: string }>;
    };
    expect(links.links).not.toContainEqual({
      from: "pages/intro.md",
      to: "pages/related.md",
      label: "Related"
    });
    expect(search.items.find((item) => item.path === "pages/intro.md")).toMatchObject({
      description: "Suggested description",
      keywords: ["intro", "suggested", "description", "agent"]
    });
  });

  it("keeps source descriptions over model suggestions", () => {
    const bundle = generateOkfBundle({
      generatedAt: "2026-06-14T00:00:00.000Z",
      defaults: {},
      sources: [
        {
          fileName: "parks.md",
          content: [
            "---",
            "type: page",
            "title: City Parks",
            "description: City Parks",
            "---",
            "# City Parks",
            "",
            "This document covers park planning, construction, public services, and management duties."
          ].join("\n"),
          suggestions: {
            title: "",
            type: "",
            description: "A grounded summary of park planning, construction, public services, and management duties.",
            related_links: [],
            tags: [],
            keywords: ["parks", "planning"]
          }
        }
      ]
    });
    const files = filesByPath(bundle.files);
    const page = matter(files["pages/parks.md"] ?? "");

    expect(page.data.description).toBe("City Parks");
  });

  it("keeps usable source descriptions over model suggestions", () => {
    const bundle = generateOkfBundle({
      generatedAt: "2026-06-14T00:00:00.000Z",
      defaults: {},
      sources: [
        {
          fileName: "manual.md",
          content: [
            "---",
            "type: page",
            "title: Operations Manual",
            "description: A reviewed operations manual for onboarding and support workflows.",
            "---",
            "# Operations Manual"
          ].join("\n"),
          suggestions: {
            title: "",
            type: "",
            description: "A model-generated replacement summary.",
            related_links: [],
            tags: [],
            keywords: ["operations"]
          }
        }
      ]
    });
    const files = filesByPath(bundle.files);
    const page = matter(files["pages/manual.md"] ?? "");

    expect(page.data.description).toBe(
      "A reviewed operations manual for onboarding and support workflows."
    );
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

  it("does not publish model relationship suggestions as generated relationships", () => {
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

    expect(page.content).not.toContain("## Related");
    expect(page.content).not.toContain("- [Related](/pages/related.md)");
    expect(page.content).not.toContain("Missing");
    expect(page.content).not.toContain("Raw source");
    expect(page.content).not.toContain("Object key");
    expect(links.links).not.toContainEqual({
      from: "pages/intro.md",
      to: "pages/related.md",
      label: "Related"
    });
    expect(links.links).not.toContainEqual(expect.objectContaining({ to: "pages/missing.md" }));
    expect(links.links).not.toContainEqual(expect.objectContaining({ to: "sources/raw.md" }));
  });

  it("generates file-first graph files and graph-backed related links", () => {
    const bundle = generateOkfBundle({
      generatedAt: "2026-06-14T00:00:00.000Z",
      defaults: {},
      sources: [
        {
          id: "source-intro",
          fileName: "intro.md",
          content: "---\ntype: guide\ntitle: Intro\ntags:\n  - setup\n---\n# Intro\n\nSee setup."
        },
        {
          id: "source-setup",
          fileName: "setup.md",
          content: "---\ntype: guide\ntitle: Setup\ntags:\n  - setup\n---\n# Setup"
        }
      ],
      graph: {
        nodes: [
          {
            fileId: "source-intro",
            path: "pages/intro.md",
            title: "Intro",
            type: "guide",
            tags: ["setup"],
            headings: ["Intro"],
            keywords: ["intro", "setup"],
            metadata: { type: "guide", title: "Intro", tags: ["setup"] }
          },
          {
            fileId: "source-setup",
            path: "pages/setup.md",
            title: "Setup",
            type: "guide",
            tags: ["setup"],
            headings: ["Setup"],
            keywords: ["setup"],
            metadata: { type: "guide", title: "Setup", tags: ["setup"] }
          }
        ],
        edges: [
          {
            fromFileId: "source-intro",
            toFileId: "source-setup",
            relationType: "shared_tag",
            weight: 0.8,
            reason: "Both files share the setup tag.",
            source: "deterministic",
            evidence: { tags: ["setup"] }
          }
        ],
        limits: {
          pageRelatedLimit: 10,
          perFileLimit: 50,
          edgeShardSize: 1000
        }
      }
    });
    const files = filesByPath(bundle.files);
    const intro = matter(files["pages/intro.md"] ?? "");
    const search = JSON.parse(files["_index/search.json"] ?? "{}") as {
      items: Array<{ path: string; fileId?: string; graphRef?: string }>;
    };
    const manifest = JSON.parse(files["_index/manifest.json"] ?? "{}") as {
      files: Array<{ path: string; content_type: string }>;
    };
    const links = JSON.parse(files["_index/links.json"] ?? "{}") as {
      links: Array<{ from: string; to: string; label: string; relation_type?: string }>;
    };
    const graphManifest = JSON.parse(files["_graph/manifest.json"] ?? "{}") as {
      node_count: number;
      edge_count: number;
      by_file_pattern: string;
    };
    const byFile = JSON.parse(files["_graph/by-file/source-intro.json"] ?? "{}") as {
      fileId: string;
      path: string;
      relationships: Array<{ fileId: string; direction: string; relationType: string }>;
    };

    expect(Object.keys(files).sort()).toEqual(
      expect.arrayContaining([
        "_graph/index.md",
        "_graph/manifest.json",
        "_graph/nodes.jsonl",
        "_graph/edges/0000.jsonl",
        "_graph/by-file/source-intro.json",
        "_graph/by-file/source-setup.json"
      ])
    );
    expect(intro.data).toMatchObject({
      fileId: "source-intro",
      graph: "../_graph/by-file/source-intro.json"
    });
    expect(intro.content).toContain("## Related");
    expect(intro.content).toContain("- [Setup](/pages/setup.md) - shared_tag");
    expect(search.items).toContainEqual(
      expect.objectContaining({
        path: "pages/intro.md",
        fileId: "source-intro",
        graphRef: "_graph/by-file/source-intro.json"
      })
    );
    expect(manifest.files).toContainEqual({
      path: "_graph/by-file/source-intro.json",
      content_type: "application/json; charset=utf-8"
    });
    expect(links.links).toContainEqual(
      expect.objectContaining({
        from: "pages/intro.md",
        to: "pages/setup.md",
        label: "Setup",
        relation_type: "shared_tag"
      })
    );
    expect(graphManifest).toMatchObject({
      node_count: 2,
      edge_count: 1,
      by_file_pattern: "_graph/by-file/{fileId}.json"
    });
    expect(files["_graph/nodes.jsonl"]).toContain("\"fileId\":\"source-intro\"");
    expect(files["_graph/edges/0000.jsonl"]).toContain("\"relationType\":\"shared_tag\"");
    expect(byFile).toMatchObject({
      fileId: "source-intro",
      path: "pages/intro.md",
      relationships: [
        {
          fileId: "source-setup",
          direction: "outgoing",
          relationType: "shared_tag"
        }
      ]
    });
  });

  it("filters weak shared-key graph edges from generated related files", () => {
    const bundle = generateOkfBundle({
      generatedAt: "2026-06-14T00:00:00.000Z",
      defaults: {},
      sources: [
        {
          id: "source-payment",
          fileName: "payment.md",
          content: "---\ntype: guide\ntitle: 支付配置指南\n---\n# 支付配置指南"
        },
        {
          id: "source-release-notes",
          fileName: "release-notes.md",
          content: "---\ntype: page\ntitle: 发布说明\n---\n# 发布说明"
        }
      ],
      graph: {
        nodes: [
          {
            fileId: "source-payment",
            path: "pages/payment.md",
            title: "支付配置指南",
            type: "guide",
            subjects: ["支付配置指南", "支付配置"],
            keywords: ["支付配置"],
            metadata: { type: "guide", title: "支付配置指南" }
          },
          {
            fileId: "source-release-notes",
            path: "pages/release-notes.md",
            title: "发布说明",
            type: "page",
            subjects: ["发布说明", "文档", "当前版本"],
            keywords: ["文档", "当前版本", "相关内容"],
            metadata: {
              type: "page",
              title: "发布说明"
            }
          }
        ],
        edges: [
          {
            fromFileId: "source-payment",
            toFileId: "source-release-notes",
            relationType: "shared_key_phrase",
            weight: 0.69,
            reason: "Both files share body-derived key phrases.",
            source: "deterministic",
            evidence: {
              matchedTerms: ["文档", "相关内容"]
            }
          }
        ]
      }
    });
    const files = filesByPath(bundle.files);
    const payment = matter(files["pages/payment.md"] ?? "");
    const links = JSON.parse(files["_index/links.json"] ?? "{}") as {
      links: Array<{ from: string; to: string; label: string; relation_type?: string }>;
    };
    const graphManifest = JSON.parse(files["_graph/manifest.json"] ?? "{}") as {
      edge_count: number;
    };
    const byFile = JSON.parse(files["_graph/by-file/source-payment.json"] ?? "{}") as {
      relationships: unknown[];
    };

    expect(payment.content).not.toContain("## Related");
    expect(links.links).not.toContainEqual(
      expect.objectContaining({
        from: "pages/payment.md",
        to: "pages/release-notes.md"
      })
    );
    expect(graphManifest.edge_count).toBe(0);
    expect(files["_graph/edges/0000.jsonl"]).toBeUndefined();
    expect(byFile.relationships).toEqual([]);
  });

  it("replaces trailing source related sections with graph-backed related links", () => {
    const bundle = generateOkfBundle({
      generatedAt: "2026-06-14T00:00:00.000Z",
      defaults: {},
      sources: [
        {
          id: "source-intro",
          fileName: "intro.md",
          content: [
            "---",
            "type: guide",
            "title: Intro",
            "resource: https://example.com/source",
            "---",
            "# Intro",
            "",
            "Body.",
            "",
            "## Related",
            "",
            "- [Stale](stale.md)",
            "",
            "# Citations",
            "",
            "- Existing citation"
          ].join("\n")
        },
        {
          id: "source-setup",
          fileName: "setup.md",
          content: "---\ntype: guide\ntitle: Setup\n---\n# Setup"
        }
      ],
      graph: {
        nodes: [
          {
            fileId: "source-intro",
            path: "pages/intro.md",
            title: "Intro",
            type: "guide",
            tags: [],
            headings: ["Intro"],
            keywords: ["intro"],
            metadata: { type: "guide", title: "Intro" }
          },
          {
            fileId: "source-setup",
            path: "pages/setup.md",
            title: "Setup",
            type: "guide",
            tags: [],
            headings: ["Setup"],
            keywords: ["setup"],
            metadata: { type: "guide", title: "Setup" }
          }
        ],
        edges: [
          {
            fromFileId: "source-intro",
            toFileId: "source-setup",
            relationType: "title_mention",
            weight: 0.9,
            reason: "The source mentions setup.",
            source: "deterministic",
            evidence: {}
          }
        ]
      }
    });
    const page = matter(filesByPath(bundle.files)["pages/intro.md"] ?? "");

    expect(page.content.match(/^## Related$/gm)).toHaveLength(1);
    expect(page.content).toContain("- [Setup](/pages/setup.md) - title_mention");
    expect(page.content).not.toContain("Stale");
    expect(page.content.match(/^# Citations$/gm)).toHaveLength(1);
    expect(page.content).toContain("- Existing citation");
  });

  it("generates a rolling bounded public update log", () => {
    const bundle = generateOkfBundle({
      generatedAt: "2026-06-14T00:00:00.000Z",
      defaults: {},
      log: {
        entries: [
          {
            occurredAt: "2026-05-01T00:00:00.000Z",
            action: "Update",
            message: "Older retained update.",
            changedFileCount: 3
          },
          {
            occurredAt: "2026-04-01T00:00:00.000Z",
            action: "Update",
            message: "Older summarized update.",
            changedFileCount: 2
          }
        ],
        summaries: [
          {
            month: "2026-03",
            publicationCount: 4,
            changedFileCount: 40
          }
        ],
        limits: {
          maxEntries: 2,
          maxBytes: 65_536
        }
      },
      sources: [
        {
          fileName: "intro.md",
          content: "---\ntype: page\ntitle: Intro\n---\n# Intro"
        }
      ]
    });
    const log = filesByPath(bundle.files)["log.md"] ?? "";

    expect(log).toContain("## 2026-06-14");
    expect(log).toContain("Published 1 Markdown pages");
    expect(log).toContain("Added Intro.");
    expect(log).not.toContain("Older retained update.");
    expect(log).not.toContain("Older summarized update.");
    expect(log).toContain("## Older Updates");
    expect(log).toContain("2026-05: 1 publication events, 3 documents changed.");
    expect(log).toContain("2026-04: 1 publication events, 2 documents changed.");
    expect(log).toContain("2026-03: 4 publication events, 40 documents changed.");
  });

  it("keeps newest persisted log entries when there is no recent calendar activity", () => {
    const bundle = generateOkfBundle({
      generatedAt: "2026-06-14T00:00:00.000Z",
      defaults: {},
      log: {
        entries: [
          {
            occurredAt: "2026-01-10T00:00:00.000Z",
            action: "Update",
            message: "Last quiet-period update.",
            changedFileCount: 1
          }
        ],
        limits: {
          maxEntries: 10,
          maxBytes: 65_536
        }
      },
      sources: []
    });
    const log = filesByPath(bundle.files)["log.md"] ?? "";

    expect(log).toContain("## 2026-06-14");
    expect(log).toContain("Published 0 Markdown pages");
    expect(log).toContain("## 2026-01-10");
    expect(log).toContain("Last quiet-period update.");
  });

  it("redacts unsafe public update log text", () => {
    const bundle = generateOkfBundle({
      generatedAt: "2026-06-14T00:00:00.000Z",
      defaults: {},
      log: {
        entries: [
          {
            occurredAt: "2026-06-13T00:00:00.000Z",
            action: "Update",
            message: "Stored release-001 at /private/tmp/source.md with S3_PREFIX and object key.",
            changedFileCount: 1
          }
        ]
      },
      sources: []
    });
    const log = filesByPath(bundle.files)["log.md"] ?? "";

    expect(log).not.toContain("release-001");
    expect(log).not.toContain("/private/tmp/source.md");
    expect(log).not.toContain("S3_PREFIX");
    expect(log).not.toContain("object key");
    expect(log).toContain("[redacted]");
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
