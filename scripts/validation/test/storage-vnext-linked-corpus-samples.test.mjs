import assert from "node:assert/strict";
import test from "node:test";
import {
  selectClosedMarkdownSample
} from "../lib/storage-vnext-linked-corpus-samples.mjs";

test("selects an exact deterministic sample whose local Markdown links are closed", () => {
  const bodies = new Map([
    ["/corpus/group/a.md", "[B](b.md)"],
    ["/corpus/group/b.md", "[A](a.md)"],
    ["/corpus/group/c.md", "[D](d.md)"],
    ["/corpus/group/d.md", "[C](c.md)"],
    ["/corpus/group/e.md", "[A](a.md)\n[B](b.md)\n[C](c.md)\n[D](d.md)"]
  ]);

  const selected = selectClosedMarkdownSample({
    filePaths: [...bodies.keys()],
    limit: 4,
    readText(filePath) {
      return bodies.get(filePath) ?? "";
    }
  });

  assert.deepEqual(selected, [
    "/corpus/group/a.md",
    "/corpus/group/b.md",
    "/corpus/group/c.md",
    "/corpus/group/d.md"
  ]);
});

test("rejects a requested sample size that cannot preserve link closure", () => {
  assert.throws(() => selectClosedMarkdownSample({
    filePaths: ["/corpus/a.md", "/corpus/b.md"],
    limit: 1,
    readText(filePath) {
      return filePath.endsWith("a.md") ? "[B](b.md)" : "[A](a.md)";
    }
  }), /closed Markdown sample/u);
});
