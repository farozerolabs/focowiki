import assert from "node:assert/strict";
import test from "node:test";

import { assertPagesReachableFromRootIndex } from "../lib/progressive-navigation.mjs";

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
