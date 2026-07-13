import assert from "node:assert/strict";
import test from "node:test";
import { validateOkfPublicArtifactBodies } from "../cleaned-markdown-flow.mjs";

test("accepts the OKF version declaration on the bundle-root index", () => {
  const bodies = new Map([
    [
      "index.md",
      [
        "---",
        'okf_version: "0.1"',
        "---",
        "# Example knowledge base",
        "",
        "- [Browse documents](pages/index.md)"
      ].join("\n")
    ],
    ["log.md", "# Directory Update Log\n\n## 2026-07-13\n\n* **Publication**: Published one page."],
    [
      "schema.md",
      "---\ntype: schema\ntitle: Metadata schema\n---\n# Metadata schema"
    ],
    ["pages/index.md", "# Documents\n\n- [Example](example.md)"],
    [
      "pages/example.md",
      "---\ntype: document\ntitle: Example\n---\n# Example\n\nSource-backed content."
    ]
  ]);
  const manifest = {
    files: [
      { path: "index.md" },
      { path: "log.md" },
      { path: "schema.md" },
      { path: "pages/index.md" },
      {
        path: "pages/example.md",
        metadata: { type: "document", title: "Example" }
      }
    ]
  };
  const search = {
    items: [
      {
        path: "pages/example.md",
        type: "document",
        title: "Example",
        metadata: { type: "document", title: "Example" }
      }
    ]
  };
  const links = {
    links: [{ from: "pages/index.md", to: "pages/example.md", label: "Example" }]
  };
  const report = { checks: [], contentQuality: [], modelAssistance: null };

  assert.doesNotThrow(() => validateOkfPublicArtifactBodies({
    bodies,
    pagePaths: ["pages/example.md"],
    report,
    indexes: { manifest, search, links }
  }));
});
