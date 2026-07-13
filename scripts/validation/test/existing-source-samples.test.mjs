import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { matchExistingSourceSamples } from "../lib/existing-source-samples.mjs";

test("matches existing nested source paths to unique local Markdown basenames", () => {
  const root = mkdtempSync(join(tmpdir(), "focowiki-existing-samples-"));
  try {
    mkdirSync(join(root, "raw"), { recursive: true });
    writeFileSync(join(root, "raw", "alpha.md"), "# Alpha\n", "utf8");
    writeFileSync(join(root, "raw", "beta.md"), "# Beta\n", "utf8");

    const samples = matchExistingSourceSamples({
      sourceDirectory: root,
      expectedCount: 2,
      existingFiles: [
        { id: "source-a", name: "alpha.md", relativePath: "group/alpha.md" },
        { id: "source-b", name: "beta.md", relativePath: "group/nested/beta.md" }
      ]
    });

    assert.deepEqual(
      samples.map(({ basename, relativePath }) => ({ basename, relativePath })),
      [
        { basename: "alpha.md", relativePath: "group/alpha.md" },
        { basename: "beta.md", relativePath: "group/nested/beta.md" }
      ]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects ambiguous local basenames", () => {
  const root = mkdtempSync(join(tmpdir(), "focowiki-existing-samples-"));
  try {
    mkdirSync(join(root, "one"), { recursive: true });
    mkdirSync(join(root, "two"), { recursive: true });
    writeFileSync(join(root, "one", "same.md"), "# One\n", "utf8");
    writeFileSync(join(root, "two", "same.md"), "# Two\n", "utf8");

    assert.throws(
      () =>
        matchExistingSourceSamples({
          sourceDirectory: root,
          expectedCount: 1,
          existingFiles: [
            { id: "source-a", name: "same.md", relativePath: "group/same.md" }
          ]
        }),
      /exactly one local Markdown file/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
