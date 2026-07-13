import assert from "node:assert/strict";
import test from "node:test";
import { findInCursorPages } from "../lib/cursor-search.mjs";

test("follows opaque cursors until a matching item is found", async () => {
  const cursors = [];
  const pages = new Map([
    [null, { items: [{ path: "pages/group-01" }], nextCursor: "cursor-1" }],
    ["cursor-1", { items: [{ path: "pages" }], nextCursor: "cursor-2" }]
  ]);

  const match = await findInCursorPages({
    loadPage: async (cursor) => {
      cursors.push(cursor);
      return pages.get(cursor);
    },
    matches: (item) => item.path === "pages",
    maxPages: 5
  });

  assert.deepEqual(match, { path: "pages" });
  assert.deepEqual(cursors, [null, "cursor-1"]);
});

test("stops when pagination ends without a match", async () => {
  const match = await findInCursorPages({
    loadPage: async () => ({ items: [{ path: "other" }], nextCursor: null }),
    matches: (item) => item.path === "pages",
    maxPages: 5
  });

  assert.equal(match, null);
});
