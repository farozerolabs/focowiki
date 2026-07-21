import assert from "node:assert/strict";
import test from "node:test";
import {
  findDeletedPageReferences,
  validateOkfPublicArtifactBodies
} from "../cleaned-markdown-flow.mjs";

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
    ["log.md", "# Directory Update Log\n\n## Active generation\n\n- Published one page."],
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
  const links = { links: [{ path: "pages/example.md", references: [] }] };
  const report = { checks: [], contentQuality: [], modelAssistance: null };

  assert.doesNotThrow(() => validateOkfPublicArtifactBodies({
    bodies,
    pagePaths: ["pages/example.md"],
    report,
    indexes: { manifest, search, links }
  }));
});

test("deletion evidence ignores historical segment payloads and checks effective records", () => {
  const deletedPagePath = "pages/deleted.md";
  const publicBodies = new Map([
    ["index.md", "# Knowledge base"],
    ["log.md", "# Updates"],
    ["_index/catalog.json", "{}"],
    ["_segments/search/search/v1/0001/base-1.json", JSON.stringify({ path: deletedPagePath })]
  ]);

  assert.deepEqual(findDeletedPageReferences({
    deletedPagePath,
    publicBodies,
    manifest: { files: [] },
    search: { items: [] },
    links: { links: [] }
  }), []);

  publicBodies.set("index.md", `[Deleted](${deletedPagePath})`);
  assert.deepEqual(findDeletedPageReferences({
    deletedPagePath,
    publicBodies,
    manifest: { files: [] },
    search: { items: [] },
    links: { links: [] }
  }), ["index.md"]);
});
