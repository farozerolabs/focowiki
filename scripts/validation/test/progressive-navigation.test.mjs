import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPagesReachableFromRootIndex,
  hydrateReachableMarkdownBodies
} from "../lib/progressive-navigation.mjs";

test("follows nested and numbered directory indexes to source-backed pages", () => {
  const bodies = new Map([
    ["index.md", "# Root\n\n- [Browse](pages/index.md)"],
    ["pages/index.md", "# Pages\n\n- [Guides](guides/index.md)"],
    ["pages/guides/index.md", "# Guides\n\n- [Part 1](index-000001.md)"],
    ["pages/guides/index-000001.md", "# Part 1\n\n- [Intro](intro%20guide.md)"],
    ["pages/guides/intro guide.md", "---\ntype: page\ntitle: Intro\n---\n# Intro"]
  ]);

  const reachable = assertPagesReachableFromRootIndex({
    bodies,
    pagePaths: ["pages/guides/intro guide.md"]
  });

  assert.equal(reachable.has("pages/guides/index-000001.md"), true);
  assert.equal(reachable.has("pages/guides/intro guide.md"), true);
});

test("rejects a source-backed page that is absent from progressive navigation", () => {
  const bodies = new Map([
    ["index.md", "# Root\n\n- [Browse](pages/index.md)"],
    ["pages/index.md", "# Pages"],
    ["pages/orphan.md", "---\ntype: page\ntitle: Orphan\n---\n# Orphan"]
  ]);

  assert.throws(
    () => assertPagesReachableFromRootIndex({ bodies, pagePaths: ["pages/orphan.md"] }),
    /cannot reach source-backed page/u
  );
});

test("hydrates URL-encoded navigation leaves that are not returned by the file tree", async () => {
  const bodies = new Map([
    ["index.md", "# Root\n\n- [Browse](/pages/index.md)"],
    ["pages/index.md", "# Pages\n\n- [Region](/pages/%E5%9C%B0%E5%8C%BA/index.md)"],
    [
      "pages/地区/index.md",
      "# Region\n\n- [Browse](/pages/%E5%9C%B0%E5%8C%BA/index-directory-leaf-1.md)"
    ],
    ["pages/地区/文档.md", "---\ntype: page\ntitle: Document\n---\n# Document"]
  ]);
  const remoteBodies = new Map([
    [
      "pages/地区/index-directory-leaf-1.md",
      "# Region entries\n\n- [Document](/pages/%E5%9C%B0%E5%8C%BA/%E6%96%87%E6%A1%A3.md)"
    ]
  ]);

  await hydrateReachableMarkdownBodies({
    bodies,
    startPath: "index.md",
    read: async (logicalPath) => remoteBodies.get(logicalPath) ?? null
  });

  assert.equal(bodies.has("pages/地区/index-directory-leaf-1.md"), true);
  assert.doesNotThrow(() => assertPagesReachableFromRootIndex({
    bodies,
    pagePaths: ["pages/地区/文档.md"]
  }));
});
